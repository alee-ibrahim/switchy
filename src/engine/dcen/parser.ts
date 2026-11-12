/**
 * Parser for the Brähler DCen central unit ASCII control port (TCP 3225).
 *
 * Observed protocol (read-only use):
 *   - lines end with CRLF; the last line of the connect dump ("READY;") may
 *     arrive without a terminator, so callers flush after ~300 ms of quiet
 *   - fields are ';'-separated, unit ids are 4-digit HEX, FFFF = all units
 *   - empty lines are keep-alives
 */

export type DcenEvent =
  | { type: 'mic-on'; unit: number; raw: string }
  | { type: 'mic-off'; unit: number | 'all'; raw: string }
  | { type: 'keys'; unit: number | 'all'; keys: string; raw: string }
  | { type: 'ready'; raw: string }
  | { type: 'setting'; key: string; values: string[]; raw: string }
  | { type: 'keepalive'; raw: string }
  | { type: 'unknown'; raw: string };

/** Commands that carry device state/settings rather than mic events. */
const SETTING_KEYS = new Set([
  'MICMODE',
  'MAXDEL',
  'MAXVIP',
  'VOLUME',
  'PRIOMODE',
  'MUTEMODE',
  'PRIOSTATE',
  'MUTESTATE',
  'LANG',
]);

/** Parse a DCen unit id (hex, e.g. "001A" = 26). "FFFF" = all. Returns null if invalid. */
export function parseUnit(s: string | undefined): number | 'all' | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (!/^[0-9A-Fa-f]{1,4}$/.test(t)) return null;
  if (t.toUpperCase() === 'FFFF') return 'all';
  return parseInt(t, 16);
}

/** Format a unit number the way the DCen shows it (e.g. 26 -> "001A"). */
export function formatUnit(unit: number): string {
  return unit.toString(16).toUpperCase().padStart(4, '0');
}

export function parseLine(line: string): DcenEvent {
  const raw = line;
  const t = line.trim();
  if (t === '') return { type: 'keepalive', raw };
  const f = t.split(';');
  const cmd = (f[0] ?? '').toUpperCase();
  switch (cmd) {
    case 'MIC-ON': {
      const u = parseUnit(f[1]);
      if (typeof u !== 'number') return { type: 'unknown', raw };
      return { type: 'mic-on', unit: u, raw };
    }
    case 'MIC-OFF': {
      const u = parseUnit(f[1]);
      if (u === null) return { type: 'unknown', raw };
      return { type: 'mic-off', unit: u, raw };
    }
    case 'KEYS': {
      const u = parseUnit(f[1]);
      if (u === null) return { type: 'unknown', raw };
      return { type: 'keys', unit: u, keys: f[3] ?? '', raw };
    }
    case 'READY':
      return { type: 'ready', raw };
    default:
      if (SETTING_KEYS.has(cmd)) {
        const values = f.slice(1);
        while (values.length && values[values.length - 1] === '') values.pop();
        return { type: 'setting', key: cmd, values, raw };
      }
      return { type: 'unknown', raw };
  }
}

/**
 * Splits a byte stream into lines. CR, LF and CRLF all terminate a line;
 * a CRLF pair yields exactly one line. A bare CRLF yields an empty line
 * (keep-alive). Text without a terminator stays pending until flush().
 */
export class LineSplitter {
  private pending = '';
  private lastWasCR = false;

  push(chunk: string): string[] {
    const out: string[] = [];
    for (const ch of chunk) {
      if (ch === '\n') {
        if (this.lastWasCR) {
          this.lastWasCR = false;
          continue;
        }
        out.push(this.pending);
        this.pending = '';
      } else if (ch === '\r') {
        out.push(this.pending);
        this.pending = '';
        this.lastWasCR = true;
        continue;
      } else {
        this.pending += ch;
      }
      this.lastWasCR = false;
    }
    return out;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Return and clear an unterminated trailing fragment (e.g. "READY;"). */
  flush(): string | null {
    if (!this.pending) return null;
    const p = this.pending;
    this.pending = '';
    return p;
  }

  reset(): void {
    this.pending = '';
    this.lastWasCR = false;
  }
}
