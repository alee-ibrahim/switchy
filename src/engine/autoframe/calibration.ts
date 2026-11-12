/**
 * PTZ calibration: how far the picture moves per VISCA pan/tilt unit, as a
 * function of zoom. Person-free: at each zoom, move by a known delta, grab a
 * frame before and after, and measure the scene shift by phase correlation.
 *
 * Stored per camera in camera.options.autoframe.calibration. Values are
 * fractions of the frame (width for pan, height for tilt) so they do not
 * depend on the grab resolution, and they are signed: dxPerPan is how far
 * scene content moves (in frame widths) when pan increases by one unit.
 */
import { z } from 'zod';
import type { PtzControl } from '../cameras/types.js';
import type { RgbaImage } from '../image/jpeg.js';
import { phaseCorrelate, waitVideoStill } from './phase.js';

export const calibPointSchema = z.object({
  zoom: z.number(),
  dxPerPan: z.number(),
  dyPerTilt: z.number(),
});
export type CalibPoint = z.infer<typeof calibPointSchema>;

export const calibrationSchema = z.object({
  points: z.array(calibPointSchema).min(1),
  measuredAt: z.string().optional(),
  frameWidth: z.number().optional(),
  frameHeight: z.number().optional(),
});
export type Calibration = z.infer<typeof calibrationSchema>;

/** Calibration from camera options (options.autoframe.calibration), or null. */
export function calibrationFromOptions(options: Record<string, unknown> | undefined): Calibration | null {
  const af = options?.autoframe as Record<string, unknown> | undefined;
  const r = calibrationSchema.safeParse(af?.calibration);
  return r.success ? { ...r.data, points: [...r.data.points].sort((a, b) => a.zoom - b.zoom) } : null;
}

/** Interpolate one signed coefficient over zoom: linear in log(|value|), clamped at the ends. */
function interp(points: CalibPoint[], zoom: number, key: 'dxPerPan' | 'dyPerTilt'): number {
  const p = [...points].sort((a, b) => a.zoom - b.zoom);
  if (zoom <= p[0]!.zoom) return p[0]![key];
  const last = p[p.length - 1]!;
  if (zoom >= last.zoom) return last[key];
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1]!;
    const b = p[i]!;
    if (zoom <= b.zoom) {
      const t = (zoom - a.zoom) / (b.zoom - a.zoom || 1);
      const mag = Math.exp(Math.log(Math.abs(a[key])) * (1 - t) + Math.log(Math.abs(b[key])) * t);
      return Math.sign(t < 0.5 ? a[key] : b[key]) * mag;
    }
  }
  return last[key];
}

export function coefficientsAt(cal: Calibration, zoom: number): { dxPerPan: number; dyPerTilt: number } {
  return { dxPerPan: interp(cal.points, zoom, 'dxPerPan'), dyPerTilt: interp(cal.points, zoom, 'dyPerTilt') };
}

/** Relative magnification at zoom (proportional to |dxPerPan|). */
export const magnification = (cal: Calibration, zoom: number) => Math.abs(interp(cal.points, zoom, 'dxPerPan'));

/** Zoom position whose magnification is `mag` (inverse of magnification(); clamped to the calibrated range). */
export function zoomForMagnification(cal: Calibration, mag: number): number {
  const p = [...cal.points].sort((a, b) => a.zoom - b.zoom);
  let lo = p[0]!.zoom;
  let hi = p[p.length - 1]!.zoom;
  if (mag <= magnification(cal, lo)) return lo;
  if (mag >= magnification(cal, hi)) return hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (magnification(cal, mid) < mag) lo = mid;
    else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}

// ------------------------------------------------------------ procedure

export interface CalibrateDeps {
  ptz: PtzControl;
  grab: () => Promise<RgbaImage | null>;
  log?: (msg: string) => void;
  /** Minimum wait after each move before checking the picture is still (default 400 ms). */
  minSettleMs?: number;
}

export interface CalibrateOptions {
  zooms?: number[];
  /** Aim for a scene shift of this fraction of the frame per measurement. */
  targetShift?: number;
  signal?: AbortSignal;
}

export interface CalibSample {
  zoom: number;
  axis: 'pan' | 'tilt';
  delta: number;
  dx: number;
  dy: number;
  peak: number;
}

/**
 * Measure dxPerPan / dyPerTilt at a few zoom levels around the current
 * pan/tilt, then return the camera to where it started.
 */
