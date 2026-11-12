/**
 * Hold-to-move jog for one camera, with a deadman.
 *
 * The browser re-sends the current jog state every ~250 ms while a button is
 * held. If nothing arrives for deadmanMs (button released without a stop,
 * phone locked, Wi-Fi dropped) the camera is stopped, so it can never keep
 * panning on its own.
 */
import { PTZ_SPEED, type JogDir, type PtzControl } from './types.js';

export interface JogState {
  pan: JogDir;
  tilt: JogDir;
  zoom: JogDir;
  /** 1 (slowest) - 100 (fastest) */
  speed: number;
}

/** Map a 1-100 UI speed onto VISCA pan (1-0x18), tilt (1-0x14) and zoom (0-7) speeds. */
export function jogSpeeds(pct: number): { pan: number; tilt: number; zoom: number } {
  const t = (Math.min(100, Math.max(1, pct)) - 1) / 99;
  return {
    pan: Math.round(1 + (PTZ_SPEED.panMax - 1) * t),
    tilt: Math.round(1 + (PTZ_SPEED.tiltMax - 1) * t),
    zoom: Math.round(PTZ_SPEED.zoomMax * t),
  };
}

export class Jogger {
  private cur: JogState | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly ptz: PtzControl,
    private opts: { deadmanMs?: number; onDeadman?: () => void } = {},
  ) {}

  get active(): boolean {
    return this.cur !== null;
  }

  /** Apply a jog state. Only changed axes are sent; a repeat just keeps the deadman alive. */
  async set(s: JogState): Promise<void> {
    if (s.pan === 0 && s.tilt === 0 && s.zoom === 0) return this.stop();
    const prev = this.cur;
    this.cur = s;
    this.arm();
    const sp = jogSpeeds(s.speed);
    const speedChanged = !prev || prev.speed !== s.speed;
    if (!prev || speedChanged || prev.pan !== s.pan || prev.tilt !== s.tilt) {
      if (s.pan !== 0 || s.tilt !== 0 || (prev && (prev.pan !== 0 || prev.tilt !== 0))) {
        await this.ptz.drive({ pan: s.pan, tilt: s.tilt }, { pan: sp.pan, tilt: sp.tilt });
      }
    }
    if (!prev || speedChanged || prev.zoom !== s.zoom) {
      if (s.zoom !== 0 || (prev && prev.zoom !== 0)) await this.ptz.zoomDrive(s.zoom, sp.zoom);
    }
  }

  /** Stop everything (always sent, even if we think the camera is idle). */
  async stop(): Promise<void> {
    this.cur = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.ptz.stop();
  }

  private arm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.opts.onDeadman?.();
      this.stop().catch(() => undefined);
    }, this.opts.deadmanMs ?? 800);
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.cur) this.stop().catch(() => undefined);
  }
}
