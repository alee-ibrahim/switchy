import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  Save,
  ScanFace,
  Square,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AspectRatio } from '@/components/ui/aspect-ratio'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Spinner } from '@/components/ui/spinner'
import { api, calibrationOf, snapshotUrl, type Camera, type JogDir, type Room, type RoomState } from '@/lib/api'

/** Re-fetch an NDI frame grab about once a second while mounted and the tab is visible. */
function useLivePreview(roomId: string, cameraId: string) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let stopped = false
    let url: string | null = null
    let timer: number | undefined
    const tick = async () => {
      const t0 = performance.now()
      if (document.visibilityState === 'visible') {
        try {
          const res = await fetch(snapshotUrl(roomId, cameraId), { cache: 'no-store' })
          if (!res.ok) {
            const j = await res.json().catch(() => null)
            throw new Error(j?.error ?? `HTTP ${res.status}`)
          }
          const blob = await res.blob()
          if (stopped) return
          const next = URL.createObjectURL(blob)
          if (url) URL.revokeObjectURL(url)
          url = next
          setSrc(next)
          setError(null)
        } catch (e) {
          if (!stopped) setError((e as Error).message)
        }
      }
      if (!stopped) timer = window.setTimeout(tick, Math.max(250, 1000 - (performance.now() - t0)))
    }
    void tick()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      if (url) URL.revokeObjectURL(url)
    }
  }, [roomId, cameraId])
  return { src, error }
}

type Dir = { pan: JogDir; tilt: JogDir; zoom: JogDir }

/**
 * Hold-to-move. Re-sends the jog state every 250 ms while held (the server stops the
 * camera if that keep-alive stops for 800 ms) and sends an explicit stop on release.
 */
function useJog(roomId: string, cameraId: string, speed: number) {
  const active = useRef<Dir | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const speedRef = useRef(speed)
  const failed = useRef(false)
  useEffect(() => {
    speedRef.current = speed
  }, [speed])

  const send = (d: Dir) =>
    api.jog(roomId, cameraId, { ...d, speed: speedRef.current }).catch((e: Error) => {
      if (!failed.current) toast.error(`PTZ: ${e.message}`)
      failed.current = true
    })

  const stop = () => {
    window.clearInterval(timer.current)
    timer.current = undefined
    if (!active.current) return
    active.current = null
    api.stop(roomId, cameraId).catch((e: Error) => toast.error(`PTZ stop: ${e.message}`))
  }

  const start = (d: Dir) => {
    window.clearInterval(timer.current)
    failed.current = false
    active.current = d
    void send(d)
    timer.current = window.setInterval(() => active.current && void send(active.current), 250)
  }

  const stopRef = useRef(stop)
  useEffect(() => {
    stopRef.current = stop
  })
  useEffect(() => {
    const onHide = () => stopRef.current()
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onHide)
    window.addEventListener('blur', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('blur', onHide)
      stopRef.current()
    }
  }, [])

  /** Props that make a button hold-to-move (mouse, touch, pen and keyboard). */
  const hold = (d: Dir) => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      start(d)
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onLostPointerCapture: stop,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) start(d)
    },
    onKeyUp: stop,
    onBlur: stop,
  })

  return { hold, stop }
}

const PAD: Array<{ d: Dir; icon: React.ReactNode; label: string }> = [
  { d: { pan: -1, tilt: 1, zoom: 0 }, icon: <ArrowUpLeft />, label: 'Up left' },
  { d: { pan: 0, tilt: 1, zoom: 0 }, icon: <ArrowUp />, label: 'Up' },
  { d: { pan: 1, tilt: 1, zoom: 0 }, icon: <ArrowUpRight />, label: 'Up right' },
  { d: { pan: -1, tilt: 0, zoom: 0 }, icon: <ArrowLeft />, label: 'Left' },
  { d: { pan: 0, tilt: 0, zoom: 0 }, icon: <Square />, label: 'Stop' },
  { d: { pan: 1, tilt: 0, zoom: 0 }, icon: <ArrowRight />, label: 'Right' },
  { d: { pan: -1, tilt: -1, zoom: 0 }, icon: <ArrowDownLeft />, label: 'Down left' },
  { d: { pan: 0, tilt: -1, zoom: 0 }, icon: <ArrowDown />, label: 'Down' },
  { d: { pan: 1, tilt: -1, zoom: 0 }, icon: <ArrowDownRight />, label: 'Down right' },
]

const AUTO = 'auto'

