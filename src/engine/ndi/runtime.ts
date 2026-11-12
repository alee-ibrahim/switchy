/**
 * Dynamic loader for the NDI(R) runtime library.
 *
 * The NDI SDK/runtime is proprietary and is NOT part of this repository. We
 * never vendor its binaries or headers. Instead we locate the runtime that the
 * user installed (NDI Tools / NDI Runtime / NDI SDK) and bind the handful of C
 * functions we need with koffi, using our own minimal declarations of the
 * public C ABI. Same approach as DistroAV (obs-ndi).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import koffi from 'koffi';

export interface NdiSource {
  name: string;
  url: string | null;
}

/** One decoded video frame, copied out of NDI memory. 4 bytes per pixel. */
export interface NdiVideoFrame {
  width: number;
  height: number;
  /** 'RGBA' | 'RGBX' | 'BGRA' | 'BGRX' (with the RGBX_RGBA colour format it is RGBA/RGBX). */
  fourcc: string;
  stride: number;
  data: Buffer;
}

export interface NdiApi {
  version: string;
  libraryPath: string;
  findCreate(opts: { showLocal: boolean; groups?: string | null; extraIps?: string | null }): unknown;
  findWait(finder: unknown, timeoutMs: number): boolean;
  findSources(finder: unknown): NdiSource[];
  findDestroy(finder: unknown): void;
  routingCreate(name: string, groups?: string | null): unknown;
  routingChange(router: unknown, src: NdiSource): boolean;
  routingClear(router: unknown): boolean;
  routingConnections(router: unknown, timeoutMs: number): number;
  routingDestroy(router: unknown): void;
  /** Receiver delivering RGBX/RGBA frames. bandwidth 'lowest' = proxy stream (e.g. 640x360). */
  recvCreate(src: NdiSource, opts: { bandwidth: 'lowest' | 'highest'; name: string }): unknown;
  /** Wait up to timeoutMs for a video frame (runs on a worker thread; never blocks the event loop). */
  recvCaptureVideo(recv: unknown, timeoutMs: number): Promise<NdiVideoFrame | null>;
  /**
   * Drain the receiver's queue without waiting and return the newest frame
   * (older ones are released uncopied). null if nothing was queued.
   */
  recvCaptureLatest(recv: unknown): NdiVideoFrame | null;
  recvDestroy(recv: unknown): void;
}

// NDIlib_video_frame_v2_t on 64-bit: xres@0 yres@4 FourCC@8 frame_rate_N@12 frame_rate_D@16
// aspect(float)@20 frame_format_type@24 (pad) timecode(int64)@32 p_data@40 line_stride@48
// p_metadata@56 timestamp@64 -> 72 bytes.
const VIDEO_FRAME_SIZE = 72;
const FRAME_TYPE_VIDEO = 1;
const COLOR_RGBX_RGBA = 2;
const BANDWIDTH = { lowest: 0, highest: 100 } as const;

function libFileNames(): string[] {
  switch (process.platform) {
    case 'win32':
      return [process.arch === 'ia32' ? 'Processing.NDI.Lib.x86.dll' : 'Processing.NDI.Lib.x64.dll'];
    case 'darwin':
      return ['libndi.dylib', 'libndi_advanced.dylib'];
    default:
      return ['libndi.so.6', 'libndi.so.5', 'libndi.so'];
  }
}

/** Candidate directories, most specific first. */
export function candidateDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = [];
  for (const k of ['NDI_RUNTIME_DIR', 'NDI_RUNTIME_DIR_V6', 'NDI_RUNTIME_DIR_V5']) {
    if (env[k]) dirs.push(env[k]!);
  }
  if (process.platform === 'win32') {
    const pf = env['ProgramFiles'] ?? 'C:\\Program Files';
    dirs.push(
      path.join(pf, 'NDI', 'NDI 6 Runtime', 'v6'),
      path.join(pf, 'NDI', 'NDI 6 Tools', 'Runtime'),
      path.join(pf, 'NDI', 'NDI 6 SDK', 'Bin', 'x64'),
      path.join(pf, 'NDI', 'NDI 5 Runtime', 'v5'),
    );
  } else if (process.platform === 'darwin') {
    dirs.push('/Library/NDI SDK for Apple/lib/macOS', '/usr/local/lib', '/opt/homebrew/lib');
  } else {
    dirs.push('/usr/lib', '/usr/local/lib', '/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/opt/ndi/lib');
  }
  return dirs;
}

