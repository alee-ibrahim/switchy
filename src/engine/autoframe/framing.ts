/**
 * Auto-framing maths (pure): pick the delegate's face and compute a small
 * RELATIVE pan/tilt correction (plus an optional zoom step direction).
 *
 * The seat presets are framed by hand, so this only touches them up for a
 * person sitting slightly off their usual spot. It never re-composes the shot:
 * - inside the deadband nothing moves;
 * - horizontally the eyes are brought back to the centre;
 * - vertically the eyes are only brought back just inside the band around the
 *   eye line (not onto the line itself);
 * - an offset larger than maxCorrection is rejected (wrong person, a frame from
 *   before the camera arrived, a standing person): no move at all.
 *
 * Nothing here depends on the camera's absolute position: the output is a delta
 * in VISCA units, sent as a VISCA relative move.
 */
import { coefficientsAt, type Calibration } from './calibration.js';
import type { Face } from './yunet.js';

export interface FramingOptions {
  /** Horizontal deadband: no pan while the eyes are within this fraction of the frame width of the centre (default 0.08). */
  deadbandX?: number;
  /** Vertical deadband: no tilt while the eyes are within this fraction of the frame height of the eye line (default 0.10). */
  deadbandY?: number;
  /** Largest horizontal offset (frame fraction) still treated as "the delegate, slightly off"; beyond it nothing moves (default 0.15). */
  maxCorrectionX?: number;
  /** Same for vertical (default 0.15). */
  maxCorrectionY?: number;
  /** Eye line as a fraction of the frame height from the top (default 1/3). */
  eyeLine?: number;
  /** Allow a zoom step (default false). */
  zoom?: boolean;
  /** Typical face-box height of the hand-framed presets, as a fraction of the frame height (default 0.2). */
  faceHeight?: number;
  /** Only step zoom when the face is this many times smaller/larger than faceHeight (default 1.6). */
  zoomRatio?: number;
  /** Ignore faces smaller than this fraction of the largest face (background people; default 0.45). */
  minRelativeSize?: number;
}

export const FRAMING_DEFAULTS: Required<FramingOptions> = {
  deadbandX: 0.08,
  deadbandY: 0.1,
  maxCorrectionX: 0.15,
  maxCorrectionY: 0.15,
  eyeLine: 1 / 3,
  zoom: false,
  faceHeight: 0.2,
  zoomRatio: 1.6,
  minRelativeSize: 0.45,
};

/** Midpoint of the eyes (landmarks 0 and 1), or the upper part of the box. */
export function eyePoint(f: Face): [number, number] {
  const [r, l] = f.landmarks;
  if (r && l) return [(r[0] + l[0]) / 2, (r[1] + l[1]) / 2];
  return [f.x + f.w / 2, f.y + f.h * 0.4];
}

/**
 * The delegate: among the faces of a plausible size (at least minRelativeSize
 * of the largest, so people at the desks behind are ignored), the one whose
 * eyes are closest to the target point (horizontal centre, eye line). The
 * preset is aimed at the seat, so the delegate is the one near the middle.
 */
export function pickTarget(
  faces: Face[],
  width: number,
  height: number,
  o: Pick<FramingOptions, 'minRelativeSize' | 'eyeLine'> = {},
): Face | null {
  if (!faces.length) return null;
  const minRel = o.minRelativeSize ?? FRAMING_DEFAULTS.minRelativeSize;
  const eyeLine = o.eyeLine ?? FRAMING_DEFAULTS.eyeLine;
  const maxH = Math.max(...faces.map((f) => f.h));
  let best: Face | null = null;
  let bestD = Infinity;
  for (const f of faces) {
    if (f.h < maxH * minRel) continue;
    const [ex, ey] = eyePoint(f);
    const dx = ex / width - 0.5;
    const dy = ey / height - eyeLine;
    // vertical offsets are more tolerated (people lean, sit lower/higher)
    const d = Math.hypot(dx, dy * 0.75) - 0.02 * (f.h / height); // tiny size tie-break
    if (d < bestD) (bestD = d), (best = f);
  }
  return best;
}

export type CorrectionKind = 'in-deadband' | 'too-far' | 'adjust';

export interface Correction {
  kind: CorrectionKind;
  /** Eye offset from the target point (centre, eye line), in frame fractions (+x right, +y down). */
  offset: { x: number; y: number };
  faceHeight: number;
  /** Relative pan/tilt in VISCA units (0 = no move on that axis). */
  delta: { pan: number; tilt: number };
  /** Zoom step direction: 1 in (tele), -1 out (wide), 0 none. */
  zoomStep: -1 | 0 | 1;
  /** Why it was rejected (kind 'too-far'). */
  why?: string;
}

/**
 * Correction for one detected face. `zoom` is the camera's zoom position used
 * only to look up the calibration scale (the preset's stored zoom, not a live read).
 */
export function computeCorrection(
  face: Face,
  frame: { width: number; height: number },
  zoom: number,
  cal: Calibration,
  options: FramingOptions = {},
): Correction {
  const o = { ...FRAMING_DEFAULTS, ...options };
  const [ex, ey] = eyePoint(face);
  const offset = { x: ex / frame.width - 0.5, y: ey / frame.height - o.eyeLine };
  const faceHeight = face.h / frame.height;
  const none = { delta: { pan: 0, tilt: 0 }, zoomStep: 0 as const };

  if (Math.abs(offset.x) > o.maxCorrectionX || Math.abs(offset.y) > o.maxCorrectionY) {
    const why = `face offset x ${(offset.x * 100).toFixed(1)}% y ${(offset.y * 100).toFixed(1)}% exceeds the ${(o.maxCorrectionX * 100).toFixed(0)}%/${(o.maxCorrectionY * 100).toFixed(0)}% limit`;
    return { kind: 'too-far', offset, faceHeight, ...none, why };
  }

  // scene shift wanted (frame fractions): content must move by -(how far the eyes are past the goal)
  const sx = Math.abs(offset.x) > o.deadbandX ? -offset.x : 0;
  // vertical: only back to just inside the band (half the deadband from the line)
  const sy = Math.abs(offset.y) > o.deadbandY ? -(offset.y - Math.sign(offset.y) * (o.deadbandY / 2)) : 0;

  let zoomStep: -1 | 0 | 1 = 0;
  if (o.zoom && faceHeight > 0) {
    if (faceHeight * o.zoomRatio < o.faceHeight) zoomStep = 1;
    else if (faceHeight > o.faceHeight * o.zoomRatio) zoomStep = -1;
  }

  const c = coefficientsAt(cal, zoom);
  const pan = sx ? Math.round(sx / c.dxPerPan) : 0;
  const tilt = sy ? Math.round(sy / c.dyPerTilt) : 0;
  const delta = { pan: pan || 0, tilt: tilt || 0 };
  if (!delta.pan && !delta.tilt && !zoomStep) return { kind: 'in-deadband', offset, faceHeight, ...none };
  return { kind: 'adjust', offset, faceHeight, delta, zoomStep };
}
