import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
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
import { api, type LearnedSeat } from '@/lib/api'

const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`

/** Learned per-seat corrections (track mode) with reset buttons. The camera presets are never changed. */
export function LearnedSeats({ roomId }: { roomId: string }) {
  const [rows, setRows] = useState<LearnedSeat[] | null>(null)
  const [busy, setBusy] = useState<number | 'all' | null>(null)

  const load = useCallback(() => {
    api
      .learned(roomId)
      .then(setRows)
      .catch((e) => toast.error((e as Error).message))
  }, [roomId])
  useEffect(load, [load])

  const reset = async (unit?: number) => {
    setBusy(unit ?? 'all')
    try {
      await api.resetLearned(roomId, unit)
      toast.success(unit === undefined ? 'All learned corrections cleared' : `Seat ${unit}: learned correction cleared`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (!rows) return <Spinner />
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">Learned seat corrections</div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={load}>
            Refresh
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={!rows.length || busy !== null}>
                {busy === 'all' ? <Spinner /> : <RotateCcw />}
                Reset all
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset all learned corrections?</AlertDialogTitle>
                <AlertDialogDescription>
                  Every seat starts again from its saved preset and learns from the next good turns. The presets
                  themselves are not changed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => reset()}>Reset all</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">Nothing learnt yet. Each good tracking turn adds one sample.</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Seat</TableHead>
              <TableHead>Learned</TableHead>
              <TableHead className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.unit}>
                <TableCell>
                  {r.label || `Seat ${r.unit}`} <span className="text-muted-foreground">(preset {r.preset})</span>
                </TableCell>
                <TableCell>
                  {!r.current ? (
                    <Badge variant="outline">preset changed; not used</Badge>
                  ) : r.correction ? (
                    <span>
                      learned: {pct(r.correction.x)} x, {pct(r.correction.y)} y ({r.turns} turns)
                      {r.correction.capped ? <Badge variant="secondary" className="ml-2">capped</Badge> : null}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{r.turns} of 2 turns</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => reset(r.unit)}>
                    {busy === r.unit ? <Spinner /> : <RotateCcw />}
                    Reset seat
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