export function locateRuntime(env: NodeJS.ProcessEnv = process.env): string | null {
  const names = libFileNames();
  for (const d of candidateDirs(env)) {
    for (const n of names) {
      const p = path.join(d, n);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

let cached: NdiApi | null | undefined;
let loadError: string | null = null;

export function ndiLoadError(): string | null {
  return loadError;
}

/** Load and initialise the NDI runtime. Returns null (and records why) if unavailable. */
export function loadNdi(env: NodeJS.ProcessEnv = process.env): NdiApi | null {
  if (cached !== undefined) return cached;
  const libPath = locateRuntime(env);
  if (!libPath) {
    loadError =
      'NDI runtime not found. Install NDI Tools or the NDI Runtime (https://ndi.video/tools/) or set NDI_RUNTIME_DIR. Searched: ' +
      candidateDirs(env).join(os.platform() === 'win32' ? '; ' : ':');
    cached = null;
    return null;
  }
  try {
    // On Windows the runtime DLL may depend on siblings in the same folder.
    if (process.platform === 'win32') {
      const dir = path.dirname(libPath);
      if (!(process.env.PATH ?? '').includes(dir)) process.env.PATH = `${dir};${process.env.PATH ?? ''}`;
    }
    const lib = koffi.load(libPath);

    // Minimal hand-written declarations of the public NDI C ABI.
    const NDIlib_source_t = koffi.struct('cs_NDIlib_source_t', {
      p_ndi_name: 'const char *',
      p_url_address: 'const char *', // union with p_ip_address (same pointer)
    });
    const NDIlib_find_create_t = koffi.struct('cs_NDIlib_find_create_t', {
      show_local_sources: 'bool',
      p_groups: 'const char *',
      p_extra_ips: 'const char *',
    });
    const NDIlib_routing_create_t = koffi.struct('cs_NDIlib_routing_create_t', {
      p_ndi_name: 'const char *',
      p_groups: 'const char *',
    });
    const handle = koffi.pointer('cs_NDIlib_instance', koffi.opaque());

    const initialize = lib.func('bool NDIlib_initialize()');
    const version = lib.func('const char * NDIlib_version()');
    const find_create_v2 = lib.func('NDIlib_find_create_v2', handle, [koffi.pointer(NDIlib_find_create_t)]);
    const find_destroy = lib.func('NDIlib_find_destroy', 'void', [handle]);
    const find_wait = lib.func('NDIlib_find_wait_for_sources', 'bool', [handle, 'uint32_t']);
    const find_get = lib.func('NDIlib_find_get_current_sources', 'void *', [handle, koffi.out(koffi.pointer('uint32_t'))]);
    const routing_create = lib.func('NDIlib_routing_create', handle, [koffi.pointer(NDIlib_routing_create_t)]);
    const routing_destroy = lib.func('NDIlib_routing_destroy', 'void', [handle]);
    const routing_change = lib.func('NDIlib_routing_change', 'bool', [handle, koffi.pointer(NDIlib_source_t)]);
    const routing_clear = lib.func('NDIlib_routing_clear', 'bool', [handle]);
    const routing_conns = lib.func('NDIlib_routing_get_no_connections', 'int', [handle, 'uint32_t']);
    const NDIlib_recv_create_v3_t = koffi.struct('cs_NDIlib_recv_create_v3_t', {
      source_to_connect_to: NDIlib_source_t,
      color_format: 'int',
      bandwidth: 'int',
      allow_video_fields: 'bool',
      p_ndi_recv_name: 'const char *',
    });
    const recv_create = lib.func('NDIlib_recv_create_v3', handle, [koffi.pointer(NDIlib_recv_create_v3_t)]);
    const recv_destroy = lib.func('NDIlib_recv_destroy', 'void', [handle]);
    const recv_capture = lib.func('NDIlib_recv_capture_v3', 'int', [handle, 'void *', 'void *', 'void *', 'uint32_t']);
    const recv_free_video = lib.func('NDIlib_recv_free_video_v2', 'void', [handle, 'void *']);

    /** Copy the frame in `buf` out of NDI memory, then hand it back to NDI. */
    const takeFrame = (recv: unknown, buf: Buffer): NdiVideoFrame | null => {
      try {
        const width = buf.readInt32LE(0);
        const height = buf.readInt32LE(4);
        const fourcc = buf.subarray(8, 12).toString('latin1');
        const stride = buf.readInt32LE(48);
        const ptr = koffi.decode(buf, 40, 'void *');
        if (!ptr || width <= 0 || height <= 0 || stride < width * 4) return null;
        // copy: koffi.view() is a window onto NDI's buffer, which is freed below
        // (Buffer.from(ArrayBuffer) would only wrap it and read freed memory later)
        const data = Buffer.from(new Uint8Array(koffi.view(ptr, stride * height) as ArrayBuffer));
        return { width, height, fourcc, stride, data };
      } finally {
        recv_free_video(recv, buf);
      }
    };

    if (!initialize()) {
      loadError = 'NDIlib_initialize() returned false (CPU not supported?)';
      cached = null;
      return null;
    }

    cached = {
      version: String(version() ?? 'unknown'),
      libraryPath: libPath,
      findCreate: ({ showLocal, groups, extraIps }) =>
        find_create_v2({ show_local_sources: showLocal, p_groups: groups ?? null, p_extra_ips: extraIps ?? null }),
      findWait: (f, t) => find_wait(f, t),
      findSources: (f) => {
        const count = [0];
        const ptr = find_get(f, count);
        const n = count[0] ?? 0;
        if (!ptr || n === 0) return [];
        const arr = koffi.decode(ptr, koffi.array(NDIlib_source_t, n)) as Array<{ p_ndi_name: string; p_url_address: string | null }>;
        return arr.map((s) => ({ name: s.p_ndi_name, url: s.p_url_address ?? null }));
      },
      findDestroy: (f) => find_destroy(f),
      routingCreate: (name, groups) => routing_create({ p_ndi_name: name, p_groups: groups ?? null }),
      routingChange: (r, s) => routing_change(r, { p_ndi_name: s.name, p_url_address: s.url }),
      routingClear: (r) => routing_clear(r),
      routingConnections: (r, t) => routing_conns(r, t),
      routingDestroy: (r) => routing_destroy(r),
      recvCreate: (src, o) =>
        recv_create({
          source_to_connect_to: { p_ndi_name: src.name, p_url_address: src.url },
          color_format: COLOR_RGBX_RGBA,
          bandwidth: BANDWIDTH[o.bandwidth],
          allow_video_fields: false,
          p_ndi_recv_name: o.name,
        }),
      recvCaptureVideo: (recv, timeoutMs) =>
        new Promise((resolve, reject) => {
          const buf = Buffer.alloc(VIDEO_FRAME_SIZE + 56);
          recv_capture.async(recv, buf, null, null, timeoutMs, (err: unknown, type: number) => {
            if (err) return reject(err as Error);
            resolve(type === FRAME_TYPE_VIDEO ? takeFrame(recv, buf) : null);
          });
        }),
      recvCaptureLatest: (recv) => {
        let held: Buffer | null = null;
        for (let i = 0; i < 120; i++) {
          const buf = Buffer.alloc(VIDEO_FRAME_SIZE + 56);
          const type = recv_capture(recv, buf, null, null, 0);
          if (type === 0) break; // nothing queued
          if (type !== FRAME_TYPE_VIDEO) continue; // status change etc.
          if (held) recv_free_video(recv, held);
          held = buf;
        }
        return held ? takeFrame(recv, held) : null;
      },
      recvDestroy: (r) => recv_destroy(r),
    };
    loadError = null;
    return cached;
  } catch (e) {
    loadError = `Failed to load NDI runtime from ${libPath}: ${(e as Error).message}`;
    cached = null;
    return null;
  }
}
