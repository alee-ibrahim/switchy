import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Plus, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, type NdiStatus, type Room } from '@/lib/api'
import { useEvents } from '@/hooks/use-events'

export function RoomsPage() {
  const [rooms, setRooms] = useState<Room[] | null>(null)
  const [ndi, setNdi] = useState<NdiStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.rooms().then(setRooms).catch((e) => setError(e.message))
    api.ndi().then(setNdi).catch(() => undefined)
  }, [])
  useEvents(() => undefined, { onSources: (sources) => setNdi((n) => (n ? { ...n, sources } : n)) })

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load rooms</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {ndi && !ndi.available && (
        <Alert variant="destructive">
          <AlertTitle>NDI runtime not available</AlertTitle>
          <AlertDescription>
            {ndi.error} Program outputs are disabled; camera control still works.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Rooms</CardTitle>
          <CardDescription>Each room publishes its own NDI program output.</CardDescription>
          <CardAction>
            <Button asChild>
              <Link to="/rooms/new">
                <Plus /> New room
              </Link>
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {rooms && rooms.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Video />
                </EmptyMedia>
                <EmptyTitle>No rooms yet</EmptyTitle>
                <EmptyDescription>Add a room with its DCen unit, cameras and seats.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild>
                  <Link to="/rooms/new">New room</Link>
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Program output</TableHead>
                  <TableHead>DCen</TableHead>
                  <TableHead>Cameras</TableHead>
                  <TableHead>Seats</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rooms?.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">
                      <Link to={`/rooms/${r.id}`} className="hover:underline">
                        {r.name}
                      </Link>{' '}
                      {!r.enabled && <Badge variant="outline">disabled</Badge>}
                    </TableCell>
                    <TableCell>{r.outputName}</TableCell>
                    <TableCell>{r.dcenHost ? `${r.dcenHost}:${r.dcenPort}` : '-'}</TableCell>
                    <TableCell>{r.cameras.length}</TableCell>
                    <TableCell>{r.seats.length}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <Link to={`/rooms/${r.id}`}>Live</Link>
                      </Button>
                      <Button variant="ghost" size="sm" asChild>
                        <Link to={`/rooms/${r.id}/edit`}>Edit</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>NDI sources</CardTitle>
          <CardDescription>
            {ndi?.available
              ? `NDI runtime ${ndi.version ?? ''}. Extra discovery IPs: ${ndi.extraIps.join(', ') || 'none'}`
              : 'NDI runtime not loaded'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Address</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ndi?.sources.map((s) => (
                <TableRow key={s.name}>
                  <TableCell>{s.name}</TableCell>
                  <TableCell className="text-muted-foreground">{s.url}</TableCell>
                </TableRow>
              ))}
              {ndi && ndi.sources.length === 0 && (
                <TableRow>
                  <TableCell colSpan={2} className="text-muted-foreground">
                    No sources discovered.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
