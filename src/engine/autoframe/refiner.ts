/**
 * The 'auto-frame' refine step: light touch-ups of hand-saved seat presets.
 *
 *   preset recalled -> wait until the video is still -> picture -> face ->
 *   small RELATIVE pan/tilt move (+ optional zoom step) -> wait still ->
 *   second picture to verify -> at most one more small nudge -> cut.
 *
 * The last picture (after the last nudge has settled) goes through the shot
 * gate (shot-gate.ts); the room controller cuts only if it passes (else
 * policy.autoFrameFallback).
 *
 * It never reads the camera position: on the P100, position replies around a
 * move are stale (the previous preset) or garbage, and absolute corrections
 * built on them sent the camera far off. Pan uses VISCA relative moves (no start
 * position needed). Tilt uses relative moves only where the camera handles them
 * (camera option autoframe.relativeTilt; off by default because the P100
 * ignores positive and mis-scales negative relative tilt): otherwise it is an
 * absolute move to the preset's STORED coordinates (recorded while idle at save
 * time / back-fill) plus the accumulated correction, and is skipped if the
 * preset has none. The calibration scale is looked up at the preset's stored
 * zoom or the camera's autoframe.referenceZoom.
 */
import type { CameraDriver } from '../cameras/types.js';
import type { FrameSource } from '../ndi/frames.js';
import type { RefineContext, RefineGate, RefineResult, ShotRefiner } from '../room/controller.js';
import type { CameraConfig, RoomPolicy } from '../types.js';
import { calibrationFromOptions } from './calibration.js';
import { waitVideoStill } from './phase.js';
import { computeCorrection, eyePoint, pickTarget, type Correction } from './framing.js';
import { clampZoom, zoomTolerance } from './limits.js';
import { presetPosition, referenceZoom } from './presets.js';
import { gateThresholds, headTop, judgeShot } from './shot-gate.js';
import type { Face, FaceDetector } from './yunet.js';

export interface AutoFrameDeps {
  frames: FrameSource;
  /** Lazily loaded detector (model download + session on first use). */
  detector: () => Promise<FaceDetector>;
}

export type AutoFrameReason =
  | 'adjusted'
  | 'in-deadband'
  | 'too-far'
  | 'no-face'
  | 'no-video'
  | 'not-still'
  | 'not-calibrated'
  | 'no-reference'
  | 'tilt-unavailable'
  | 'no-ptz'
  | 'dry-run';

export interface AutoFramePass {
  faces: number;
  target: Face | null;
  correction?: Correction;
  moved: boolean;
  /** How the move was sent: relative, or absolute to stored preset coordinates + correction. */
  via?: 'relative' | 'preset';
  /** Tilt correction dropped: the camera has no usable relative tilt and the preset no stored coordinates. */
  tiltSkipped?: boolean;
}

export interface AutoFrameRun {
  ok: boolean;
  /** At least one move was sent. */
  adjusted: boolean;
  /** 'adjusted', or the outcome of the first picture. */
  reason: AutoFrameReason;
  frame?: { width: number; height: number };
  faces?: Face[];
  target?: Face | null;
  /** First-pass correction. */
  correction?: Correction;
  /** One entry per picture analysed (max 2). */
  passes: AutoFramePass[];
  moves: number;
  /** Shot gate on the verify picture (the last picture analysed, after the last nudge settled). */
  verify?: RefineGate;
  /** Zoom the calibration scale was looked up at. */
  zoomRef?: number;
  settle?: { ms: number; frames: number; still: boolean };
  timings: { stillMs?: number; detectMs?: number; moveMs?: number; settleMs?: number; totalMs: number };
}

const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const signed = (v: number) => `${v >= 0 ? '+' : ''}${v}`;
const faceTxt = (c: Correction) => `face offset x ${pct(c.offset.x)} y ${pct(c.offset.y)}, height ${(c.faceHeight * 100).toFixed(0)}%`;
const moveTxt = (c: Correction) =>
  `pan ${signed(c.delta.pan)} tilt ${signed(c.delta.tilt)}${c.zoomStep ? ` zoom step ${c.zoomStep > 0 ? 'in' : 'out'}` : ''}`;

