import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'
import { Crosshair, Mic, MicOff, Pencil, Radio, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { AspectRatio } from '@/components/ui/aspect-ratio'
import { PtzPanel } from '@/components/ptz-panel'
import { api, hexUnit, thumbnailMap, type Camera, type Room, type RoomState } from '@/lib/api'
import { useEvents } from '@/hooks/use-events'

function presetsFor(room: Room, cam: Camera): string[] {
  const s = new Set<string>()
  if (cam.homePreset) s.add(cam.homePreset)
  for (const seat of room.seats) if (seat.cameraId === cam.id && seat.preset) s.add(seat.preset)
  return [...s].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

export function RoomLivePage() {
  const { id = '' } = useParams()
  const [room, setRoom] = useState<Room | null>(null)
  const [state, setState] = useState<RoomState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [manualPreset, setManualPreset] = useState<Record<string, string>>({})
  const [showDebug, setShowDebug] = useState(false)
  const [aimCam, setAimCam] = useState<string | null>(null)
  const [thumbs, setThumbs] = useState<Map<number, string>>(new Map())
  const pending = useRef<number | null>(null)

  const refresh = useCallback(() => {
    api
      .state(id)
      .then((s) => {
        setState(s)
        setError(null)
      })
      .catch((e) => setError(e.message))
  }, [id])

  const loadRoom = useCallback(() => {
    api.room(id).then(setRoom).catch((e) => setError(e.message))
    thumbnailMap(id).then(setThumbs).catch(() => undefined)
  }, [id])

  useEffect(() => {
    loadRoom()
    refresh()
  }, [loadRoom, refresh])

  useEvents(
    () => {
      if (pending.current) return
      pending.current = window.setTimeout(() => {
        pending.current = null
        refresh()
      }, 120)
    },
    { room: id },
  )

  const seatLabel = useMemo(() => {
    const m = new Map<number, string>()
    room?.seats.forEach((s) => m.set(s.unit, s.label || `Unit ${s.unit}`))
    return m
  }, [room])

  const run = async (p: Promise<unknown>, ok?: string) => {
    try {
      await p
      if (ok) toast.success(ok)
      refresh()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  if (!room) return error ? <Alert variant="destructive"><AlertTitle>Error</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : <Spinner />

  const camName = (cid: string) => room.cameras.find((c) => c.id === cid)?.name ?? cid
  const programLabel = !state?.program
    ? 'nothing yet'
    : state.program.kind === 'holding'
      ? 'Holding source'
      : camName(state.program.cameraId)
  const units = [...new Set([...room.seats.map((s) => s.unit), ...(state?.micsOn ?? [])])].sort((a, b) => a - b)
  const log = (state?.log ?? []).filter((l) => showDebug || l.level !== 'debug').slice().reverse()

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{room.name}</h1>
        {state && (
          <Badge variant={state.dcenConnected ? 'secondary' : 'destructive'}>
            DCen {state.dcenConnected ? 'connected' : 'offline'}
          </Badge>
        )}
        {state?.paused && <Badge variant="destructive">automation paused</Badge>}
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id="auto"
              checked={!!state && !state.paused}
              disabled={!state}
              onCheckedChange={(v) => run(api.pause(id, !v))}
            />
            <Label htmlFor="auto">Automation</Label>
          </div>
          <Button variant="outline" asChild>
            <Link to={`/rooms/${id}/edit`}>
              <Pencil /> Edit
            </Link>
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Room not running</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Radio className="size-4" /> Program
            </CardTitle>
            <CardDescription>
              NDI output "{room.outputName}" {state ? `- ${state.connections} receiver(s)` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <div className="text-xl font-semibold">{programLabel}</div>
            <div className="text-sm text-muted-foreground">{state?.programSource ?? 'no source'}</div>
            {state?.moving && (
              <div className="flex items-center gap-2 text-sm">
                <Spinner /> Moving {camName(state.moving.cameraId)}
                {state.moving.preset ? ` to preset ${state.moving.preset}` : ''}
              </div>
            )}
            {state?.tracking && (
              <div className="flex items-center gap-2 text-sm">
                <Badge
                  variant={
                    state.tracking.state === 'locked' ? 'default' : state.tracking.state === 'acquiring' ? 'secondary' : 'destructive'
                  }
                >
                  tracking: {state.tracking.state === 'acquiring' ? 'searching' : state.tracking.state}
                </Badge>
                <span className="text-muted-foreground">
                  {camName(state.tracking.cameraId)}
                  {state.tracking.manual ? ' (test)' : ''}
                </span>
              </div>
            )}
            {state?.tracking?.gate && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={state.tracking.gate.state === 'good' ? 'default' : state.tracking.gate.state === 'searching' ? 'secondary' : 'destructive'}>
                  shot: {state.tracking.gate.state}
                </Badge>
                <Badge variant="outline">{state.tracking.gate.onPtz ? 'on PTZ' : 'on wide'}</Badge>
                <span className="text-muted-foreground">{state.tracking.gate.reason}</span>
              </div>
            )}
            <div className="text-sm">
              Speaker: {state?.speaker != null ? (seatLabel.get(state.speaker) ?? `Unit ${state.speaker}`) : 'none'}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Microphones</CardTitle>
            <CardDescription>Live from the DCen</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {units.length === 0 && <span className="text-sm text-muted-foreground">No seats mapped yet.</span>}
            {units.map((u) => {
              const on = state?.micsOn.includes(u)
              return (
                <Badge key={u} variant={on ? 'default' : 'outline'} className="h-7 px-3 text-sm">
                  {on ? <Mic /> : <MicOff />}
                  {seatLabel.get(u) ?? `Unit ${u} (unmapped)`}
                  <span className="opacity-60">#{u}</span>
                </Badge>
              )
            })}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {room.cameras.map((cam) => {
          const cs = state?.cameras[cam.id]
          const onAir = state?.program?.kind === 'camera' && state.program.cameraId === cam.id
          return (
            <Card key={cam.id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {cam.name}
                  <Badge variant="outline">{cam.role}</Badge>
                  {onAir && <Badge variant="destructive">on program</Badge>}
                </CardTitle>
                <CardDescription>
                  {cam.ndiSource || 'no NDI source'} - {cam.driver} {cam.host}
                </CardDescription>
                <CardAction className="flex gap-2">
                  {cam.role !== 'wide' && cam.driver !== 'none' && (
                    <Button
                      size="sm"
                      variant={aimCam === cam.id ? 'secondary' : 'outline'}
                      onClick={() => setAimCam(aimCam === cam.id ? null : cam.id)}
                    >
                      {aimCam === cam.id ? <X /> : <Crosshair />} {aimCam === cam.id ? 'Close' : 'Aim & save'}
                    </Button>
                  )}
                  <Button size="sm" disabled={onAir} onClick={() => run(api.take(id, cam.id), `${cam.name} on program`)}>
                    Take
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {aimCam === cam.id && <PtzPanel room={room} state={state} camera={cam} onSaved={loadRoom} />}
                <div className="text-sm">
                  Last preset: {cs?.lastPreset ?? '-'}
                  {cs?.error && <span className="text-destructive"> - {cs.error}</span>}
                </div>
                {cam.driver !== 'none' && (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {presetsFor(room, cam).map((p) => (
                        <Button
                          key={p}
                          size="sm"
                          variant={cs?.lastPreset === p ? 'secondary' : 'outline'}
                          onClick={() => run(api.recall(id, cam.id, p))}
                        >
                          Preset {p}
                        </Button>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Input
                        placeholder="Preset number"
                        value={manualPreset[cam.id] ?? ''}
                        onChange={(e) => setManualPreset((m) => ({ ...m, [cam.id]: e.target.value }))}
                        className="max-w-40"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!manualPreset[cam.id]}
                        onClick={() => run(api.recall(id, cam.id, manualPreset[cam.id]!))}
                      >
                        Recall
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      {room.seats.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Seats</CardTitle>
            <CardDescription>Tap a seat to recall its preset. Re-aim and save from "Aim & save" on the PTZ camera.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {room.seats.map((s) => {
              const on = state?.micsOn.includes(s.unit)
              const thumb = thumbs.get(s.unit)
              return (
                <Button
                  key={s.unit}
                  variant={on ? 'secondary' : 'outline'}
                  className="h-auto flex-col items-stretch gap-1.5 p-1.5 text-left whitespace-normal"
                  disabled={!s.preset}
                  onClick={() => s.preset && run(api.recall(id, s.cameraId, s.preset), `${s.label || `Unit ${s.unit}`}: preset ${s.preset}`)}
                >
                  <div className="overflow-hidden rounded-md bg-muted">
                    <AspectRatio ratio={16 / 9}>
                      {thumb ? (
                        <img src={thumb} alt={s.label} loading="lazy" className="size-full object-cover" />
                      ) : (
                        <div className="flex size-full items-center justify-center text-xs text-muted-foreground">no picture</div>
                      )}
                    </AspectRatio>
                  </div>
                  <div className="flex items-center gap-1 px-0.5">
                    {on ? <Mic /> : null}
                    <span className="truncate font-medium">{s.label || `Unit ${s.unit}`}</span>
                  </div>
                  <span className="px-0.5 text-xs text-muted-foreground">
                    #{s.unit} - {camName(s.cameraId)} {s.preset ? `preset ${s.preset}` : 'no preset'}
                  </span>
                </Button>
              )
            })}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Event log</CardTitle>
          <CardAction>
            <div className="flex items-center gap-2">
              <Switch id="dbg" checked={showDebug} onCheckedChange={setShowDebug} />
              <Label htmlFor="dbg">DCen lines</Label>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-80 rounded-md border">
            <div className="p-3 font-mono text-xs">
              {log.map((l, i) => (
                <div
                  key={i}
                  className={
                    l.level === 'error'
                      ? 'text-destructive'
                      : l.level === 'warn'
                        ? 'text-amber-600'
                        : l.level === 'debug'
                          ? 'text-muted-foreground'
                          : ''
                  }
                >
                  {new Date(l.at).toLocaleTimeString()} {l.msg}
                </div>
              ))}
              {log.length === 0 && <div className="text-muted-foreground">No events yet.</div>}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        Units are shown in decimal; the DCen reports them in hex (e.g. #{26} = {hexUnit(26)}).
      </p>
    </div>
  )
}
