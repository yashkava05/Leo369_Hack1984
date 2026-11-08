import type { AnalyzeResponse, JobResult, StageEvent } from '../types'
import { API_URL, MOCK } from './client'
import { recordMockResult } from './library'
import { offlineReplay } from './offlineReplay'
import { isMockOffline } from './privacy'
import concertEvents from './fixtures/concert_flyer.events.json'
import docEvents from './fixtures/sensitive_doc.events.json'
import { CHAT_FIXTURES } from '../chat/mockFixtures'

const FIXTURES: Record<string, StageEvent[]> = {
  concert_flyer: concertEvents as StageEvent[],
  sensitive_doc: docEvents as StageEvent[],
  ...CHAT_FIXTURES,
}

// Mock job ids encode which fixture to replay, mirroring the backend's filename rule.
const MOCK_PREFIX = 'j_mock_'

function pickFixture(filename: string): string {
  if (filename.toLowerCase().includes('product')) return 'product'
  if (filename.toLowerCase().includes('book')) return 'book'
  return filename.toLowerCase().includes('doc') ? 'sensitive_doc' : 'concert_flyer'
}

function isTerminal(event: StageEvent): boolean {
  return event.stage === 'done' || event.stage === 'error'
}

export async function analyze(file: File): Promise<AnalyzeResponse> {
  if (MOCK) {
    const suffix = Math.random().toString(36).slice(2, 8)
    return { job_id: `${MOCK_PREFIX}${pickFixture(file.name)}_${suffix}` }
  }
  const body = new FormData()
  body.append('image', file)
  const res = await fetch(`${API_URL}/api/analyze`, { method: 'POST', body })
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw new Error(detail?.detail ?? `analyze failed: ${res.status}`)
  }
  return res.json()
}

/** Stream a job's StageEvents. Returns an unsubscribe function. */
export function subscribe(jobId: string, onEvent: (event: StageEvent) => void): () => void {
  return MOCK ? subscribeMock(jobId, onEvent) : subscribeLive(jobId, onEvent)
}

function subscribeLive(jobId: string, onEvent: (event: StageEvent) => void): () => void {
  const source = new EventSource(`${API_URL}/api/jobs/${encodeURIComponent(jobId)}/events`)
  let finished = false
  source.addEventListener('stage', (msg) => {
    const event = JSON.parse((msg as MessageEvent<string>).data) as StageEvent
    onEvent(event)
    if (isTerminal(event)) {
      finished = true
      source.close()
    }
  })
  source.onerror = () => {
    // The server closes the stream after the terminal event; stop EventSource reconnecting.
    if (finished || source.readyState === EventSource.CLOSED) source.close()
  }
  return () => source.close()
}

function subscribeMock(jobId: string, onEvent: (event: StageEvent) => void): () => void {
  const name = Object.keys(FIXTURES).find((key) => jobId.startsWith(`${MOCK_PREFIX}${key}`))
  const base = FIXTURES[name ?? 'concert_flyer']
  const events = isMockOffline() ? offlineReplay(base) : base
  const timers: ReturnType<typeof setTimeout>[] = []
  let at = 0
  events.forEach((fixture, i) => {
    if (i > 0) at += 300 + Math.random() * 400
    timers.push(
      setTimeout(() => {
        const event: StageEvent = { ...fixture, job_id: jobId, ts: Date.now() / 1000 }
        if (event.stage === 'done' && event.data) {
          const records = event.data.egress as import('../types').EgressRecord[] | undefined
          event.data = { ...event.data, job_id: jobId, egress: records?.map((r) => ({ ...r, id: `${jobId}-${r.id}`, ts: event.ts })) ?? [] }
          recordMockResult(event.data as unknown as JobResult) // local intent library (#21)
        }
        onEvent(event)
      }, at),
    )
  })
  return () => timers.forEach(clearTimeout)
}
