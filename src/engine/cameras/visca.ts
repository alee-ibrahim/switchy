/**
 * Generic VISCA-over-IP driver (UDP).
 *
 * framing 'sony' (default): Sony VISCA-over-IP header, UDP 52381
 *   [payload type:2][payload length:2][sequence:4][VISCA payload]
 *   0x0100 command, 0x0110 inquiry, 0x0111 reply, 0x0200 control, 0x0201 control reply
 * framing 'raw': bare VISCA bytes over UDP (e.g. some PTZOptics/Lumens units).
 *
 * Preset recall: 81 01 04 3F 02 pp FF. VISCA preset numbers are 0-based on
 * Sony (UI "Preset 1" = 0x00), so by default the configured preset number is
 * reduced by presetOffset=1. Set options.presetOffset = 0 for cameras whose
 * VISCA numbering matches the UI.
 *
 * Standard VISCA-over-IP has no authentication. If a camera requires
 * credentials for control (Sony CGI), a CGI driver will use resolveCredentials().
 */
import dgram from 'node:dgram';
import { PTZ_SPEED, type CameraDriver, type CameraProbeResult, type JogDir, type PtzControl, type PtzPosition } from './types.js';

export type ViscaFraming = 'sony' | 'raw';

export interface ViscaOptions {
  host: string;
  port?: number | null;
  framing?: ViscaFraming;
  presetOffset?: number;
  timeoutMs?: number;
  /** Poll pan/tilt position to detect when a move finished (opt-in). */
  pollPosition?: boolean;
  pollIntervalMs?: number;
  /** Pan position width in nibbles for absolute/relative moves (4 default; some Sony models use 5). */
  panNibbles?: number;
  /** For tests: inject a socket factory. */
  socketFactory?: () => dgram.Socket;
}

const T_COMMAND = 0x0100;
const T_INQUIRY = 0x0110;
const T_REPLY = 0x0111;
const T_CONTROL = 0x0200;
const T_CONTROL_REPLY = 0x0201;

export function viscaPresetRecall(preset: number): Buffer {
  if (!Number.isInteger(preset) || preset < 0 || preset > 0xff) throw new Error(`invalid VISCA preset ${preset}`);
  return Buffer.from([0x81, 0x01, 0x04, 0x3f, 0x02, preset, 0xff]);
}

/** Encode a signed value as `count` VISCA nibbles (0p 0q 0r 0s), two's complement. */
export function nibbles(value: number, count = 4): number[] {
  const bits = count * 4;
  const v = value < 0 ? (1 << bits) + value : value;
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i--) out.push((v >> (i * 4)) & 0x0f);
  return out;
}

/** Decode VISCA nibbles into a signed number. */
export function fromNibbles(n: number[]): number {
  const bits = n.length * 4;
  let v = 0;
  for (const x of n) v = (v << 4) | (x & 0x0f);
  return v >= 1 << (bits - 1) ? v - (1 << bits) : v;
}

export function viscaPresetSet(preset: number): Buffer {
  return Buffer.from([0x81, 0x01, 0x04, 0x3f, 0x01, preset, 0xff]);
}

