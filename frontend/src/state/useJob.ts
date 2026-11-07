import { useSyncExternalStore } from 'react'
import { analyze, subscribe } from '../api/events'
import type { JobResult, Stage, StageEvent } from '../types'

// One shared job store for the whole page: the drop zone writes it, and the stage strip,
// terminal and dashboard read it through useJob() without a provider or prop drilling.

export type JobStatus = 'idle' | 'uploading' | 'running' | 'done' | 'error'

export interface JobState {
  status: JobStatus
  jobId?: string
  previewUrl?: string // object URL of the local file, never uploaded elsewhere
  events: StageEvent[] // in arrival order
  currentStage?: Stage
  result?: JobResult
  error?: string
}

const IDLE: JobState = { status: 'idle', events: [] }

let state: JobState = IDLE
const listeners = new Set<() => void>()
let unsubscribeEvents: (() => void) | null = null
// Bumped by every start() and reset() so late analyze() responses and stray events from an
// abandoned job are ignored.
let generation = 0

function setState(next: JobState): void {
  state = next
  listeners.forEach((listener) => listener())
}

function closeStream(): void {
  unsubscribeEvents?.()
  unsubscribeEvents = null
}

function clear(): void {
  generation += 1
  closeStream()
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl)
}

function onEvent(gen: number, event: StageEvent): void {
  if (gen !== generation) return
  const events = [...state.events, event]
  if (event.stage === 'done') {
    closeStream()
    setState({ ...state, events, status: 'done', result: (event.data ?? undefined) as JobResult | undefined })
  } else if (event.stage === 'error' || event.status === 'error') {
    closeStream()
    setState({ ...state, events, status: 'error', error: event.message })
  } else {
    setState({ ...state, events, currentStage: event.stage })
  }
}

export async function start(file: File): Promise<void> {
  clear()
  const gen = generation
  setState({ status: 'uploading', previewUrl: URL.createObjectURL(file), events: [] })
  let jobId: string
  try {
    ;({ job_id: jobId } = await analyze(file))
  } catch (err) {
    if (gen === generation) {
      setState({ ...state, status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  if (gen !== generation) return
  setState({ ...state, status: 'running', jobId })
  unsubscribeEvents = subscribe(jobId, (event) => onEvent(gen, event))
}

export function reset(): void {
  clear()
  setState(IDLE)
}

function subscribeStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    // Once nothing on the page reads the job (the app unmounted), close the event stream.
    // Deferred so a component re-subscribing in the same tick (StrictMode) does not abort it.
    queueMicrotask(() => {
      if (listeners.size === 0) reset()
    })
  }
}

const getSnapshot = (): JobState => state

export function useJob(): JobState & { start(file: File): Promise<void>; reset(): void } {
  const snapshot = useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot)
  return { ...snapshot, start, reset }
}