export function describeRun(r: AutoFrameRun): string {
  const g = r.verify ? `; shot gate: ${r.verify.good ? 'good' : 'bad'} (${r.verify.reason})` : '';
  return describeRunBody(r) + g;
}

function describeRunBody(r: AutoFrameRun): string {
  const t = r.timings;
  const times = [
    t.stillMs !== undefined && `wait still ${t.stillMs} ms`,
    t.detectMs !== undefined && `detect ${t.detectMs} ms`,
    t.moveMs !== undefined && `move+settle ${(t.moveMs ?? 0) + (t.settleMs ?? 0)} ms`,
    `total ${t.totalMs} ms`,
  ]
    .filter(Boolean)
    .join(', ');
  const c = r.correction;
  const face = c ? faceTxt(c) : '';
  switch (r.reason) {
    case 'adjusted': {
      const steps = r.passes
        .map((p, i) => {
          if (!p.correction) return `pass ${i + 1}: no face`;
          const how = p.via === 'preset' ? 'moved to stored preset +' : 'moved relative';
          const skip = p.tiltSkipped ? ' (tilt skipped: no stored preset position)' : '';
          const what = p.moved ? `${how} ${moveTxt(p.correction)}${skip}` : p.correction.kind === 'too-far' ? 'too far, no move' : 'ok';
          return `pass ${i + 1}: ${faceTxt(p.correction)}, ${what}`;
        })
        .join('; ');
      return `${steps}${r.settle && !r.settle.still ? ' (settle timed out)' : ''}; ${times}`;
    }
    case 'in-deadband':
      return `${face}; within deadband; ${times}`;
    case 'too-far':
      return `${c?.why ?? face}: probably not the seated delegate, kept the preset; ${times}`;
    case 'dry-run':
      return `${face}; would move relative ${c ? moveTxt(c) : 'nothing'}; ${times}`;
    case 'no-face':
      return `no face found (${r.faces?.length ?? 0} detections); ${times}`;
    case 'no-video':
      return `no video frame; ${times}`;
    case 'not-still':
      return `picture did not settle, kept the preset; ${times}`;
    case 'not-calibrated':
      return 'camera not calibrated (run calibration first)';
    case 'no-reference':
      return 'no stored zoom for this preset (save the preset again, back-fill preset positions, or set autoframe.referenceZoom)';
    case 'tilt-unavailable':
      return `${face}; needs a tilt correction but the preset has no stored position (camera has no usable relative tilt), kept the preset; ${times}`;
    case 'no-ptz':
      return 'camera has no fine PTZ control';
  }
}

export interface AutoFrameRequest {
  camera: CameraConfig;
  driver: CameraDriver;
  policy: Pick<RoomPolicy, 'refineDeadbandPct' | 'refineDeadbandVPct' | 'refineMaxCorrectionPct' | 'refineZoom' | 'refineTimeoutMs'> &
    Partial<Pick<RoomPolicy, 'trackZoomTolerancePct' | 'trackHeadroomPct' | 'trackTightFacePct'>>;
  /** Preset just recalled (its stored zoom picks the calibration scale). */
  preset?: string | null;
  signal?: AbortSignal;
  dryRun?: boolean;
  /** Max pictures (each may be followed by one nudge; default 2). */
  maxPasses?: number;
  /** For tests: frame-stillness wait limits. */
  stillMaxMs?: number;
  /** Gate result of every picture analysed (the controller keeps the last one for a timeout). */
  onCheck?: (g: RefineGate) => void;
}

/** Shot gate on one still picture (auto-frame verify). */
export function gatePicture(faces: Face[], target: Face | null, size: { width: number; height: number }, policy: AutoFrameRequest['policy']): RefineGate {
  const thr = gateThresholds({ trackHeadroomPct: policy.trackHeadroomPct ?? 5, trackTightFacePct: policy.trackTightFacePct ?? 35 }, false);
  if (!target) return { good: false, faceWithHeadroom: false, reason: `no face found (${faces.length} detections)` };
  const box = { x: target.x / size.width, y: target.y / size.height, w: target.w / size.width, h: target.h / size.height };
  const [ex, ey] = eyePoint(target);
  const v = judgeShot({ state: 'locked', box, eye: { x: ex / size.width, y: ey / size.height }, source: 'face', speed: 0 }, thr);
  return { good: v.good, faceWithHeadroom: headTop(box) >= thr.headroom, reason: v.reason };
}


