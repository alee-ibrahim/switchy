import { z } from 'zod';

export const cameraDriverKinds = ['birddog', 'visca', 'none'] as const;
export const cameraRoles = ['wide', 'ptz', 'both'] as const;

export const cameraSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Control driver: BirdDog REST, generic VISCA-over-IP, or none (static camera). */
  driver: z.enum(cameraDriverKinds),
  host: z.string().default(''),
  /** Control port; null = driver default (BirdDog 8080, VISCA 52381). */
  port: z.number().int().min(1).max(65535).nullable().default(null),
  role: z.enum(cameraRoles),
  /** Full NDI source name, e.g. "BIRDDOG-X1 (CAM)". */
  ndiSource: z.string().default(''),
  /** Time to wait after a preset recall before cutting to this camera. */
  settleMs: z.number().int().min(0).max(30000).default(2500),
  /** Preset recalled when the room returns to this camera as the wide shot (optional). */
  homePreset: z.string().nullable().default(null),
  /** Name of a credential set taken from env (SWITCHY_CRED_<REF>_USERNAME / _PASSWORD). Never store secrets here. */
  credentialsRef: z.string().nullable().default(null),
  /** Driver-specific options (e.g. VISCA framing, preset offset, position polling). */
  options: z.record(z.string(), z.unknown()).default({}),
});
export type CameraConfig = z.infer<typeof cameraSchema>;

export const seatSchema = z.object({
  /** DCen unit number (decimal; the DCen sends it as 4-digit hex). */
  unit: z.number().int().min(0).max(0xfffe),
  label: z.string().default(''),
  cameraId: z.string().min(1),
  /** Preset on that camera; null = just take the camera. */
  preset: z.string().nullable().default(null),
});
export type SeatConfig = z.infer<typeof seatSchema>;

