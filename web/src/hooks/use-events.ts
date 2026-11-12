import { useEffect, useRef } from 'react'
import type { NdiSource } from '@/lib/api'

export interface EngineEvent {
  roomId: string
  event: { type: string; [k: string]: unknown }
}

/** Subscribe to the server-sent event stream (auto-reconnects). */
export function useEvents(
  onEvent: (e: EngineEvent) => void,
  opts: { room?: string; onSources?: (s: NdiSource[]) => void } = {},
) {
  const cb = useRef(onEvent)
  const srcCb = useRef(opts.onSources)
  useEffect(() => {
    cb.current = onEvent
    srcCb.current = opts.onSources
  })
  useEffect(() => {
    const es = new EventSource(opts.room ? `/api/events?room=${encodeURIComponent(opts.room)}` : '/api/events')
    es.onmessage = (m) => {
      try {
        cb.current(JSON.parse(m.data))
      } catch {
        /* ignore */
      }
    }
    es.addEventListener('ndi', (m) => {
      try {
        srcCb.current?.(JSON.parse((m as MessageEvent).data))
      } catch {
        /* ignore */
      }
    })
    return () => es.close()
  }, [opts.room])
}
