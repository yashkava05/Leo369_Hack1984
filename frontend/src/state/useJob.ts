import { useSyncExternalStore } from 'react'
import { analyze, subscribe } from '../api/events'
import { MOCK } from '../api/client'
import { subscribeMockVoice } from '../api/voice'
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
  reopened?: boolean // shown from the local library; no live events or egress audit kept
}

const IDLE: JobState = { status: 'idle', events: [] }

let state: JobState = IDLE
const listeners = new Set<() => void>()
let unsubscribeEvents: (() => void) | null = null
// Bumped by every start() and reset() so late analyze() responses and stray events from an
// abandoned job are ignored.
let generation = 0
let voiceReserved = false

/** Hold the shared input slot across local capture and the analyze request. */
export function reserveVoiceSlot(busy: boolean): boolean {
  if (busy && (voiceReserved || state.status === 'uploading' || state.status === 'running')) return false
  voiceReserved = busy
  return true
}

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

/**
 * Whether an event (other than `done`) ends the job as failed. A network-side error, such as a
 * search request blocked by air-gap mode, does not: the pipeline still finishes locally with
 * `done`, so only `stage: error` or a local stage error is fatal.
 */
export function endsJob(event: StageEvent): boolean {
  return event.stage === 'error' || (event.status === 'error' && event.local)
}

function onEvent(gen: number, event: StageEvent): void {
  if (gen !== generation) return
  const events = [...state.events, event]
  if (event.stage === 'done') {
    closeStream()
    setState({ ...state, events, status: 'done', result: (event.data ?? undefined) as JobResult | undefined })
  } else if (endsJob(event)) {
    closeStream()
    setState({ ...state, events, status: 'error', error: event.message })
  } else {
    setState({ ...state, events, currentStage: event.stage })
  }
}

export async function start(file: File): Promise<void> {
  if (voiceReserved) return
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

/**
 * Follow a job someone else started (the folder watcher, issue #20) without uploading anything.
 * Does nothing while the user is mid-job (uploading or running). Returns whether it switched.
 */
export function follow(jobId: string): boolean {
  if (voiceReserved || state.status === 'uploading' || state.status === 'running') return false
  clear()
  const gen = generation
  setState({ status: 'running', jobId, events: [] })
  unsubscribeEvents = subscribe(jobId, (event) => onEvent(gen, event))
  return true
}

/** Follow an accepted voice job through the same stages and result store. */
export function followVoice(jobId: string): boolean {
  if (voiceReserved || state.status === 'uploading' || state.status === 'running') return false
  clear()
  const gen = generation
  setState({ status: 'running', jobId, events: [] })
  unsubscribeEvents = (MOCK ? subscribeMockVoice : subscribe)(jobId, (event) => onEvent(gen, event))
  return true
}

/** Show a saved result (from the local library) as if its job had just finished. */
export function openResult(result: JobResult): void {
  clear()
  setState({ status: 'done', jobId: result.job_id, events: [], result, reopened: true })
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

export function useJob(): JobState & {
  start(file: File): Promise<void>
  follow(jobId: string): boolean
  followVoice(jobId: string): boolean
  reset(): void
} {
  const snapshot = useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot)
  return { ...snapshot, start, follow, followVoice, reset }
}