export const policySchema = z.object({
  chairUnit: z.number().int().nullable().default(null),
  chairPriority: z.boolean().default(false),
  /** last = newest speaker wins; first = current speaker keeps the shot while on. */
  mode: z.enum(['last', 'first']).default('last'),
  debounceMs: z.number().int().min(0).max(5000).default(300),
  /** When nobody is speaking, return to wide after this delay. */
  returnToWideMs: z.number().int().min(0).max(600000).default(3000),
  /** One-camera rooms: show the move live, or route to a holding source while moving. */
  oneCameraMove: z.enum(['live', 'holding']).default('live'),
  /** NDI source name used as a holding shot while a lone camera moves; empty = none. */
  holdingSource: z.string().default(''),
  /** A mic without a seat mapping: go to the wide shot, or ignore it. */
  unmappedSeat: z.enum(['wide', 'ignore']).default('wide'),
  /**
   * Optional "refine" step between "PTZ arrived" and "cut to PTZ".
   * 'auto-frame': light touch-up of the hand-saved preset. Wait for a still
   * picture, detect the delegate's face, send a small RELATIVE pan/tilt nudge if
   * the eyes are outside the deadband, verify with a second picture (one more
   * nudge at most), then cut. Needs a calibrated PTZ (README "Auto-framing").
   *
   * 'track': active tracking. Wait for a still picture, lock onto the
   * delegate's face, and keep them framed with slow pan/tilt velocity drive
   * while they are the active shot. The program shows the PTZ only while the
   * shot gate says the shot is good (trackLostToWideMs etc. below), never on a
   * timeout. See src/engine/autoframe/track-controller.ts and shot-gate.ts.
   */
  refine: z.enum(['off', 'auto-frame', 'track']).default('off'),
  /** Auto-frame: give up refining after this long (then autoFrameFallback decides). Track: no effect on the cut. */
  refineTimeoutMs: z.number().int().min(0).max(20000).default(4000),
  /** Save the refined position back into the seat's preset (overwrites the camera preset). */
  refineSavePreset: z.boolean().default(false),
  /** Auto-frame: no pan while the eyes are within this % of the frame width of the centre. */
  refineDeadbandPct: z.number().min(0).max(25).default(8),
  /** Auto-frame: no tilt while the eyes are within this % of the frame height of the eye line (upper third). */
  refineDeadbandVPct: z.number().min(0).max(25).default(10),
  /**
   * Auto-frame: a face further than this % from the target (either axis) is not
   * treated as the seated delegate slightly off (wrong person, standing, picture
   * from before the camera arrived): no move, cut on the preset.
   */
  refineMaxCorrectionPct: z.number().min(1).max(40).default(15),
  /** Auto-frame: allow one small relative zoom step when the face is clearly too small or too big (off by default). */
  refineZoom: z.boolean().default(false),
  /** Track: no pan while the eyes are within this % of the frame width of the centre (outer band; stops inside 40% of it). */
  trackDeadzoneXPct: z.number().min(2).max(30).default(10),
  /** Track: no tilt while the eyes are within this % of the frame height of the eye line (upper third). */
  trackDeadzoneYPct: z.number().min(2).max(30).default(12),
  /** Track: highest VISCA pan/tilt speed level used (P100: level 2 is the slowest usable pan speed). */
  trackMaxSpeed: z.number().int().min(2).max(12).default(5),
  /** Track: the camera never moves further than this % of the frame from the seat preset. */
  trackMaxExcursionPct: z.number().min(5).max(100).default(35),
  /** Track: target not seen for this long -> stop and hold. */
  trackLossTimeoutMs: z.number().int().min(300).max(10000).default(1500),
  /** Track: target not seen for this long -> back to the seat preset and re-acquire (0 = never). */
  trackReturnAfterMs: z.number().int().min(0).max(120000).default(0),
  /** Track: very slow zoom to keep the face height in a band (off by default). */
  trackZoom: z.boolean().default(false),
  /**
   * Hard zoom limit (track and auto-frame): zoom never leaves the seat preset's
   * stored zoom by more than this %. An idle zoom read further off than this
   * means the camera was moved by something else: the preset is recalled.
   */
  trackZoomTolerancePct: z.number().min(3).max(50).default(15),
  /** Hard limit: a tracked face taller than this % of the frame is too tight: recall the seat preset. */
  trackTightFacePct: z.number().min(15).max(90).default(35),
  /** Track: after a loss, pick the delegate up again when a face shows up in the seat region (near where they were, or near the preset aim). */
  trackReacquire: z.boolean().default(true),
  /**
   * Shot gate (track mode): the program shows the PTZ only while the shot is
   * good (target locked, head fully in the frame with headroom, face size and
   * eye line sane, camera not moving fast); otherwise the wide camera. See
   * src/engine/autoframe/shot-gate.ts.
   */
  /** Gate: target lost this long while on the PTZ -> wide. */
  trackLostToWideMs: z.number().int().min(100).max(10000).default(700),
  /** Gate: shot bad (e.g. no headroom: the person stood up) this long while on the PTZ -> wide. */
  trackBadToWideMs: z.number().int().min(100).max(10000).default(700),
  /** Gate: the shot must be good this long before the cut to the PTZ. */
  trackHoldBeforeCutMs: z.number().int().min(0).max(5000).default(400),
  /** Gate: at least this long on each source before the gate switches again (a lost target always goes to wide). */
  trackMinDwellMs: z.number().int().min(0).max(20000).default(2000),
  /** Gate: the top of the head must be at least this % of the frame height below the top edge. */
  trackHeadroomPct: z.number().min(0).max(25).default(5),
  /** Inside the seat region, faces down to this detector confidence are taken for (re)acquisition (outside: 0.6). */
  trackSeatMinScore: z.number().min(0.3).max(0.9).default(0.5),
  /** Head/upper-body fallback detector (body keypoints) when no face is found in the seat region. */
  trackFallbackDetector: z.boolean().default(true),
  /**
   * Per-seat learned correction: after good tracking turns, remember where the
   * delegate actually sits relative to the hand-saved preset and start the
   * next turn there (one small move after the recall). The preset itself is
   * never changed. See src/engine/autoframe/learn.ts.
   */
  trackLearn: z.boolean().default(true),
  /** Learned correction: at most this % of the frame per axis. */
  trackLearnCapPct: z.number().min(1).max(25).default(10),
  /** Learned correction: turns remembered per seat (the median is used from 2 on). */
  trackLearnSamples: z.number().int().min(2).max(20).default(5),
  /** Learned correction: ticks with the delegate further than this % of the frame from the preset aim are not sampled (wrong person). */
  trackLearnMaxOffsetPct: z.number().min(5).max(50).default(35),
  /** Learned correction: a turn teaches only if its offset was stable, i.e. the spread (IQR) per axis is at most this % of the frame. */
  trackLearnMaxSpreadPct: z.number().min(1).max(25).default(8),
  /**
   * Sharpness gate: no cut to the PTZ while the head region is softer than
   * this % of the seat's recent sharp baseline (motion blur, focus hunting).
   * 0 = off. Never takes the PTZ off program.
   */
  trackBlurRatioPct: z.number().min(0).max(80).default(30),
  /**
   * Auto-frame mode: what to show when the verify picture fails the shot gate.
   * 'wide' = stay on wide; 'preset-if-face' = the PTZ shot only if a face was at
   * least seen with headroom; 'preset' = the PTZ shot anyway (old behaviour).
   */
  autoFrameFallback: z.enum(['wide', 'preset-if-face', 'preset']).default('preset-if-face'),
});
export type RoomPolicy = z.infer<typeof policySchema>;

export const roomInputSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  dcenHost: z.string().default(''),
  dcenPort: z.number().int().min(1).max(65535).default(3225),
  /** Name of the published NDI program source. */
  outputName: z.string().min(1),
  /**
   * route = NDI routing (cut-only, no video passes through the server).
   * Future: 'switcher' (decode + re-encode, real transitions).
   */
  outputMode: z.enum(['route']).default('route'),
  cameras: z.array(cameraSchema).default([]),
  seats: z.array(seatSchema).default([]),
  policy: policySchema.default(policySchema.parse({})),
});
export type RoomInput = z.infer<typeof roomInputSchema>;
export type RoomConfig = RoomInput & { id: string };