export async function calibrate(deps: CalibrateDeps, opts: CalibrateOptions = {}): Promise<{ calibration: Calibration; samples: CalibSample[] }> {
  const { ptz } = deps;
  const log = deps.log ?? (() => {});
  const sig = opts.signal;
  const start = await ptz.getPosition();
  const zooms = opts.zooms ?? [0, 4000, 8202, 12000];
  const targetShift = opts.targetShift ?? 0.08;
  const samples: CalibSample[] = [];
  const points: CalibPoint[] = [];
  let frameW = 0;
  let frameH = 0;

  const goto = async (p: { pan: number; tilt: number }, zoom?: number) => {
    await ptz.moveAbsolute(p, { pan: 0x10, tilt: 0x10 });
    if (zoom !== undefined) await ptz.zoomTo(zoom);
    await waitVideoStill(deps.grab, { signal: sig, minMs: deps.minSettleMs ?? 400, maxMs: 10_000, stable: 3 });
    const f = await deps.grab();
    if (!f) throw new Error('no video frame');
    frameW = f.width;
    frameH = f.height;
    return f;
  };

  /** One measurement: from start to start+delta along an axis. Returns shift along the axis (frame fraction) or null if unreliable. */
  const probe = async (zoom: number, axis: 'pan' | 'tilt', delta: number): Promise<number | null> => {
    const moved = axis === 'pan' ? { pan: start.pan + delta, tilt: start.tilt } : { pan: start.pan, tilt: start.tilt + delta };
    const a = await goto({ pan: start.pan, tilt: start.tilt }, zoom);
    const b = await goto(moved);
    const s = phaseCorrelate(a, b);
    samples.push({ zoom, axis, delta, dx: s.dx, dy: s.dy, peak: s.peak });
    log(`zoom ${zoom} ${axis} +${delta}: shift ${s.dx.toFixed(1)},${s.dy.toFixed(1)} px (peak ${s.peak.toFixed(0)})`);
    const along = axis === 'pan' ? s.dx / a.width : s.dy / a.height;
    const across = axis === 'pan' ? s.dy / a.height : s.dx / a.width;
    if (s.peak < 12 || Math.abs(across) > Math.max(0.01, Math.abs(along) * 0.35)) return null;
    return along;
  };

  /**
   * Shift (frame fraction) per unit along one axis. Starts with a small move and
   * grows it until the shift is clearly measurable (>= 3% of the frame), then
   * confirms with a move sized for ~8% and requires the two to agree.
   */
  const measure = async (zoom: number, axis: 'pan' | 'tilt', firstDelta: number) => {
    const maxDelta = axis === 'pan' ? 600 : 300;
    let delta = Math.max(2, Math.min(maxDelta, Math.round(firstDelta)));
    let r1: number | null = null;
    for (let i = 0; i < 6; i++) {
      const v = await probe(zoom, axis, delta);
      if (v !== null && Math.abs(v) >= 0.03 && Math.abs(v) <= 0.25) {
        r1 = v / delta;
        break;
      }
      if (v !== null && Math.abs(v) > 0.25) delta = Math.max(2, Math.round(delta / 3));
      else if (delta >= maxDelta) break;
      else delta = Math.min(maxDelta, delta * 3);
    }
    if (r1 === null) throw new Error(`zoom ${zoom}: could not measure the ${axis} shift reliably (low texture?)`);
    const d2 = Math.max(2, Math.min(maxDelta, Math.round(targetShift / Math.abs(r1))));
    if (Math.abs(d2 - delta) <= delta * 0.2) return r1;
    const v2 = await probe(zoom, axis, d2);
    const r2 = v2 === null ? null : v2 / d2;
    if (r2 === null || Math.sign(r2) !== Math.sign(r1) || Math.abs(r2 / r1 - 1) > 0.25) {
      throw new Error(`zoom ${zoom}: inconsistent ${axis} measurements (${r1.toExponential(2)} vs ${r2?.toExponential(2) ?? 'none'})`);
    }
    return (r1 + r2) / 2;
  };

  try {
    for (const zoom of zooms) {
      const dxPerPan = await measure(zoom, 'pan', 3);
      const dyPerTilt = await measure(zoom, 'tilt', 3);
      points.push({ zoom, dxPerPan, dyPerTilt });
      log(`zoom ${zoom}: dxPerPan ${dxPerPan.toExponential(3)} (${(dxPerPan * frameW).toFixed(2)} px/unit @${frameW}), dyPerTilt ${dyPerTilt.toExponential(3)} (${(dyPerTilt * frameH).toFixed(2)} px/unit @${frameH})`);
    }
  } finally {
    await ptz.moveAbsolute({ pan: start.pan, tilt: start.tilt }, { pan: 0x10, tilt: 0x10 }).catch(() => undefined);
    await ptz.zoomTo(start.zoom).catch(() => undefined);
  }
  return {
    calibration: { points, measuredAt: new Date().toISOString(), frameWidth: frameW, frameHeight: frameH },
    samples,
  };
}
