/**
 * Preset coordinates recorded while the camera is idle (at save time, or by a
 * back-fill that recalls each preset and waits for a still picture).
 *
 * Stored in camera.options.autoframe.presets[<preset>] = { pan, tilt, zoom, at }.
 * Auto-framing never reads the camera position around a move (the P100 returns
 * stale/garbage replies there); it only uses the stored zoom to pick the
 * calibration scale for its relative moves.
 */
import { z } from 'zod';
import type { PtzControl, PtzPosition } from '../cameras/types.js';

export const presetPositionSchema = z.object({
  pan: z.number(),
  tilt: z.number(),
  zoom: z.number(),
  at: z.string().optional(),
});
export type PresetPosition = z.infer<typeof presetPositionSchema>;

const af = (options: Record<string, unknown> | undefined) => (options?.autoframe ?? {}) as Record<string, unknown>;

export function presetPositions(options: Record<string, unknown> | undefined): Record<string, PresetPosition> {
  const r = z.record(z.string(), presetPositionSchema).safeParse(af(options).presets);
  return r.success ? r.data : {};
}

export function presetPosition(options: Record<string, unknown> | undefined, preset: string | null | undefined): PresetPosition | null {
  if (!preset) return null;
  return presetPositions(options)[preset] ?? null;
}

/** New camera options with one preset's coordinates set (or removed with null). */
export function withPresetPosition(
  options: Record<string, unknown>,
  preset: string,
  pos: PtzPosition | null,
  now = new Date(),
): Record<string, unknown> {
  const presets = { ...presetPositions(options) };
  if (pos) presets[preset] = { pan: pos.pan, tilt: pos.tilt, zoom: pos.zoom, at: now.toISOString() };
  else delete presets[preset];
  return { ...options, autoframe: { ...af(options), presets } };
}

/**
 * Zoom used to look up the calibration scale: the preset's stored zoom, else
 * camera option autoframe.referenceZoom (e.g. the zoom all seat presets were
 * saved at), else null.
 */
export function referenceZoom(options: Record<string, unknown> | undefined, preset: string | null | undefined): number | null {
  const p = presetPosition(options, preset);
  if (p) return p.zoom;
  const z = af(options).referenceZoom;
  return typeof z === 'number' && Number.isFinite(z) ? z : null;
}

const plausible = (p: PtzPosition) =>
  Number.isFinite(p.pan) && Number.isFinite(p.tilt) && Number.isFinite(p.zoom) && p.zoom >= 0 && p.zoom <= 0x7fff && Math.abs(p.tilt) < 0x2000;

/**
 * Position of an IDLE camera (call only after the picture is still): read up to
 * `reads` times and return a value that at least `need` reads agree on.
 */
export async function idlePosition(
  ptz: Pick<PtzControl, 'getPosition'>,
  o: { reads?: number; need?: number; gapMs?: number } = {},
): Promise<PtzPosition> {
  const reads = o.reads ?? 8;
  const need = o.need ?? 3;
  const seen: Array<{ p: PtzPosition; n: number }> = [];
  const all: string[] = [];
  for (let i = 0; i < reads; i++) {
    const p = await ptz.getPosition().catch(() => null);
    if (p) {
      all.push(`${p.pan}/${p.tilt}/z${p.zoom}`);
      if (plausible(p)) {
        const s = seen.find((x) => x.p.pan === p.pan && x.p.tilt === p.tilt && x.p.zoom === p.zoom);
        if (s) s.n++;
        else seen.push({ p, n: 1 });
        if ((s?.n ?? 1) >= need) return { ...p };
      }
    }
    if (o.gapMs) await new Promise((r) => setTimeout(r, o.gapMs));
  }
  throw new Error(`camera position reads disagree (${all.join(', ') || 'no reply'})`);
}
