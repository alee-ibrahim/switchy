/**
 * Single-frame grabs from NDI sources (PTZ preview in the UI, seat thumbnails).
 *
 * - One low-bandwidth receiver per source (the camera's proxy stream, e.g.
 *   640x360), created on first use and kept while it is being polled; closed
 *   after idleMs without a grab so it stops pulling video.
 * - Grabs on one receiver are serialised. Queued frames are drained so the
 *   newest one is returned, not one from a second ago.
 * - Never blocks the event loop: waits for frames on a koffi worker thread.
 */
import type { NdiService } from './service.js';
import type { NdiApi, NdiVideoFrame } from './runtime.js';

export interface FrameSource {
  /** Newest frame of the named NDI source (null on timeout). Throws if NDI is unavailable or the source is unknown. */
  grab(sourceName: string): Promise<NdiVideoFrame | null>;
}

interface Receiver {
  recv: unknown;
  url: string | null;
  frames: number;
  chain: Promise<unknown>;
  idle: NodeJS.Timeout | null;
}

export interface FrameGrabberOptions {
  /** Close a receiver after this long without a grab. */
  idleMs?: number;
  /** Frames to discard on a fresh receiver (decoder warm-up). */
  warmupFrames?: number;
  timeoutMs?: number;
}

export class NdiFrameGrabber implements FrameSource {
  private recvs = new Map<string, Receiver>();
  private o: Required<FrameGrabberOptions>;

  constructor(
    private ndi: Pick<NdiService, 'api' | 'resolve'>,
    opts: FrameGrabberOptions = {},
  ) {
    this.o = { idleMs: 20_000, warmupFrames: 2, timeoutMs: 2500, ...opts };
  }

  private get api(): NdiApi {
    if (!this.ndi.api) throw new Error('NDI runtime not available');
    return this.ndi.api;
  }

  private receiver(name: string): Receiver {
    const src = this.ndi.resolve(name);
    if (!src) throw new Error(`NDI source "${name}" not discovered (yet)`);
    let r = this.recvs.get(name);
    if (r && r.url !== src.url) {
      this.drop(name);
      r = undefined;
    }
    if (!r) {
      const recv = this.api.recvCreate(src, { bandwidth: 'lowest', name: 'Switchy preview' });
      if (!recv) throw new Error(`could not create an NDI receiver for "${name}"`);
      r = { recv, url: src.url, frames: 0, chain: Promise.resolve(), idle: null };
      this.recvs.set(name, r);
    }
    if (r.idle) clearTimeout(r.idle);
    r.idle = setTimeout(() => this.drop(name), this.o.idleMs);
    r.idle.unref?.();
    return r;
  }

  grab(sourceName: string): Promise<NdiVideoFrame | null> {
    const r = this.receiver(sourceName);
    const run = () => this.capture(r);
    const p = r.chain.then(run, run);
    r.chain = p.catch(() => undefined);
    return p;
  }

  private async capture(r: Receiver): Promise<NdiVideoFrame | null> {
    const api = this.api;
    // newest queued frame (older ones are dropped uncopied)
    const latest = api.recvCaptureLatest(r.recv);
    if (latest) r.frames += 1;
    if (latest && r.frames > this.o.warmupFrames) return latest;
    const deadline = Date.now() + this.o.timeoutMs;
    while (Date.now() < deadline) {
      const f = await api.recvCaptureVideo(r.recv, Math.max(1, Math.min(500, deadline - Date.now())));
      if (!f) continue;
      r.frames++;
      if (r.frames > this.o.warmupFrames) return f;
    }
    return null;
  }

  private drop(name: string) {
    const r = this.recvs.get(name);
    if (!r) return;
    this.recvs.delete(name);
    if (r.idle) clearTimeout(r.idle);
    // destroy only after any in-flight capture on this receiver finished
    void r.chain.then(() => this.ndi.api?.recvDestroy(r.recv));
  }

  close(): void {
    for (const name of [...this.recvs.keys()]) this.drop(name);
  }
}