/** 81 01 06 02|03 VV WW <pan nibbles> <tilt nibbles> FF (02 absolute, 03 relative) */
export function viscaPanTilt(mode: 'absolute' | 'relative', pan: number, tilt: number, vv = 0x10, ww = 0x10, panNibbles = 4): Buffer {
  return Buffer.from([0x81, 0x01, 0x06, mode === 'absolute' ? 0x02 : 0x03, vv, ww, ...nibbles(pan, panNibbles), ...nibbles(tilt, 4), 0xff]);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

/** 81 01 06 01 VV WW XX YY FF: XX 01 left / 02 right / 03 stop, YY 01 up / 02 down / 03 stop. */
export function viscaPanTiltDrive(pan: JogDir, tilt: JogDir, vv = 0x08, ww = 0x08): Buffer {
  const xx = pan < 0 ? 0x01 : pan > 0 ? 0x02 : 0x03;
  const yy = tilt > 0 ? 0x01 : tilt < 0 ? 0x02 : 0x03;
  return Buffer.from([0x81, 0x01, 0x06, 0x01, clamp(vv, 1, PTZ_SPEED.panMax), clamp(ww, 1, PTZ_SPEED.tiltMax), xx, yy, 0xff]);
}

/** 81 01 04 07 2p (tele, variable) / 3p (wide, variable) / 00 (stop) FF */
export function viscaZoomDrive(dir: JogDir, speed = 3): Buffer {
  const p = clamp(speed, 0, PTZ_SPEED.zoomMax);
  const b = dir > 0 ? 0x20 | p : dir < 0 ? 0x30 | p : 0x00;
  return Buffer.from([0x81, 0x01, 0x04, 0x07, b, 0xff]);
}

export function viscaZoomDirect(zoom: number): Buffer {
  return Buffer.from([0x81, 0x01, 0x04, 0x47, ...nibbles(zoom, 4), 0xff]);
}

export const VISCA_ZOOM_POS_INQ = Buffer.from([0x81, 0x09, 0x04, 0x47, 0xff]);

export const VISCA_PANTILT_POS_INQ = Buffer.from([0x81, 0x09, 0x06, 0x12, 0xff]);

export function sonyFrame(type: number, seq: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(payload.length, 2);
  h.writeUInt32BE(seq >>> 0, 4);
  return Buffer.concat([h, payload]);
}

export function parseSonyFrame(buf: Buffer): { type: number; seq: number; payload: Buffer } | null {
  if (buf.length < 8) return null;
  const len = buf.readUInt16BE(2);
  return { type: buf.readUInt16BE(0), seq: buf.readUInt32BE(4), payload: buf.subarray(8, 8 + len) };
}

const VISCA_ERRORS: Record<number, string> = {
  0x01: 'message length error',
  0x02: 'syntax error',
  0x03: 'command buffer full',
  0x04: 'command canceled',
  0x05: 'no socket',
  0x41: 'command not executable',
};

type Pending = {
  kind: 'command' | 'inquiry' | 'control';
  seq: number;
  resolve: (b: Buffer) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export class ViscaDriver implements CameraDriver {
  readonly kind = 'visca';
  private sock: dgram.Socket | null = null;
  private seq = 0;
  private needReset: boolean;
  private pending: Pending | null = null;
  /** raw framing: completions still expected for commands resolved on ACK */
  private lateCompletions = 0;
  private queue: Promise<unknown> = Promise.resolve();
  readonly o: Required<Omit<ViscaOptions, 'socketFactory' | 'port'>> & { port: number; socketFactory?: () => dgram.Socket };

  constructor(o: ViscaOptions) {
    const framing = o.framing ?? 'sony';
    this.o = {
      host: o.host,
      port: o.port ?? (framing === 'sony' ? 52381 : 1259),
      framing,
      presetOffset: o.presetOffset ?? 1,
      timeoutMs: o.timeoutMs ?? 1000,
      pollPosition: o.pollPosition ?? false,
      pollIntervalMs: o.pollIntervalMs ?? 150,
      panNibbles: o.panNibbles ?? 4,
      socketFactory: o.socketFactory,
    };
    this.needReset = framing === 'sony';
  }

  private socket(): dgram.Socket {
    if (this.sock) return this.sock;
    const s = this.o.socketFactory ? this.o.socketFactory() : dgram.createSocket('udp4');
    s.on('message', (msg) => this.onMessage(msg));
    s.on('error', () => {
      /* surfaced through timeouts */
    });
    this.sock = s;
    return s;
  }

  private onMessage(msg: Buffer) {
    const p = this.pending;
    if (!p) return;
    let payload: Buffer;
    if (this.o.framing === 'sony') {
      const f = parseSonyFrame(msg);
      if (!f) return;
      // ignore late replies (e.g. the completion of a previous command)
      if (f.type === T_REPLY && f.seq !== p.seq) return;
      if (f.type === T_CONTROL_REPLY) {
        if (p.kind === 'control') return this.settle(null, f.payload);
        if (f.payload[0] === 0x0f) return this.settle(new Error('VISCA-over-IP sequence/message error'));
        return;
      }
      if (f.type !== T_REPLY) return;
      payload = f.payload;
    } else {
      payload = msg;
    }
    if (payload.length < 3) return;
    const kindNibble = payload[1]! & 0xf0;
    if (kindNibble === 0x60) {
      const code = payload[2]!;
      return this.settle(new Error(`VISCA error 0x${code.toString(16)} (${VISCA_ERRORS[code] ?? 'unknown'})`));
    }
    if (this.o.framing === 'raw' && kindNibble === 0x50 && p.kind === 'command' && this.lateCompletions > 0) {
      this.lateCompletions--;
      return;
    }
    if (p.kind === 'command' && kindNibble === 0x40) {
      if (this.o.framing === 'raw') this.lateCompletions = 1;
      return this.settle(null, payload);
    }
    if (p.kind === 'command' && kindNibble === 0x50) return this.settle(null, payload);
    if (p.kind === 'inquiry' && kindNibble === 0x50) return this.settle(null, payload);
  }

  private settle(err: Error | null, payload?: Buffer) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(payload!);
  }

  private sendRaw(kind: Pending['kind'], type: number, payload: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(new Error(`VISCA timeout (${this.o.host}:${this.o.port})`)), this.o.timeoutMs);
      const seq = kind === 'control' ? 0 : this.seq++;
      this.pending = { kind, seq, resolve, reject, timer };
      const data = this.o.framing === 'sony' ? sonyFrame(type, seq, payload) : payload;
      if (kind === 'control') this.seq = 0; // RESET: camera expects sequence 0 next
      this.socket().send(data, this.o.port, this.o.host, (e) => {
        if (e) this.settle(e);
      });
    });
  }

  /** Serialise: one VISCA message in flight at a time. */
  private exec(kind: 'command' | 'inquiry', payload: Buffer): Promise<Buffer> {
    const run = async () => {
      if (this.needReset) {
        await this.sendRaw('control', T_CONTROL, Buffer.from([0x01])).catch(() => undefined);
        this.needReset = false;
      }
      try {
        return await this.sendRaw(kind, kind === 'command' ? T_COMMAND : T_INQUIRY, payload);
      } catch (e) {
        // one retry after a sequence reset
        if (this.o.framing === 'sony') {
          await this.sendRaw('control', T_CONTROL, Buffer.from([0x01])).catch(() => undefined);
          return await this.sendRaw(kind, kind === 'command' ? T_COMMAND : T_INQUIRY, payload);
        }
        throw e;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async recallPreset(preset: string): Promise<void> {
    const n = parseInt(preset, 10);
    if (!Number.isFinite(n)) throw new Error(`VISCA preset must be a number, got "${preset}"`);
    await this.exec('command', viscaPresetRecall(n - this.o.presetOffset));
  }

  /** Fine PTZ control over VISCA. Pan uses options.panNibbles (4, or 5 on some Sony models). */
  readonly ptz: PtzControl = {
    getPosition: async (): Promise<PtzPosition> => {
      const pt = await this.exec('inquiry', VISCA_PANTILT_POS_INQ);
      const body = [...pt.subarray(2, pt.length - 1)];
      const tiltN = 4;
      const panN = body.length - tiltN;
      const z = await this.exec('inquiry', VISCA_ZOOM_POS_INQ);
      // a stray/late reply (seen on the P100 around move completions) must not pass as a position
      if ((panN !== 4 && panN !== 5) || z.length !== 7) {
        throw new Error(`VISCA position: unexpected reply (${pt.toString('hex')} / ${z.toString('hex')})`);
      }
      return {
        pan: fromNibbles(body.slice(0, panN)),
        tilt: fromNibbles(body.slice(panN)),
        zoom: fromNibbles([...z.subarray(2, z.length - 1)]),
      };
    },
    moveAbsolute: async (p, speed) => {
      await this.exec('command', viscaPanTilt('absolute', p.pan, p.tilt, speed?.pan, speed?.tilt, this.panNibbles));
    },
    moveRelative: async (d, speed) => {
      await this.exec('command', viscaPanTilt('relative', d.pan, d.tilt, speed?.pan, speed?.tilt, this.panNibbles));
    },
    zoomTo: async (zoom) => {
      await this.exec('command', viscaZoomDirect(zoom));
    },
    savePreset: (preset) => this.savePreset(preset),
    drive: async (dir, speed) => {
      await this.exec('command', viscaPanTiltDrive(dir.pan, dir.tilt, speed?.pan, speed?.tilt));
    },
    zoomDrive: async (dir, speed) => {
      await this.exec('command', viscaZoomDrive(dir, speed));
    },
    stop: async () => {
      // both stops are always sent (a failed pan/tilt stop must not skip the zoom stop), each retried once more
      const send = (b: Buffer) => this.exec('command', b).catch(() => this.exec('command', b));
      const r = await Promise.allSettled([send(viscaPanTiltDrive(0, 0)), send(viscaZoomDrive(0))]);
      const bad = r.find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined;
      if (bad) throw bad.reason;
    },
  };

  /** VISCA memory set (81 01 04 3F 01 pp FF), same numbering/offset as recallPreset. */
  async savePreset(preset: string): Promise<void> {
    const n = parseInt(preset, 10);
    if (!Number.isFinite(n)) throw new Error(`VISCA preset must be a number, got "${preset}"`);
    await this.exec('command', viscaPresetSet(n - this.o.presetOffset));
  }

  private get panNibbles(): number {
    return this.o.panNibbles;
  }

  async position(): Promise<string> {
    const r = await this.exec('inquiry', VISCA_PANTILT_POS_INQ);
    return r.subarray(2, r.length - 1).toString('hex');
  }

  get waitSettled(): CameraDriver['waitSettled'] {
    if (!this.o.pollPosition) return undefined;
    return async (signal: AbortSignal, maxMs: number) => {
      const deadline = Date.now() + maxMs;
      let last: string | null = null;
      let stable = 0;
      const sleep = (ms: number) =>
        new Promise<void>((res, rej) => {
          const t = setTimeout(res, ms);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            rej(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      await sleep(this.o.pollIntervalMs * 2);
      while (Date.now() < deadline) {
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        try {
          const pos = await this.position();
          stable = pos === last ? stable + 1 : 0;
          last = pos;
          if (stable >= 2) return;
        } catch {
          /* fall back to time-based */
        }
        await sleep(this.o.pollIntervalMs);
      }
    };
  }

  async probe(): Promise<CameraProbeResult> {
    try {
      const pos = await this.position();
      return { ok: true, detail: { panTilt: pos } };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  close(): void {
    this.sock?.close();
    this.sock = null;
  }
}
