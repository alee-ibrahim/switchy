import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { Crosshair, Ear, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { NdiSourcePicker } from '@/components/ndi-source-picker'
import { LearnedSeats } from '@/components/learned-seats'
import { useEvents } from '@/hooks/use-events'
import {
  api,
  calibrationOf,
  defaultPolicy,
  hexUnit,
  newCamera,
  thumbnailMap,
  type Camera,
  type NdiSource,
  type RoomInput,
  type Seat,
} from '@/lib/api'

const emptyRoom = (): RoomInput => ({
  name: '',
  enabled: true,
  dcenHost: '',
  dcenPort: 3225,
  outputName: '',
  outputMode: 'route',
  cameras: [newCamera('wide'), newCamera('ptz')],
  seats: [],
  policy: defaultPolicy(),
})

const num = (v: string, fallback: number) => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

export function RoomEditPage() {
  const { id } = useParams()
  const isNew = !id
  const nav = useNavigate()
  const [room, setRoom] = useState<RoomInput | null>(isNew ? emptyRoom() : null)
  const [sources, setSources] = useState<NdiSource[]>([])
  const [saving, setSaving] = useState(false)
  const [learning, setLearning] = useState(false)
  const [thumbs, setThumbs] = useState<Map<number, string>>(new Map())
  const [calibrating, setCalibrating] = useState<string | null>(null)

  useEffect(() => {
    api.ndi().then((n) => setSources(n.sources)).catch(() => undefined)
    if (id)
      api
        .room(id)
        .then(({ id: _id, ...r }) => setRoom(r))
        .catch((e) => toast.error(e.message))
    if (id) thumbnailMap(id).then(setThumbs).catch(() => undefined)
  }, [id])
  useEvents(() => undefined, { onSources: setSources })

  if (!room) return <Spinner />

  const set = (patch: Partial<RoomInput>) => setRoom({ ...room, ...patch })
  const setPolicy = (patch: Partial<RoomInput['policy']>) => set({ policy: { ...room.policy, ...patch } })
  const setCam = (i: number, patch: Partial<Camera>) =>
    set({ cameras: room.cameras.map((c, j) => (j === i ? { ...c, ...patch } : c)) })
  const setSeat = (i: number, patch: Partial<Seat>) =>
    set({ seats: room.seats.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const ptzId = () => (room.cameras.find((c) => c.role === 'ptz') ?? room.cameras[0])?.id ?? ''

  const save = async () => {
    setSaving(true)
    try {
      const r = isNew ? await api.createRoom(room) : await api.updateRoom(id!, room)
      toast.success('Saved; room restarted')
      nav(`/rooms/${r.id}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const learn = async () => {
    if (!id) return
    setLearning(true)
    toast.info('Press the mic button on the seat now (30 s)...')
    try {
      const { unit } = await api.learn(id)
      if (unit === null) {
        toast.warning('No mic was pressed')
        return
      }
      const existing = room.seats.findIndex((s) => s.unit === unit)
      if (existing >= 0) toast.info(`Unit ${unit} is already mapped (${room.seats[existing]!.label || 'no label'})`)
      else {
        setRoom((r) =>
          r ? { ...r, seats: [...r.seats, { unit, label: `Seat ${unit}`, cameraId: ptzId(), preset: '' }] } : r,
        )
        toast.success(`Captured unit ${unit} (DCen ${hexUnit(unit)}). Set its preset, then Save.`)
      }
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLearning(false)
    }
  }

  const calibrate = async (cam: Camera) => {
    if (!id) return
    setCalibrating(cam.id)
    toast.info(`${cam.name}: calibrating; the camera moves around its current position for about a minute`)
    try {
      const r = await api.calibrate(id, cam.id)
      // the server stored it already; keep this form in sync so Save does not drop it
      setRoom((cur) =>
        cur
          ? {
              ...cur,
              cameras: cur.cameras.map((c) =>
                c.id === cam.id
                  ? { ...c, options: { ...c.options, autoframe: { ...((c.options.autoframe as object) ?? {}), calibration: r.calibration } } }
                  : c,
              ),
            }
          : cur,
      )
      toast.success(`${cam.name}: calibrated ${r.calibration.points.length} zoom levels in ${Math.round(r.ms / 1000)} s`)
    } catch (e) {
      toast.error(`${cam.name}: ${(e as Error).message}`)
    } finally {
      setCalibrating(null)
    }
  }

  const probe = async (cam: Camera) => {
    const r = await api.probe(cam).catch((e) => ({ ok: false, error: (e as Error).message }) as { ok: boolean; error?: string; model?: string; firmware?: string })
    if (r.ok) toast.success(`${cam.name}: reachable ${r.model ?? ''} ${r.firmware ?? ''}`)
    else toast.error(`${cam.name}: ${r.error}`)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">{isNew ? 'New room' : `Edit ${room.name}`}</h1>
        <div className="ml-auto flex gap-2">
          {!isNew && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive">
                  <Trash2 /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {room.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Its NDI program output disappears and automation stops.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() =>
                      api
                        .deleteRoom(id!)
                        .then(() => nav('/'))
                        .catch((e) => toast.error(e.message))
                    }
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <Button variant="outline" onClick={() => nav(isNew ? '/' : `/rooms/${id}`)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Spinner />} Save
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Room</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup className="grid gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input
                id="name"
                value={room.name}
                onChange={(e) =>
                  set({
                    name: e.target.value,
                    outputName:
                      !room.outputName || room.outputName === `Switchy (${room.name} Program)`
                        ? `Switchy (${e.target.value} Program)`
                        : room.outputName,
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="out">Program output name (NDI)</FieldLabel>
              <Input id="out" value={room.outputName} onChange={(e) => set({ outputName: e.target.value })} />
              <FieldDescription>Receivers see it as "&lt;this PC&gt; ({room.outputName || '...'})".</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="dh">DCen central unit IP</FieldLabel>
              <Input id="dh" value={room.dcenHost} onChange={(e) => set({ dcenHost: e.target.value.trim() })} />
              <FieldDescription>Read-only connection; Switchy never sends to the DCen.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="dp">DCen port</FieldLabel>
              <Input id="dp" type="number" value={room.dcenPort} onChange={(e) => set({ dcenPort: num(e.target.value, 3225) })} />
            </Field>
            <Field orientation="horizontal">
              <Switch id="en" checked={room.enabled} onCheckedChange={(v) => set({ enabled: v })} />
              <FieldLabel htmlFor="en">Enabled</FieldLabel>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cameras</CardTitle>
          <CardDescription>One wide camera plus one PTZ, or a single camera with role "both".</CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => set({ cameras: [...room.cameras, newCamera('ptz')] })}>
              <Plus /> Camera
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {room.cameras.map((cam, i) => (
            <FieldGroup key={cam.id} className="grid gap-4 rounded-lg border p-4 md:grid-cols-3">
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input value={cam.name} onChange={(e) => setCam(i, { name: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel>Role</FieldLabel>
                <Select value={cam.role} onValueChange={(v) => setCam(i, { role: v as Camera['role'] })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="wide">Wide</SelectItem>
                    <SelectItem value="ptz">PTZ (close-ups)</SelectItem>
                    <SelectItem value="both">Both (one-camera room)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Control</FieldLabel>
                <Select value={cam.driver} onValueChange={(v) => setCam(i, { driver: v as Camera['driver'] })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="birddog">BirdDog REST (:8080)</SelectItem>
                    <SelectItem value="visca">VISCA over IP (UDP 52381)</SelectItem>
                    <SelectItem value="none">None (fixed camera)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Camera IP</FieldLabel>
                <Input value={cam.host} onChange={(e) => setCam(i, { host: e.target.value.trim() })} />
              </Field>
              <Field>
                <FieldLabel>Control port (blank = default)</FieldLabel>
                <Input
                  type="number"
                  value={cam.port ?? ''}
                  onChange={(e) => setCam(i, { port: e.target.value ? num(e.target.value, 0) : null })}
                />
              </Field>
              <Field>
                <FieldLabel>Settle time after preset (ms)</FieldLabel>
                <Input type="number" value={cam.settleMs} onChange={(e) => setCam(i, { settleMs: num(e.target.value, 0) })} />
              </Field>
              <Field className="md:col-span-2">
                <FieldLabel>NDI source</FieldLabel>
                <NdiSourcePicker value={cam.ndiSource} onChange={(v) => setCam(i, { ndiSource: v })} sources={sources} />
              </Field>
              <Field>
                <FieldLabel>Home preset (wide shot)</FieldLabel>
                <Input
                  value={cam.homePreset ?? ''}
                  placeholder="optional"
                  onChange={(e) => setCam(i, { homePreset: e.target.value || null })}
                />
              </Field>
              <Field>
                <FieldLabel>Credentials reference</FieldLabel>
                <Input
                  value={cam.credentialsRef ?? ''}
                  placeholder="optional, e.g. sony-r12"
                  onChange={(e) => setCam(i, { credentialsRef: e.target.value || null })}
                />
                <FieldDescription>Read from env SWITCHY_CRED_&lt;REF&gt;_USERNAME/_PASSWORD. Never stored here.</FieldDescription>
              </Field>
              <div className="flex items-end gap-2 md:col-span-2">
                <Button variant="outline" size="sm" disabled={!cam.host || cam.driver === 'none'} onClick={() => probe(cam)}>
                  Test connection
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    set({
                      cameras: room.cameras.filter((_, j) => j !== i),
                      seats: room.seats.filter((s) => s.cameraId !== cam.id),
                    })
                  }
                >
                  <Trash2 /> Remove camera
                </Button>
              </div>
            </FieldGroup>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Seats</CardTitle>
          <CardDescription>
            Map each DCen mic to a camera preset. Use "Learn seat" and press the mic, so you never deal with hex.
          </CardDescription>
          <CardAction className="flex gap-2">
            <Button variant="outline" size="sm" disabled={isNew || learning} onClick={learn}>
              {learning ? <Spinner /> : <Ear />} {isNew ? 'Save first to learn' : learning ? 'Waiting for a mic...' : 'Learn seat'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                set({ seats: [...room.seats, { unit: 0, label: '', cameraId: ptzId(), preset: '' }] })
              }
            >
              <Plus /> Seat
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Picture</TableHead>
                <TableHead className="w-28">Unit</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Camera</TableHead>
                <TableHead className="w-32">Preset</TableHead>
                <TableHead className="w-24">Chair</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {room.seats.map((s, i) => (
                <TableRow key={i}>
                  <TableCell>
                    {thumbs.get(s.unit) ? (
                      <img src={thumbs.get(s.unit)} alt={s.label} loading="lazy" className="h-12 w-20 rounded-md object-cover" />
                    ) : (
                      <div className="h-12 w-20 rounded-md bg-muted" />
                    )}
                  </TableCell>
                  <TableCell>
                    <Input type="number" value={s.unit} onChange={(e) => setSeat(i, { unit: num(e.target.value, 0) })} />
                  </TableCell>
                  <TableCell>
                    <Input value={s.label} onChange={(e) => setSeat(i, { label: e.target.value })} />
                  </TableCell>
                  <TableCell>
                    <Select value={s.cameraId} onValueChange={(v) => setSeat(i, { cameraId: v })}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Camera" />
                      </SelectTrigger>
                      <SelectContent>
                        {room.cameras.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Input value={s.preset ?? ''} onChange={(e) => setSeat(i, { preset: e.target.value || null })} />
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={room.policy.chairUnit === s.unit}
                      onCheckedChange={(v) => setPolicy({ chairUnit: v ? s.unit : null })}
                    />
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => set({ seats: room.seats.filter((_, j) => j !== i) })}>
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {room.seats.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground">
                    No seats yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Switching policy</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup className="grid gap-4 md:grid-cols-3">
            <Field>
              <FieldLabel>Speaker mode</FieldLabel>
              <Select value={room.policy.mode} onValueChange={(v) => setPolicy({ mode: v as 'last' | 'first' })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="last">Last speaker wins</SelectItem>
                  <SelectItem value="first">First speaker keeps the shot</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field orientation="horizontal">
              <Switch
                id="cp"
                checked={room.policy.chairPriority}
                onCheckedChange={(v) => setPolicy({ chairPriority: v })}
              />
              <FieldLabel htmlFor="cp">
                Chair priority {room.policy.chairUnit != null ? `(unit ${room.policy.chairUnit})` : '(pick the chair seat above)'}
              </FieldLabel>
            </Field>
            <Field>
              <FieldLabel>Unmapped mic</FieldLabel>
              <Select
                value={room.policy.unmappedSeat}
                onValueChange={(v) => setPolicy({ unmappedSeat: v as 'wide' | 'ignore' })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="wide">Show the wide shot</SelectItem>
                  <SelectItem value="ignore">Ignore</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Debounce (ms)</FieldLabel>
              <Input
                type="number"
                value={room.policy.debounceMs}
                onChange={(e) => setPolicy({ debounceMs: num(e.target.value, 300) })}
              />
            </Field>
            <Field>
              <FieldLabel>Back to wide after (ms)</FieldLabel>
              <Input
                type="number"
                value={room.policy.returnToWideMs}
                onChange={(e) => setPolicy({ returnToWideMs: num(e.target.value, 3000) })}
              />
            </Field>
            <Field>
              <FieldLabel>One-camera room: while moving</FieldLabel>
              <Select
                value={room.policy.oneCameraMove}
                onValueChange={(v) => setPolicy({ oneCameraMove: v as 'live' | 'holding' })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="live">Show the move live</SelectItem>
                  <SelectItem value="holding">Show the holding source</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field className="md:col-span-3">
              <FieldLabel>Holding source (NDI, optional)</FieldLabel>
              <NdiSourcePicker
                value={room.policy.holdingSource}
                onChange={(v) => setPolicy({ holdingSource: v })}
                sources={sources}
                placeholder="None"
              />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Auto-framing</CardTitle>
          <CardDescription>
            After the PTZ reaches a seat preset, find the delegate's face. "Auto-frame once" sends one small
            correction, then cuts if the picture is good. "Track" keeps the speaker framed with slow pan/tilt
            moves; the program shows the PTZ only while the shot is good (head in the frame with headroom,
            camera steady), otherwise the wide camera. The PTZ must be calibrated once.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <FieldGroup className="grid gap-4 md:grid-cols-3">
            <Field>
              <FieldLabel>Mode</FieldLabel>
              <Select value={room.policy.refine} onValueChange={(v) => setPolicy({ refine: v as RoomInput['policy']['refine'] })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off (cut on the preset)</SelectItem>
                  <SelectItem value="auto-frame">Auto-frame once</SelectItem>
                  <SelectItem value="track">Track the speaker</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="af-timeout">{room.policy.refine === 'track' ? 'Note after (ms)' : 'Timeout (ms)'}</FieldLabel>
              <Input
                id="af-timeout"
                type="number"
                value={room.policy.refineTimeoutMs}
                onChange={(e) => setPolicy({ refineTimeoutMs: num(e.target.value, 4000) })}
              />
              <FieldDescription>
                {room.policy.refine === 'track'
                  ? 'Logs why the shot is not good yet after this long. It never cuts on a timeout.'
                  : 'Stop refining after this long; the fallback below decides.'}
              </FieldDescription>
            </Field>
            {room.policy.refine === 'auto-frame' && (
              <Field>
                <FieldLabel>If the check picture is not good</FieldLabel>
                <Select
                  value={room.policy.autoFrameFallback}
                  onValueChange={(v) => setPolicy({ autoFrameFallback: v as RoomInput['policy']['autoFrameFallback'] })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="preset-if-face">Show the preset if a face with headroom was seen</SelectItem>
                    <SelectItem value="wide">Stay on wide</SelectItem>
                    <SelectItem value="preset">Show the preset anyway</SelectItem>
                  </SelectContent>
                </Select>
                <FieldDescription>The check uses the same headroom rule as tracking.</FieldDescription>
              </Field>
            )}
            {room.policy.refine !== 'off' && (
              <Field>
                <FieldLabel htmlFor="gt-headroom">Headroom (% of height)</FieldLabel>
                <Input
                  id="gt-headroom"
                  type="number"
                  min={0}
                  max={25}
                  step={0.5}
                  value={room.policy.trackHeadroomPct}
                  onChange={(e) => setPolicy({ trackHeadroomPct: Math.min(25, Math.max(0, Number(e.target.value) || 0)) })}
                />
                <FieldDescription>The top of the head must be at least this far below the top edge.</FieldDescription>
              </Field>
            )}
            {room.policy.refine === 'track' && (
              <>
                <Field>
                  <FieldLabel htmlFor="tr-dx">Deadzone, horizontal (% of width)</FieldLabel>
                  <Input
                    id="tr-dx"
                    type="number"
                    min={2}
                    max={30}
                    step={0.5}
                    value={room.policy.trackDeadzoneXPct}
                    onChange={(e) => setPolicy({ trackDeadzoneXPct: Math.min(30, Math.max(2, Number(e.target.value) || 2)) })}
                  />
                  <FieldDescription>No pan while the eyes are this close to the centre.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="tr-dy">Deadzone, vertical (% of height)</FieldLabel>
                  <Input
                    id="tr-dy"
                    type="number"
                    min={2}
                    max={30}
                    step={0.5}
                    value={room.policy.trackDeadzoneYPct}
                    onChange={(e) => setPolicy({ trackDeadzoneYPct: Math.min(30, Math.max(2, Number(e.target.value) || 2)) })}
                  />
                  <FieldDescription>No tilt while the eyes are this close to the upper third.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="tr-speed">Max speed (camera level 2-12)</FieldLabel>
                  <Input
                    id="tr-speed"
                    type="number"
                    min={2}
                    max={12}
                    step={1}
                    value={room.policy.trackMaxSpeed}
                    onChange={(e) => setPolicy({ trackMaxSpeed: Math.min(12, Math.max(2, Math.round(Number(e.target.value) || 2))) })}
                  />
                  <FieldDescription>Lower is calmer. 5 is about a quarter of the frame per second.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="tr-exc">Max distance from the preset (% of frame)</FieldLabel>
                  <Input
                    id="tr-exc"
                    type="number"
                    min={5}
                    max={100}
                    step={1}
                    value={room.policy.trackMaxExcursionPct}
                    onChange={(e) => setPolicy({ trackMaxExcursionPct: Math.min(100, Math.max(5, Number(e.target.value) || 5)) })}
                  />
                  <FieldDescription>Keeps the camera from drifting to the next seat.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="tr-loss">Hold after losing the face (ms)</FieldLabel>
                  <Input
                    id="tr-loss"
                    type="number"
                    min={300}
                    max={10000}
                    value={room.policy.trackLossTimeoutMs}
                    onChange={(e) => setPolicy({ trackLossTimeoutMs: Math.min(10000, Math.max(300, num(e.target.value, 1500))) })}
                  />
                  <FieldDescription>The camera stops at once and holds; it never switches to another face.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="tr-return">Back to the preset after (ms, 0 = never)</FieldLabel>
                  <Input
                    id="tr-return"
                    type="number"
                    min={0}
                    max={120000}
                    value={room.policy.trackReturnAfterMs}
                    onChange={(e) => setPolicy({ trackReturnAfterMs: Math.min(120000, Math.max(0, num(e.target.value, 0))) })}
                  />
                  <FieldDescription>When the face stays lost this long.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="tr-tight">Too tight: face taller than (% of height)</FieldLabel>
                  <Input
                    id="tr-tight"
                    type="number"
                    min={15}
                    max={90}
                    step={1}
                    value={room.policy.trackTightFacePct}
                    onChange={(e) => setPolicy({ trackTightFacePct: Math.min(90, Math.max(15, Number(e.target.value) || 35)) })}
                  />
                  <FieldDescription>A bigger face means the shot is zoomed in too far: the seat preset is recalled.</FieldDescription>
                </Field>
                <Field orientation="horizontal" className="md:col-span-2">
                  <Switch
                    id="tr-reacquire"
                    checked={room.policy.trackReacquire}
                    onCheckedChange={(v) => setPolicy({ trackReacquire: v })}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="tr-reacquire">Pick the speaker up again after losing the face</FieldLabel>
                    <FieldDescription>
                      Resumes tracking when a face reappears near where it was or near the preset aim. Never a face outside the seat.
                    </FieldDescription>
                  </FieldContent>
                </Field>
                <Field orientation="horizontal" className="md:col-span-3">
                  <Switch id="tr-zoom" checked={room.policy.trackZoom} onCheckedChange={(v) => setPolicy({ trackZoom: v })} />
                  <FieldLabel htmlFor="tr-zoom">Slow zoom to keep the face size steady</FieldLabel>
                </Field>
                <Field>
                  <FieldLabel htmlFor="gt-hold">Good shot before the cut (ms)</FieldLabel>
                  <Input
                    id="gt-hold"
                    type="number"
                    min={0}
                    max={5000}
                    value={room.policy.trackHoldBeforeCutMs}
                    onChange={(e) => setPolicy({ trackHoldBeforeCutMs: Math.min(5000, Math.max(0, num(e.target.value, 400))) })}
                  />
                  <FieldDescription>The shot must stay good this long before the program cuts to the PTZ.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="gt-lost">Speaker lost: back to wide after (ms)</FieldLabel>
                  <Input
                    id="gt-lost"
                    type="number"
                    min={100}
                    max={10000}
                    value={room.policy.trackLostToWideMs}
                    onChange={(e) => setPolicy({ trackLostToWideMs: Math.min(10000, Math.max(100, num(e.target.value, 700))) })}
                  />
                  <FieldDescription>Goes to wide even right after a cut.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="gt-bad">Bad shot: back to wide after (ms)</FieldLabel>
                  <Input
                    id="gt-bad"
                    type="number"
                    min={100}
                    max={10000}
                    value={room.policy.trackBadToWideMs}
                    onChange={(e) => setPolicy({ trackBadToWideMs: Math.min(10000, Math.max(100, num(e.target.value, 700))) })}
                  />
                  <FieldDescription>E.g. the speaker stands up and the head leaves the frame.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="gt-dwell">Minimum time on a source (ms)</FieldLabel>
                  <Input
                    id="gt-dwell"
                    type="number"
                    min={0}
                    max={20000}
                    value={room.policy.trackMinDwellMs}
                    onChange={(e) => setPolicy({ trackMinDwellMs: Math.min(20000, Math.max(0, num(e.target.value, 2000))) })}
                  />
                  <FieldDescription>Stops flip-flopping between PTZ and wide.</FieldDescription>
                </Field>
                <Field orientation="horizontal" className="md:col-span-2">
                  <Switch
                    id="tr-fallback"
                    checked={room.policy.trackFallbackDetector}
                    onCheckedChange={(v) => setPolicy({ trackFallbackDetector: v })}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="tr-fallback">Find the head from the body when no face is seen</FieldLabel>
                    <FieldDescription>Helps with turned heads or a hand on the face. Only inside the seat.</FieldDescription>
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel htmlFor="gt-blur">Blurry head: no cut below (% of the seat's usual sharpness)</FieldLabel>
                  <Input
                    id="gt-blur"
                    type="number"
                    min={0}
                    max={80}
                    step={5}
                    value={room.policy.trackBlurRatioPct}
                    onChange={(e) => setPolicy({ trackBlurRatioPct: Math.min(80, Math.max(0, Number(e.target.value) || 0)) })}
                  />
                  <FieldDescription>Waits for a sharp picture before cutting to the PTZ (0 = off). Never cuts away.</FieldDescription>
                </Field>
                <Field orientation="horizontal" className="md:col-span-2">
                  <Switch id="tr-learn" checked={room.policy.trackLearn} onCheckedChange={(v) => setPolicy({ trackLearn: v })} />
                  <FieldContent>
                    <FieldLabel htmlFor="tr-learn">Learn where each delegate sits</FieldLabel>
                    <FieldDescription>
                      After good turns, remember the offset from the seat preset and start the next turn there (one small
                      move after the preset). The saved presets are never changed.
                    </FieldDescription>
                  </FieldContent>
                </Field>
                {room.policy.trackLearn && (
                  <>
                    <Field>
                      <FieldLabel htmlFor="tr-learn-cap">Largest learned correction (% of frame)</FieldLabel>
                      <Input
                        id="tr-learn-cap"
                        type="number"
                        min={1}
                        max={25}
                        step={1}
                        value={room.policy.trackLearnCapPct}
                        onChange={(e) => setPolicy({ trackLearnCapPct: Math.min(25, Math.max(1, Number(e.target.value) || 10)) })}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="tr-learn-n">Turns remembered per seat</FieldLabel>
                      <Input
                        id="tr-learn-n"
                        type="number"
                        min={2}
                        max={20}
                        step={1}
                        value={room.policy.trackLearnSamples}
                        onChange={(e) => setPolicy({ trackLearnSamples: Math.min(20, Math.max(2, Math.round(Number(e.target.value) || 5))) })}
                      />
                      <FieldDescription>The median is used once 2 good turns were seen.</FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="tr-learn-max">Ignore a person further than (% of frame from the preset aim)</FieldLabel>
                      <Input
                        id="tr-learn-max"
                        type="number"
                        min={5}
                        max={50}
                        step={1}
                        value={room.policy.trackLearnMaxOffsetPct}
                        onChange={(e) => setPolicy({ trackLearnMaxOffsetPct: Math.min(50, Math.max(5, Number(e.target.value) || 35)) })}
                      />
                      <FieldDescription>Probably the wrong person. Large but steady offsets inside this are learnt.</FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="tr-learn-spread">Steady turn: largest spread (% of frame)</FieldLabel>
                      <Input
                        id="tr-learn-spread"
                        type="number"
                        min={1}
                        max={25}
                        step={1}
                        value={room.policy.trackLearnMaxSpreadPct}
                        onChange={(e) => setPolicy({ trackLearnMaxSpreadPct: Math.min(25, Math.max(1, Number(e.target.value) || 8)) })}
                      />
                      <FieldDescription>A turn teaches only if the person stayed this still (interquartile range of the offset).</FieldDescription>
                    </Field>
                  </>
                )}
              </>
            )}
            {room.policy.refine !== 'track' && (
              <>
            <Field>
              <FieldLabel htmlFor="af-deadband">Horizontal deadband (% of width)</FieldLabel>
              <Input
                id="af-deadband"
                type="number"
                min={0}
                max={25}
                step={0.5}
                value={room.policy.refineDeadbandPct}
                onChange={(e) => setPolicy({ refineDeadbandPct: Math.min(25, Math.max(0, Number(e.target.value) || 0)) })}
              />
              <FieldDescription>No pan while the eyes are this close to the centre.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="af-deadband-v">Vertical deadband (% of height)</FieldLabel>
              <Input
                id="af-deadband-v"
                type="number"
                min={0}
                max={25}
                step={0.5}
                value={room.policy.refineDeadbandVPct}
                onChange={(e) => setPolicy({ refineDeadbandVPct: Math.min(25, Math.max(0, Number(e.target.value) || 0)) })}
              />
              <FieldDescription>No tilt while the eyes are this close to the upper third.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="af-max">Largest correction (% of frame)</FieldLabel>
              <Input
                id="af-max"
                type="number"
                min={1}
                max={40}
                step={0.5}
                value={room.policy.refineMaxCorrectionPct}
                onChange={(e) => setPolicy({ refineMaxCorrectionPct: Math.min(40, Math.max(1, Number(e.target.value) || 1)) })}
              />
              <FieldDescription>A face further off is not moved to (wrong person); the preset is kept.</FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <Switch id="af-zoom" checked={room.policy.refineZoom} onCheckedChange={(v) => setPolicy({ refineZoom: v })} />
              <FieldLabel htmlFor="af-zoom">Allow one small zoom step when the face is clearly too small or too big</FieldLabel>
            </Field>
            <Field orientation="horizontal" className="md:col-span-2">
              <Switch
                id="af-save"
                checked={room.policy.refineSavePreset}
                onCheckedChange={(v) => setPolicy({ refineSavePreset: v })}
              />
              <FieldLabel htmlFor="af-save">Save the refined position as the seat preset (overwrites it)</FieldLabel>
            </Field>
              </>
            )}
            <Field>
              <FieldLabel htmlFor="hl-zoom">Zoom limit (± % of the preset zoom)</FieldLabel>
              <Input
                id="hl-zoom"
                type="number"
                min={3}
                max={50}
                step={1}
                value={room.policy.trackZoomTolerancePct}
                onChange={(e) => setPolicy({ trackZoomTolerancePct: Math.min(50, Math.max(3, Number(e.target.value) || 15)) })}
              />
              <FieldDescription>
                Zoom never leaves this range. If the camera is found further off when idle, the seat preset is recalled.
              </FieldDescription>
            </Field>
          </FieldGroup>
          {!isNew && room.policy.refine === 'track' && <LearnedSeats roomId={id!} />}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PTZ camera</TableHead>
                <TableHead>Calibration</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {room.cameras
                .filter((c) => c.role !== 'wide')
                .map((cam) => {
                  const cal = calibrationOf(cam)
                  return (
                    <TableRow key={cam.id}>
                      <TableCell>{cam.name}</TableCell>
                      <TableCell>
                        {cal ? (
                          <Badge variant="secondary">
                            {cal.points.length} zoom levels
                            {cal.measuredAt ? `, ${new Date(cal.measuredAt).toLocaleDateString()}` : ''}
                          </Badge>
                        ) : (
                          <Badge variant="outline">Not calibrated</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="outline" size="sm" disabled={isNew || calibrating !== null}>
                              {calibrating === cam.id ? <Spinner /> : <Crosshair />}
                              {cal ? 'Recalibrate' : 'Calibrate'}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Calibrate {cam.name}?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Pause the room's automation first. Aim the camera at a seat with some detail in the
                                picture (no one needs to sit there). The camera then pans, tilts and zooms around that
                                spot for about a minute and returns. Seat presets are not changed.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => calibrate(cam)}>Calibrate</AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </TableCell>
                    </TableRow>
                  )
                })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
