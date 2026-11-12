/**
 * Camera control driver interface. One instance per configured camera.
 *
 * Drivers only *control* cameras (presets, status). Video never flows through
 * them: the program output routes NDI sources independently.
 */
export interface CameraProbeResult {
  ok: boolean;
  model?: string;
  firmware?: string;
  detail?: unknown;
  error?: string;
}

/** Raw pan/tilt/zoom position in the camera's own units (VISCA nibble values). */
export interface PtzPosition {
  pan: number;
  tilt: number;
  zoom: number;
}

/**
 * Fine pan/tilt/zoom control. Used by the phase-2 "refine" step (auto-framing:
 * nudge the camera to a head-and-shoulders shot after the preset arrived) and
 * for saving a refined position back as the seat preset.
 * Implemented over VISCA-over-IP (Sony, and BirdDog which also listens on UDP 52381).
 */
export interface PtzControl {
  getPosition(): Promise<PtzPosition>;
  /** speeds: VISCA pan 0x01-0x18, tilt 0x01-0x14 */
  moveAbsolute(pos: { pan: number; tilt: number }, speed?: { pan: number; tilt: number }): Promise<void>;
  moveRelative(delta: { pan: number; tilt: number }, speed?: { pan: number; tilt: number }): Promise<void>;
  zoomTo(zoom: number): Promise<void>;
  /** Store the current position as a preset (same numbering as recallPreset). */
  savePreset(preset: string): Promise<void>;
  /**
   * Continuous pan/tilt drive (jog). pan: -1 left, 1 right; tilt: 1 up, -1 down; 0 = stop that axis.
   * Keeps moving until stop() or another drive(); callers must always stop (the API has a deadman).
   */
  drive(dir: { pan: JogDir; tilt: JogDir }, speed?: { pan: number; tilt: number }): Promise<void>;
  /** Continuous zoom: 1 in (tele), -1 out (wide), 0 stop. speed 0 (slow) - 7 (fast). */
  zoomDrive(dir: JogDir, speed?: number): Promise<void>;
  /** Stop pan/tilt and zoom. */
  stop(): Promise<void>;
}

export type JogDir = -1 | 0 | 1;

/** VISCA speed limits for drive()/zoomDrive(): pan 0x01-0x18, tilt 0x01-0x14, zoom 0-7. */
export const PTZ_SPEED = { panMax: 0x18, tiltMax: 0x14, zoomMax: 7 } as const;

export interface CameraDriver {
  readonly kind: string;
  /** Optional fine PTZ control (see PtzControl). */
  readonly ptz?: PtzControl;
  /** Recall a stored preset. Resolves once the camera accepted the command. */
  recallPreset(preset: string): Promise<void>;
  /** Store the camera's current position as a preset (same numbering as recallPreset). */
  savePreset?(preset: string): Promise<void>;
  /** Check reachability and identify the camera. */
  probe(): Promise<CameraProbeResult>;
  /**
   * Optional: wait until the camera stopped moving (e.g. by polling pan/tilt
   * position). If absent, the controller waits the camera's fixed settle time.
   * Must resolve no later than maxMs and reject with AbortError when aborted.
   */
  waitSettled?(signal: AbortSignal, maxMs: number): Promise<void>;
  close?(): void;
}

export interface Credentials {
  username: string;
  password: string;
}

/**
 * Resolve a credential reference from the environment:
 *   SWITCHY_CRED_<REF>_USERNAME / SWITCHY_CRED_<REF>_PASSWORD
 * (in Kubernetes, inject them from a Secret). Never stored in the DB.
 */
export function resolveCredentials(ref: string | null | undefined, env: NodeJS.ProcessEnv = process.env): Credentials | null {
  if (!ref) return null;
  const key = ref.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const username = env[`SWITCHY_CRED_${key}_USERNAME`];
  const password = env[`SWITCHY_CRED_${key}_PASSWORD`];
  if (username === undefined || password === undefined) return null;
  return { username, password };
}
