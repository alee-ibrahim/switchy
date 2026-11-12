export type CameraDriverKind = 'birddog' | 'visca' | 'none'
export type CameraRole = 'wide' | 'ptz' | 'both'

export interface Camera {
  id: string
  name: string
  driver: CameraDriverKind
  host: string
  port: number | null
  role: CameraRole
  ndiSource: string
  settleMs: number
  homePreset: string | null
  credentialsRef: string | null
  options: Record<string, unknown>
}

export interface Seat {
  unit: number
  label: string
  cameraId: string
  preset: string | null
}

export interface Policy {
  chairUnit: number | null
  chairPriority: boolean
  mode: 'last' | 'first'
  debounceMs: number
  returnToWideMs: number
  oneCameraMove: 'live' | 'holding'
  holdingSource: string
  unmappedSeat: 'wide' | 'ignore'
  refine: 'off' | 'auto-frame' | 'track'
  refineTimeoutMs: number
  refineSavePreset: boolean
  refineDeadbandPct: number
  refineDeadbandVPct: number
  refineMaxCorrectionPct: number
  refineZoom: boolean
  trackDeadzoneXPct: number
  trackDeadzoneYPct: number
  trackMaxSpeed: number
  trackMaxExcursionPct: number
  trackLossTimeoutMs: number
  trackReturnAfterMs: number
  trackZoom: boolean
  trackZoomTolerancePct: number
  trackTightFacePct: number
  trackReacquire: boolean
  trackLostToWideMs: number
  trackBadToWideMs: number
  trackHoldBeforeCutMs: number
  trackMinDwellMs: number
  trackHeadroomPct: number
  trackSeatMinScore: number
  trackFallbackDetector: boolean
  trackLearn: boolean
  trackLearnCapPct: number
  trackLearnSamples: number
  trackLearnMaxOffsetPct: number
  trackLearnMaxSpreadPct: number
  trackBlurRatioPct: number
  autoFrameFallback: 'wide' | 'preset-if-face' | 'preset'
}

export interface Room {
  id: string
  name: string
  enabled: boolean
  dcenHost: string
  dcenPort: number
  outputName: string
  outputMode: 'route'
  cameras: Camera[]
  seats: Seat[]
  policy: Policy
}

export type RoomInput = Omit<Room, 'id'>

export type ProgramTarget = { kind: 'camera'; cameraId: string } | { kind: 'holding' }

export interface LogEvent {
  type: 'log'
  level: 'debug' | 'info' | 'warn' | 'error'
  msg: string
  at: number
}

export interface RoomState {
  id: string
  name: string
  outputName: string
  paused: boolean
  dcenConnected: boolean
  micsOn: number[]
  speaker: number | null
  program: ProgramTarget | null
  programSource: string | null
  moving: { cameraId: string; preset: string | null; unit: number | null } | null
  cameras: Record<string, { lastPreset: string | null; error: string | null }>
  learning: boolean
  tracking: {
    cameraId: string
    unit: number | null
    state: 'acquiring' | 'locked' | 'lost' | 'holding'
    manual: boolean
    since: number
    /** Shot gate: is the PTZ shot good enough for program, and is it on program. */
    gate?: { state: 'searching' | 'good' | 'bad' | 'lost'; reason: string; onPtz: boolean } | null
  } | null
  connections: number
  log: LogEvent[]
}

export interface NdiSource {
  name: string
  url: string | null
}

export interface NdiStatus {
  available: boolean
  version: string | null
  libraryPath: string | null
  error: string | null
  extraIps: string[]
  sources: NdiSource[]
}

export type JogDir = -1 | 0 | 1

export interface JogState {
  pan: JogDir
  tilt: JogDir
  zoom: JogDir
  /** 1-100 */
  speed: number
}

export interface SavePresetInput {
  cameraId: string
  /** omit = the single mic that is on */
  unit?: number
  /** omit = preset number equals the unit */
  preset?: string
  label?: string
}

export interface SavePresetResult {
  ok: true
  unit: number
  preset: string
  seat: Seat
  thumbnail: boolean
  thumbnailError?: string
}

export interface Calibration {
  points: Array<{ zoom: number; dxPerPan: number; dyPerTilt: number }>
  measuredAt?: string
  frameWidth?: number
  frameHeight?: number
}

export interface AutoFrameResult {
  ok: boolean
  adjusted: boolean
  reason: string
  detail: string
  timings: { totalMs: number }
}

/** The camera's stored auto-frame calibration (options.autoframe.calibration), if any. */
export function calibrationOf(cam: Camera): Calibration | null {
  const af = cam.options?.autoframe as { calibration?: Calibration } | undefined
  return af?.calibration?.points?.length ? af.calibration : null
}

export interface Thumbnail {
  unit: number
  updatedAt: number
}

