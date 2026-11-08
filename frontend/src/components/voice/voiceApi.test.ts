import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobResult, StageEvent } from '../../types'

beforeEach(() => { vi.resetModules(); vi.useFakeTimers() })
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers() })
async function mockAPI() {
  vi.stubEnv('VITE_MOCK', '1')
  return import('../../api/voice')
}
async function collect(jobId: string, subscribe: (id: string, cb: (event: StageEvent) => void) => () => void) {
  const events: StageEvent[] = []
  subscribe(jobId, (event) => events.push(event))
  await vi.runAllTimersAsync()
  return { events, result: events.at(-1)!.data as unknown as JobResult }
}

describe('voice mock privacy and provenance', () => {
  it('saves only a scrubbed intent and never runs search/query/cards stages', async () => {
    const api = await mockAPI()
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const { job_id } = await api.analyzeVoice('PRIVATE RAW email@example.test', 'save')
    const { events, result } = await collect(job_id, api.subscribeMockVoice)
    expect(job_id).toMatch(/^j_voice_mock_save_/)
    expect(events.map((event) => event.stage)).toEqual(['extract', 'scrub', 'done'])
    expect(result).toMatchObject({ queries: [], cards: [], egress: [] })
    const { getLibraryItem } = await import('../../api/library')
    expect((await getLibraryItem(job_id)).intent).toEqual(result.intent)
    expect(JSON.stringify(events)).not.toContain('PRIVATE RAW')
    expect(JSON.stringify(await getLibraryItem(job_id))).not.toContain('email@example.test')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('related uses only one selected item’s entities, never the reviewed instruction', async () => {
    const api = await mockAPI()
    const { recordMockResult } = await import('../../api/library')
    recordMockResult({ job_id: 'selected', status: 'done', intent: { intent_type: 'book', summary: 'A public book', public_entities: [{ type: 'book_title', value: 'Public Book' }, { type: 'author', value: 'Demo Author' }], confidence: 1, redaction_counts: {} }, cards: [], queries: [], egress: [], timings_ms: {}, error: null })
    const { job_id } = await api.analyzeVoice('private instruction unrelated Boston', 'related', 'selected')
    const { events, result } = await collect(job_id, api.subscribeMockVoice)
    expect(result.queries[0]).toMatchObject({ text: 'Public Book Demo Author', purpose: 'related' })
    expect(result.intent!.public_entities.map((entity) => entity.value)).toEqual(['Public Book', 'Demo Author'])
    expect(JSON.stringify(events)).not.toContain('private instruction')
    expect(JSON.stringify(events)).not.toContain('Boston')
    await expect(api.analyzeVoice('Find related', 'related')).rejects.toMatchObject({ status: 422 })
  })
  it('event fixtures are voice-specific, fixed date, and air-gap replay has no ingest', async () => {
    const api = await mockAPI()
    const { setOffline } = await import('../../api/privacy')
    await setOffline(true)
    const { job_id } = await api.analyzeVoice('edited private thought', 'explore')
    const { events, result } = await collect(job_id, api.subscribeMockVoice)
    expect(job_id).toMatch(/^j_voice_mock_event_/)
    expect(events[0].stage).toBe('extract')
    expect(events.some((event) => event.stage === 'ingest')).toBe(false)
    expect(result.intent!.public_entities).toContainEqual({ type: 'date', value: '2026-11-14' })
    expect(result.cards).toEqual([])
    expect(result.egress.every((record) => record.blocked)).toBe(true)
    expect(JSON.stringify(events)).not.toContain('edited private thought')
  })
  it('unsubscribe prevents callbacks and local saving', async () => {
    const api = await mockAPI()
    const { job_id } = await api.analyzeVoice('save', 'save')
    const callback = vi.fn(); api.subscribeMockVoice(job_id, callback)()
    await vi.runAllTimersAsync()
    expect(callback).not.toHaveBeenCalled()
    const { listLibrary } = await import('../../api/library')
    expect(await listLibrary()).toEqual([])
  })
})

describe('local voice API', () => {
  it('posts normalized review JSON only on explicit analysis with a 202', async () => {
    vi.stubEnv('VITE_MOCK', '0')
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job_id: 'j_real' }), { status: 202 }))
    vi.stubGlobal('fetch', fetch)
    const api = await import('../../api/voice')
    const signal = new AbortController().signal
    await api.analyzeVoice('  typed\nreview  ', 'explore', null, signal)
    expect(fetch).toHaveBeenCalledWith('/api/voice/analyze', expect.objectContaining({ signal, body: JSON.stringify({ text: 'typed review', action: 'explore', context_library_id: null }) }))
    fetch.mockResolvedValue(new Response('{}', { status: 200 }))
    await expect(api.analyzeVoice('review', 'save')).rejects.toMatchObject({ status: 200 })
  })
  it('posts audio FormData and redacts unknown server error details', async () => {
    vi.stubEnv('VITE_MOCK', '0')
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ transcript: 'hello\nworld', language: 'en', duration_ms: 1000 }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const api = await import('../../api/voice')
    const signal = new AbortController().signal
    expect((await api.transcribeAudio(new Blob(['in memory'], { type: 'audio/webm' }), 'thought.webm', signal)).transcript).toBe('hello world')
    const options = fetch.mock.calls[0][1]
    expect(options.signal).toBe(signal)
    expect(options.body).toBeInstanceOf(FormData)
    expect(options.body.get('audio').name).toBe('thought.webm')
    fetch.mockResolvedValue(new Response(JSON.stringify({ detail: 'PRIVATE server exception' }), { status: 500 }))
    await expect(api.transcribeAudio(new Blob(), 'x')).rejects.toThrow('backend_error')
  })
})
