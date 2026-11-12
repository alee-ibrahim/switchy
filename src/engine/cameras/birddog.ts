/**
 * BirdDog REST API driver (X1 / X1 Ultra / P100 / P200 ...). REST on :8080.
 *   GET  /about
 *   POST /recall {"Preset":"Preset-1"}
 *   POST /save   {"Preset":"Preset-1"}  -> {"Save-Preset":"1"}  (verified on the P100, presets above 9 too)
 *
 * Fine PTZ (jog, zoom, position) goes over VISCA-over-IP on UDP 52381 (verified on
 * the P100). Presets are always saved via REST so the numbering matches /recall.
 */
import type { CameraDriver, CameraProbeResult, Credentials, PtzControl } from './types.js';
import { ViscaDriver } from './visca.js';

export interface BirdDogOptions {
  host: string;
  port?: number | null;
  timeoutMs?: number;
  credentials?: Credentials | null;
  fetchImpl?: typeof fetch;
  /**
   * Fine PTZ control over VISCA-over-IP (BirdDog X1/P-series listen on UDP 52381).
   * On by default; disable with camera option { "viscaPtz": false }.
   */
  viscaPtz?: boolean;
  viscaPort?: number;
}

/** "1" -> "Preset-1"; anything non-numeric is passed through unchanged. */
export function birddogPresetName(preset: string): string {
  const t = preset.trim();
  return /^\d+$/.test(t) ? `Preset-${parseInt(t, 10)}` : t;
}

export class BirdDogDriver implements CameraDriver {
  readonly kind = 'birddog';
  private base: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;
  private auth: string | null;
  private visca: ViscaDriver | null;
  readonly ptz?: PtzControl;

  constructor(o: BirdDogOptions) {
    this.base = `http://${o.host}:${o.port ?? 8080}`;
    this.timeoutMs = o.timeoutMs ?? 2500;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.auth = o.credentials
      ? 'Basic ' + Buffer.from(`${o.credentials.username}:${o.credentials.password}`).toString('base64')
      : null;
    this.visca = o.viscaPtz !== false ? new ViscaDriver({ host: o.host, port: o.viscaPort ?? 52381 }) : null;
    // VISCA for movement; REST for presets (BirdDog's VISCA preset numbering is unverified).
    if (this.visca) this.ptz = { ...this.visca.ptz, savePreset: (p) => this.savePreset(p) };
  }

  close(): void {
    this.visca?.close();
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['content-type'] = 'application/json';
    if (this.auth) h['authorization'] = this.auth;
    return h;
  }

  private async presetCall(path: '/recall' | '/save', preset: string): Promise<string> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ Preset: birddogPresetName(preset) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`BirdDog ${path} HTTP ${res.status}`);
    return res.text().catch(() => '');
  }

  async recallPreset(preset: string): Promise<void> {
    await this.presetCall('/recall', preset);
  }

  /** Store the current position: POST /save {"Preset":"Preset-N"} -> {"Save-Preset":"N"}. */
  async savePreset(preset: string): Promise<void> {
    const text = await this.presetCall('/save', preset);
    let saved: unknown;
    try {
      saved = (JSON.parse(text) as Record<string, unknown>)['Save-Preset'];
    } catch {
      /* empty or non-JSON body: HTTP 200 is all we get */
    }
    const want = birddogPresetName(preset).replace(/^Preset-/, '');
    if (saved !== undefined && String(saved) !== want) {
      throw new Error(`BirdDog /save answered Save-Preset ${String(saved)}, expected ${want}`);
    }
  }

  async probe(): Promise<CameraProbeResult> {
    try {
      const res = await this.fetchImpl(`${this.base}/about`, {
        headers: this.headers(false),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const j = (await res.json()) as Record<string, unknown>;
      const pick = (...keys: string[]) => {
        for (const k of keys) if (typeof j[k] === 'string' && j[k]) return j[k] as string;
        return undefined;
      };
      return {
        ok: true,
        model: pick('HardwareVersion', 'DeviceModel', 'Model', 'HostName'),
        firmware: pick('FirmwareVersion', 'Firmware'),
        detail: j,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