/** A seat's learned correction (track mode): where the delegate really sits relative to the preset aim. */
export interface LearnedSeat {
  unit: number
  label: string
  cameraId: string
  preset: string
  turns: number
  /** null until 2 good turns were seen */
  correction: { x: number; y: number; pan: number; tilt: number; n: number; capped: boolean } | null
  /** false: the seat's preset was changed since; not used */
  current: boolean
  updatedAt: string
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const j = await res.json()
      msg = j.error ?? msg
      if (j.issues) msg += ': ' + j.issues.map((i: { path: unknown[]; message: string }) => `${i.path.join('.')} ${i.message}`).join('; ')
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  rooms: () => req<Room[]>('GET', '/api/rooms'),
  room: (id: string) => req<Room>('GET', `/api/rooms/${id}`),
  createRoom: (r: RoomInput) => req<Room>('POST', '/api/rooms', r),
  updateRoom: (id: string, r: RoomInput) => req<Room>('PUT', `/api/rooms/${id}`, r),
  deleteRoom: (id: string) => req<void>('DELETE', `/api/rooms/${id}`),
  state: (id: string) => req<RoomState>('GET', `/api/rooms/${id}/state`),
  learn: (id: string) => req<{ unit: number | null }>('POST', `/api/rooms/${id}/learn`, { timeoutMs: 30000 }),
  take: (id: string, cameraId: string) => req('POST', `/api/rooms/${id}/take`, { cameraId }),
  takeHolding: (id: string) => req('POST', `/api/rooms/${id}/take`, { holding: true }),
  recall: (id: string, cameraId: string, preset: string) => req('POST', `/api/rooms/${id}/recall`, { cameraId, preset }),
  pause: (id: string, paused: boolean) => req('POST', `/api/rooms/${id}/pause`, { paused }),
  probe: (cam: Camera) => req<{ ok: boolean; model?: string; firmware?: string; error?: string }>('POST', '/api/cameras/probe', cam),
  ndi: () => req<NdiStatus>('GET', '/api/ndi'),
  jog: (id: string, cameraId: string, s: JogState) => req('POST', `/api/rooms/${id}/cameras/${cameraId}/jog`, s),
  stop: (id: string, cameraId: string) => req('POST', `/api/rooms/${id}/cameras/${cameraId}/stop`, {}),
  savePreset: (id: string, b: SavePresetInput) => req<SavePresetResult>('POST', `/api/rooms/${id}/seats/save-preset`, b),
  thumbnails: (id: string) => req<Thumbnail[]>('GET', `/api/rooms/${id}/thumbnails`),
  calibrate: (id: string, cameraId: string) =>
    req<{ ok: true; ms: number; calibration: Calibration }>('POST', `/api/rooms/${id}/cameras/${cameraId}/calibrate`, {}),
  learned: (id: string) => req<LearnedSeat[]>('GET', `/api/rooms/${id}/learned`),
  resetLearned: (id: string, unit?: number) =>
    req<{ ok: true; removed: number }>('DELETE', unit === undefined ? `/api/rooms/${id}/learned` : `/api/rooms/${id}/learned/${unit}`),
  autoframe: (id: string, cameraId: string, dryRun = false) =>
    req<AutoFrameResult>('POST', `/api/rooms/${id}/cameras/${cameraId}/autoframe`, { dryRun }),
}

export const snapshotUrl = (roomId: string, cameraId: string, width = 640) =>
  `/api/rooms/${roomId}/cameras/${cameraId}/snapshot.jpg?w=${width}`

export const thumbnailUrl = (roomId: string, unit: number, version: number) =>
  `/api/rooms/${roomId}/seats/${unit}/thumbnail.jpg?v=${version}`

/** Seat thumbnails of a room as unit -> image URL (re-fetch after saving a preset). */
export async function thumbnailMap(roomId: string): Promise<Map<number, string>> {
  const list = await api.thumbnails(roomId)
  return new Map(list.map((t) => [t.unit, thumbnailUrl(roomId, t.unit, t.updatedAt)]))
}

/** Random id that also works on plain http (crypto.randomUUID needs a secure context). */
export function uid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export function hexUnit(unit: number): string {
  return unit.toString(16).toUpperCase().padStart(4, '0')
}

export function defaultPolicy(): Policy {
  return {
    chairUnit: null,
    chairPriority: false,
    mode: 'last',
    debounceMs: 300,
    returnToWideMs: 3000,
    oneCameraMove: 'live',
    holdingSource: '',
    unmappedSeat: 'wide',
    refine: 'off',
    refineTimeoutMs: 4000,
    refineSavePreset: false,
    refineDeadbandPct: 8,
    refineDeadbandVPct: 10,
    refineMaxCorrectionPct: 15,
    refineZoom: false,
    trackDeadzoneXPct: 10,
    trackDeadzoneYPct: 12,
    trackMaxSpeed: 5,
    trackMaxExcursionPct: 35,
    trackLossTimeoutMs: 1500,
    trackReturnAfterMs: 0,
    trackZoom: false,
    trackZoomTolerancePct: 15,
    trackTightFacePct: 35,
    trackReacquire: true,
    trackLostToWideMs: 700,
    trackBadToWideMs: 700,
    trackHoldBeforeCutMs: 400,
    trackMinDwellMs: 2000,
    trackHeadroomPct: 5,
    trackSeatMinScore: 0.5,
    trackFallbackDetector: true,
    trackLearn: true,
    trackLearnCapPct: 10,
    trackLearnSamples: 5,
    trackLearnMaxOffsetPct: 35,
    trackLearnMaxSpreadPct: 8,
    trackBlurRatioPct: 30,
    autoFrameFallback: 'preset-if-face',
  }
}

export function newCamera(role: CameraRole): Camera {
  return {
    id: uid(),
    name: role === 'wide' ? 'Wide' : 'PTZ',
    driver: 'birddog',
    host: '',
    port: null,
    role,
    ndiSource: '',
    settleMs: role === 'wide' ? 0 : 2500,
    homePreset: null,
    credentialsRef: null,
    options: {},
  }
}
