/**
 * Hard limits in camera units (pure). These hold even if every image-based
 * estimate is wrong: they compare VISCA positions read while the camera is idle
 * (or dead-reckoned from commanded speeds) with the seat preset's stored
 * position.
 */
import type { PtzPosition } from '../cameras/types.js';
import { coefficientsAt, type Calibration } from './calibration.js';
import type { PresetPosition } from './presets.js';

/** Zoom units used as the base of the % tolerance when a preset is stored near full wide (zoom 0). */
const ZOOM_TOL_FLOOR = 1000;

/** Largest zoom distance from the preset's stored zoom (VISCA units). */
export function zoomTolerance(presetZoom: number, tolPct: number): number {
  return Math.max(presetZoom, ZOOM_TOL_FLOOR) * (tolPct / 100);
}

/** Clamp a zoom target into preset zoom +/- tolerance. */
export function clampZoom(zoom: number, presetZoom: number, tolPct: number): number {
  const tol = zoomTolerance(presetZoom, tolPct);
  return Math.round(Math.min(presetZoom + tol, Math.max(presetZoom - tol, zoom)));
}

export function zoomWithin(zoom: number, presetZoom: number, tolPct: number): boolean {
  return Math.abs(zoom - presetZoom) <= zoomTolerance(presetZoom, tolPct) + 1;
}

/**
 * The excursion limit (fraction of the frame at the preset zoom) in VISCA
 * pan/tilt units, from the calibration at the preset's zoom.
 */
export function excursionUnits(cal: Calibration, zoom: number, fraction: number): { pan: number; tilt: number } {
  const c = coefficientsAt(cal, zoom);
  return {
    pan: Math.max(1, Math.round(fraction / Math.max(Math.abs(c.dxPerPan), 1e-6))),
    tilt: Math.max(1, Math.round(fraction / Math.max(Math.abs(c.dyPerTilt), 1e-6))),
  };
}

export interface PositionCheck {
  ok: boolean;
  /** Why it is off (for the log). */
  why?: string;
}

/**
 * Is an idle position plausible for this preset: zoom within the tolerance and
 * pan/tilt within `units` of the stored position?
 */
export function checkAgainstPreset(
  pos: PtzPosition,
  preset: Pick<PresetPosition, 'pan' | 'tilt' | 'zoom'>,
  o: { zoomTolPct: number; units: { pan: number; tilt: number } },
): PositionCheck {
  const why: string[] = [];
  if (!zoomWithin(pos.zoom, preset.zoom, o.zoomTolPct)) why.push(`zoom ${pos.zoom} vs ${preset.zoom} (limit +/-${o.zoomTolPct}%)`);
  if (Math.abs(pos.pan - preset.pan) > o.units.pan) why.push(`pan ${pos.pan} vs ${preset.pan} (limit ${o.units.pan})`);
  if (Math.abs(pos.tilt - preset.tilt) > o.units.tilt) why.push(`tilt ${pos.tilt} vs ${preset.tilt} (limit ${o.units.tilt})`);
  return why.length ? { ok: false, why: why.join(', ') } : { ok: true };
}

/** Pan/tilt distance limits used when no calibration is stored (VISCA units; generous). */
export const FALLBACK_UNITS = { pan: 150, tilt: 100 } as const;

export const fmtPos = (p: PtzPosition) => `${p.pan}/${p.tilt}/z${p.zoom}`;
