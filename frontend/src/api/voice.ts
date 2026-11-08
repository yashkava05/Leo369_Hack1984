import { API_URL, MOCK } from './client'
import { getLibraryItem, recordMockResult } from './library'
import { offlineReplay } from './offlineReplay'
import { isMockOffline } from './privacy'
import type { AnalyzeResponse, Intent, JobResult, StageEvent } from '../types'

export type VoiceAction = 'explore' | 'save' | 'related'
export type VoiceScenario = 'event' | 'save' | 'related' | 'silence' | 'permission-denied'
export interface Transcription { transcript: string; language: string; duration_ms: number }
export const normalizeVoiceText = (text: string): string => text.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 1000)
export class VoiceError extends Error {
  code: string
  status: number
  constructor(code: string, status = 0) { super(code); this.name = 'VoiceError'; this.code = code; this.status = status }
}

async function responseJSON<T>(response: Response, expected: number): Promise<T> {
  if (response.status !== expected) {
    const body = await response.json().catch(() => null)
    // Only recognized codes are surfaced; server text may contain private input.
    const detail = body?.detail
    const code = typeof detail === 'string' ? detail : detail?.code
    const allowed = ['audio_too_large', 'unsupported_audio', 'audio_too_long', 'no_speech', 'voice_model_unavailable', 'timeout']
    throw new VoiceError(allowed.includes(code) ? code : 'backend_error', response.status)
  }
  return response.json() as Promise<T>
}

export async function transcribeAudio(blob: Blob, filename: string, signal?: AbortSignal): Promise<Transcription> {
  signal?.throwIfAborted()
  if (MOCK) return { transcript: 'Find AI events in Boston on November 14 2026', language: 'en', duration_ms: 2800 }
  const body = new FormData()
  body.append('audio', blob, normalizeVoiceText(filename))
  const result = await responseJSON<Transcription>(await fetch(`${API_URL}/api/voice/transcribe`, { method: 'POST', body, signal }), 200)
  const transcript = normalizeVoiceText(result.transcript)
  if (!transcript) throw new VoiceError('no_speech', 422)
  return { ...result, transcript }
}

const mockJobs = new Map<string, StageEvent[]>()
export const MOCK_VOICE_CONTEXT_ID = 'voice-demo-context'
export const mockVoiceIntent: Intent = {
  intent_type: 'event', summary: 'AI Fest in Boston on November 14, 2026 (demo).',
  public_entities: [{ type: 'event_name', value: 'AI Fest' }, { type: 'city', value: 'Boston' }, { type: 'date', value: '2026-11-14' }],
  redaction_counts: {}, confidence: 0.95,
}

export async function analyzeVoice(text: string, action: VoiceAction, contextLibraryId: string | null = null, signal?: AbortSignal): Promise<AnalyzeResponse> {
  signal?.throwIfAborted()
  const normalized = normalizeVoiceText(text)
  const context = contextLibraryId ? normalizeVoiceText(contextLibraryId) : null
  if (!normalized || !['explore', 'save', 'related'].includes(action) || (action === 'related' ? !context : context !== null)) throw new VoiceError('invalid_review', 422)
  if (!MOCK) return responseJSON<AnalyzeResponse>(await fetch(`${API_URL}/api/voice/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ text: normalized, action, context_library_id: context }),
  }), 202)
  const jobId = `j_voice_mock_${action === 'explore' ? 'event' : action}_${Math.random().toString(36).slice(2, 10)}`
  // Retain only structured, scrubbed fixtures, never the reviewed instruction.
  const selected = action === 'related' && context !== MOCK_VOICE_CONTEXT_ID ? await getLibraryItem(context!) : null
  signal?.throwIfAborted()
  const intent = structuredClone(selected?.intent ?? mockVoiceIntent)
  if (action === 'related' && (!intent.public_entities.length || (selected && !selected.intent))) throw new VoiceError('invalid_context', 422)
  const query = intent.public_entities.map((entity) => entity.value).join(' ') + (action === 'related' ? '' : ' tickets')
  const result: JobResult = {
    job_id: jobId, status: 'done', intent,
    queries: action === 'save' ? [] : [{ text: query, purpose: action === 'related' ? 'related' : 'tickets', topic: 'general', include_domains: [] }],
    cards: action === 'save' ? [] : [{ id: 'voice-demo-card', kind: action === 'related' ? 'related' : 'tickets', title: intent.public_entities.map((e) => e.value).join(' · '), subtitle: 'Demo result · no network request', url: null, price: null, source: 'demo', snippet: 'Suggestions from scrubbed public details.', score: 0.9, actions: [] }],
    egress: [], timings_ms: {}, error: null,
  }
  if (action !== 'save') {
    const payload = JSON.stringify({ query, topic: 'general' })
    result.egress = [{ id: `${jobId}-egress`, ts: Date.now() / 1000, method: 'POST', host: 'api.tavily.com', path: '/search', bytes_out: new TextEncoder().encode(payload).length, payload_preview: payload.slice(0, 300), blocked: false, reason: null }]
  }
  const steps: [StageEvent['stage'], string, boolean][] = [
    ['extract', action === 'related' ? 'Reading the selected scrubbed library context on-device' : 'Interpreting reviewed text on-device', true],
    ['scrub', 'Private details removed on-device', true],
    ...(action === 'save' ? [] : [
      ['query', 'Building queries from scrubbed public entities', true],
      ['search', 'Demo web search using public details only', false],
      ['cards', 'Preparing voice result cards', true],
    ] as [StageEvent['stage'], string, boolean][]),
    ['done', action === 'save' ? 'Scrubbed interest saved locally; no web search' : 'Voice results ready', true],
  ]
  mockJobs.set(jobId, steps.map(([stage, message, local], seq) => ({ job_id: jobId, seq, ts: Date.now() / 1000, stage, status: 'ok', message, local, data: stage === 'done' ? result as unknown as Record<string, unknown> : null })))
  return { job_id: jobId }
}

/** Main's followVoice can pass this in place of the screenshot SSE subscriber. */
export function subscribeMockVoice(jobId: string, onEvent: (event: StageEvent) => void): () => void {
  const base = mockJobs.get(jobId)
  if (!base) return () => {}
  mockJobs.delete(jobId)
  const save = !base.some((event) => event.stage === 'search')
  const events = !save && isMockOffline() ? offlineReplay(base) : base
  const timers = events.map((event, index) => setTimeout(() => {
    if (event.stage === 'done' && event.data) recordMockResult(event.data as unknown as JobResult)
    onEvent(event)
  }, index * 250))
  return () => timers.forEach(clearTimeout)
}