export function PtzPanel({
  room,
  state,
  camera,
  onSaved,
}: {
  room: Room
  state: RoomState | null
  camera: Camera
  onSaved: () => void
}) {
  const [speed, setSpeed] = useState(30)
  const { src, error } = useLivePreview(room.id, camera.id)
  const { hold, stop } = useJog(room.id, camera.id, speed)
  const [unitChoice, setUnitChoice] = useState<string>(AUTO)
  const [preset, setPreset] = useState('')
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)

  const micsOn = state?.micsOn ?? []
  const seatOf = (u: number) => room.seats.find((s) => s.unit === u)
  const nameOf = (u: number) => seatOf(u)?.label || `Unit ${u}`
  const units = [...new Set([...room.seats.map((s) => s.unit), ...micsOn])].sort((a, b) => a - b)
  const unit: number | null = unitChoice === AUTO ? (micsOn.length === 1 ? micsOn[0]! : null) : Number(unitChoice)
  const effectivePreset = preset.trim() || (unit !== null ? String(unit) : '')

  // a different seat selected: forget typed overrides
  const [prevUnit, setPrevUnit] = useState(unit)
  if (prevUnit !== unit) {
    setPrevUnit(unit)
    setPreset('')
    setLabel('')
  }

  const [framing, setFraming] = useState(false)
  const autoFrame = async () => {
    setFraming(true)
    try {
      const r = await api.autoframe(room.id, camera.id)
      if (r.adjusted) toast.success(`Auto-frame: ${r.detail}`)
      else toast.info(`Auto-frame: ${r.detail}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setFraming(false)
    }
  }

  const save = async () => {
    if (unit === null) return
    setSaving(true)
    try {
      const r = await api.savePreset(room.id, {
        cameraId: camera.id,
        unit,
        preset: preset.trim() || undefined,
        label: label.trim() || undefined,
      })
      if (r.thumbnail) toast.success(`Saved preset ${r.preset} for ${r.seat.label} (#${r.unit})`)
      else toast.warning(`Saved preset ${r.preset} for ${r.seat.label} (#${r.unit}), but no thumbnail: ${r.thumbnailError}`)
      setPreset('')
      setLabel('')
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const autoText =
    micsOn.length === 1
      ? `Mic on: ${nameOf(micsOn[0]!)} (#${micsOn[0]})`
      : micsOn.length === 0
        ? 'Mic on: none yet'
        : `Mics on: ${micsOn.join(', ')} (leave only one on)`

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border bg-muted">
        <AspectRatio ratio={16 / 9}>
          {src ? (
            <img src={src} alt={`${camera.name} preview`} className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
              {error ? error : <><Spinner /> Loading preview...</>}
            </div>
          )}
        </AspectRatio>
      </div>
      {error && src && <p className="text-xs text-destructive">Preview: {error}</p>}
      {state && !state.paused && (
        <Alert>
          <AlertDescription>
            Automation is running: a mic change can move this camera while you aim. Turn Automation off while saving presets.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:justify-center sm:gap-8">
        <div className="grid grid-cols-3 gap-2">
          {PAD.map(({ d, icon, label: l }) =>
            d.pan === 0 && d.tilt === 0 ? (
              <Button key={l} variant="secondary" aria-label={l} className="size-16 touch-none select-none" onClick={stop}>
                {icon}
              </Button>
            ) : (
              <Button key={l} variant="outline" aria-label={l} className="size-16 touch-none select-none [&_svg:not([class*='size-'])]:size-6" {...hold(d)}>
                {icon}
              </Button>
            ),
          )}
        </div>
        <div className="flex w-full max-w-60 flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" className="h-16 touch-none select-none" {...hold({ pan: 0, tilt: 0, zoom: 1 })}>
              <ZoomIn /> Zoom in
            </Button>
            <Button variant="outline" className="h-16 touch-none select-none" {...hold({ pan: 0, tilt: 0, zoom: -1 })}>
              <ZoomOut /> Zoom out
            </Button>
          </div>
          <Button
            variant="outline"
            className="h-12"
            disabled={framing || !calibrationOf(camera)}
            onClick={autoFrame}
            title={calibrationOf(camera) ? 'Frame the person in view head-and-shoulders (one move)' : 'Calibrate this camera in the room editor first'}
          >
            {framing ? <Spinner /> : <ScanFace />} Auto-frame
          </Button>
          <Field>
            <FieldLabel>Speed: {speed}%</FieldLabel>
            <Slider min={1} max={100} step={1} value={[speed]} onValueChange={(v) => setSpeed(v[0] ?? 30)} />
            <FieldDescription>Hold an arrow to move; release to stop.</FieldDescription>
          </Field>
        </div>
      </div>

      <Separator />

      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel>Seat</FieldLabel>
          <Select value={unitChoice} onValueChange={setUnitChoice}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>{autoText}</SelectItem>
              {units.map((u) => (
                <SelectItem key={u} value={String(u)}>
                  {nameOf(u)} (#{u}){seatOf(u)?.preset ? ` - preset ${seatOf(u)!.preset}` : ''}
                  {micsOn.includes(u) ? ' - mic on' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            Default: the seat whose mic is on. Or pick a unit from the list.
          </FieldDescription>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`preset-${camera.id}`}>Preset number</FieldLabel>
            <Input
              id={`preset-${camera.id}`}
              inputMode="numeric"
              placeholder={unit !== null ? String(unit) : 'same as unit'}
              value={preset}
              onChange={(e) => setPreset(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`label-${camera.id}`}>Label (optional)</FieldLabel>
            <Input
              id={`label-${camera.id}`}
              placeholder={unit !== null ? (seatOf(unit)?.label || `Seat ${unit}`) : 'e.g. Chair'}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
        </div>
        <Button size="lg" className="h-12" disabled={unit === null || saving} onClick={save}>
          {saving ? <Spinner /> : <Save />}
          {unit === null
            ? micsOn.length > 1
              ? 'Several mics on: pick the seat'
              : 'Switch a mic on or pick a seat'
            : `Save preset ${effectivePreset} for ${nameOf(unit)} (#${unit})`}
        </Button>
        {unit !== null && seatOf(unit)?.preset && seatOf(unit)!.preset !== effectivePreset && (
          <Badge variant="outline" className="self-start">
            replaces the seat's mapping to preset {seatOf(unit)!.preset}
          </Badge>
        )}
      </FieldGroup>
    </div>
  )
}