type Head = Omit<AutoFrameRun, 'timings' | 'passes' | 'moves'>;

export async function autoFrameOnce(deps: AutoFrameDeps, req: AutoFrameRequest): Promise<AutoFrameRun> {
  const t0 = Date.now();
  const timings: AutoFrameRun['timings'] = { totalMs: 0 };
  const passes: AutoFramePass[] = [];
  let moves = 0;
  let verify: RefineGate | undefined;
  const done = (r: Head): AutoFrameRun => ({ ...r, passes, moves, verify, timings: { ...timings, totalMs: Date.now() - t0 } });
  const add = (k: 'stillMs' | 'detectMs' | 'moveMs' | 'settleMs', ms: number) => (timings[k] = (timings[k] ?? 0) + ms);
  const aborted = () => {
    if (req.signal?.aborted) throw new DOMException('aborted', 'AbortError');
  };

  const ptz = req.driver.ptz;
  if (!ptz) return done({ ok: false, adjusted: false, reason: 'no-ptz' });
  const cal = calibrationFromOptions(req.camera.options);
  if (!cal) return done({ ok: false, adjusted: false, reason: 'not-calibrated' });
  if (!req.camera.ndiSource) throw new Error(`${req.camera.name} has no NDI source configured`);
  const zoomRef = referenceZoom(req.camera.options, req.preset);
  if (zoomRef === null) return done({ ok: false, adjusted: false, reason: 'no-reference' });

  const af = (req.camera.options.autoframe ?? {}) as Record<string, unknown>;
  const relativeTilt = af.relativeTilt === true;
  const stored = presetPosition(req.camera.options, req.preset);
  /** correction sent so far (relative to the preset), for absolute moves to stored + correction */
  const sum = { pan: 0, tilt: 0 };
  const p = req.policy;
  const opts = {
    deadbandX: p.refineDeadbandPct / 100,
    deadbandY: (p.refineDeadbandVPct ?? 10) / 100,
    maxCorrectionX: (p.refineMaxCorrectionPct ?? 15) / 100,
    maxCorrectionY: (p.refineMaxCorrectionPct ?? 15) / 100,
  };
  const src = req.camera.ndiSource;
  const grab = () => deps.frames.grab(src);
  const stillMaxMs = req.stillMaxMs ?? 2000;
  const detector = await deps.detector();
  const maxPasses = req.maxPasses ?? 2;
  const budget = p.refineTimeoutMs ?? 4000;

  let first: Head | null = null;
  let settle: AutoFrameRun['settle'];
  for (let pass = 1; pass <= maxPasses; pass++) {
    // 1. wait for a still picture: preset recall / previous nudge finished, NDI latency absorbed
    let t = Date.now();
    const still = await waitVideoStill(grab, { signal: req.signal, minMs: pass === 1 ? 0 : 200, maxMs: stillMaxMs, stable: 3 });
    if (pass === 1) add('stillMs', Date.now() - t);
    else {
      add('settleMs', Date.now() - t);
      settle = { ms: still.ms, frames: still.frames, still: still.still };
    }
    aborted();
    if (!still.last || !still.still) {
      if (pass === 1) {
        verify = { good: false, faceWithHeadroom: false, reason: still.last ? 'picture did not settle' : 'no video frame' };
        return done({ ok: !!still.last, adjusted: false, reason: still.last ? 'not-still' : 'no-video' });
      }
      // the nudge is not verified: no gate verdict on an older picture
      verify = { good: false, faceWithHeadroom: verify?.faceWithHeadroom ?? false, reason: 'picture did not settle after the nudge' };
      break;
    }
    // 2. picture -> face -> correction
    const frame = still.last;
    t = Date.now();
    const faces = await detector.detect(frame);
    add('detectMs', Date.now() - t);
    const size = { width: frame.width, height: frame.height };
    const target = pickTarget(faces, frame.width, frame.height);
    // zoom only on the first pass (one small step at most)
    const correction = target ? computeCorrection(target, size, zoomRef, cal, { ...opts, zoom: p.refineZoom && pass === 1 }) : undefined;
    const entry: AutoFramePass = { faces: faces.length, target, correction, moved: false };
    passes.push(entry);
    verify = gatePicture(faces, target, size, p);
    req.onCheck?.(verify);
    if (pass === 1) {
      first = { ok: true, adjusted: false, reason: 'no-face', frame: size, faces, target, correction, zoomRef };
      if (!correction) return done(first);
      if (correction.kind !== 'adjust') return done({ ...first, reason: correction.kind });
      if (req.dryRun) return done({ ...first, reason: 'dry-run' });
    } else {
      if (!correction || correction.kind !== 'adjust') break;
      // not enough time left for another nudge + settle: cut as is
      if (Date.now() - t0 > budget * 0.55) break;
    }
    aborted();
    // 3. small move: relative pan; tilt relative only if the camera supports it,
    //    else absolute to the preset's stored coordinates + correction (no position read)
    t = Date.now();
    const d = { ...correction.delta };
    if (d.tilt && !relativeTilt && !stored) {
      d.tilt = 0;
      entry.tiltSkipped = true;
    }
    if (!d.pan && !d.tilt && !correction.zoomStep) {
      if (pass === 1) first = { ...first!, reason: 'tilt-unavailable' };
      break;
    }
    if (d.tilt && !relativeTilt) {
      sum.pan += d.pan;
      sum.tilt += d.tilt;
      await ptz.moveAbsolute({ pan: stored!.pan + sum.pan, tilt: stored!.tilt + sum.tilt }, { pan: 0x18, tilt: 0x14 });
      entry.via = 'preset';
    } else if (d.pan || d.tilt) {
      sum.pan += d.pan;
      sum.tilt += d.tilt;
      await ptz.moveRelative(d, { pan: 0x18, tilt: 0x14 });
      entry.via = 'relative';
    }
    if (correction.zoomStep) {
      // hard limit: one ABSOLUTE zoom target inside the preset zoom +/- tolerance (never a free-running zoom drive)
      const tol = p.trackZoomTolerancePct ?? 15;
      await ptz.zoomTo(clampZoom(zoomRef + correction.zoomStep * 0.5 * zoomTolerance(zoomRef, tol), zoomRef, tol));
    }
    add('moveMs', Date.now() - t);
    entry.moved = true;
    moves++;
  }
  // the last picture led to a nudge: wait for it to finish, then verify that picture (shot gate)
  if (passes[passes.length - 1]?.moved) {
    let t = Date.now();
    const s = await waitVideoStill(grab, { signal: req.signal, minMs: 200, maxMs: stillMaxMs, stable: 2 });
    add('settleMs', Date.now() - t);
    settle = { ms: s.ms, frames: s.frames, still: s.still };
    aborted();
    if (s.last) {
      t = Date.now();
      const faces = await detector.detect(s.last);
      add('detectMs', Date.now() - t);
      verify = gatePicture(faces, pickTarget(faces, s.last.width, s.last.height), { width: s.last.width, height: s.last.height }, p);
      req.onCheck?.(verify);
    } else verify = { good: false, faceWithHeadroom: false, reason: 'no video frame after the nudge' };
  }
  return done({ ...first!, adjusted: moves > 0, reason: moves > 0 ? 'adjusted' : first!.reason, settle });
}

export type AutoFrameRefiner = ShotRefiner & { lastRun?: AutoFrameRun };

/** ShotRefiner for policy.refine = 'auto-frame'. */
export function createAutoFrameRefiner(deps: AutoFrameDeps, onRun?: (ctx: RefineContext, r: AutoFrameRun) => void): AutoFrameRefiner {
  const fn: AutoFrameRefiner = async (ctx: RefineContext): Promise<RefineResult> => {
    const r = await autoFrameOnce(deps, {
      camera: ctx.camera,
      driver: ctx.driver,
      policy: ctx.room.policy,
      preset: ctx.shot.preset,
      signal: ctx.signal,
      onCheck: ctx.onCheck,
    });
    fn.lastRun = r;
    onRun?.(ctx, r);
    return { adjusted: r.adjusted, detail: describeRun(r), gate: r.verify };
  };
  return fn;
}

/** Open the PTZ's NDI receiver while the preset recall runs, so the refine grab is warm. */
export function prewarm(frames: FrameSource, camera: CameraConfig): void {
  if (camera.ndiSource) frames.grab(camera.ndiSource).catch(() => undefined);
}
