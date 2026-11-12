import type { CameraConfig } from '../types.js';
import { BirdDogDriver } from './birddog.js';
import { ViscaDriver, type ViscaFraming } from './visca.js';
import { resolveCredentials, type CameraDriver, type CameraProbeResult } from './types.js';

export type { CameraDriver, CameraProbeResult } from './types.js';

/** A camera without control (fixed wide shot): presets are no-ops. */
export class NoControlDriver implements CameraDriver {
  readonly kind = 'none';
  async recallPreset(): Promise<void> {}
  async probe(): Promise<CameraProbeResult> {
    return { ok: true, detail: 'no control driver' };
  }
}

export function createDriver(cam: CameraConfig): CameraDriver {
  const opt = cam.options ?? {};
  switch (cam.driver) {
    case 'birddog':
      return new BirdDogDriver({
        host: cam.host,
        port: cam.port,
        timeoutMs: typeof opt.timeoutMs === 'number' ? opt.timeoutMs : undefined,
        credentials: resolveCredentials(cam.credentialsRef),
        viscaPtz: opt.viscaPtz !== false,
        viscaPort: typeof opt.viscaPort === 'number' ? opt.viscaPort : undefined,
      });
    case 'visca':
      return new ViscaDriver({
        host: cam.host,
        port: cam.port,
        framing: (opt.framing as ViscaFraming) ?? 'sony',
        presetOffset: typeof opt.presetOffset === 'number' ? opt.presetOffset : undefined,
        pollPosition: opt.pollPosition === true,
        timeoutMs: typeof opt.timeoutMs === 'number' ? opt.timeoutMs : undefined,
        panNibbles: typeof opt.panNibbles === 'number' ? opt.panNibbles : undefined,
      });
    case 'none':
    default:
      return new NoControlDriver();
  }
}
