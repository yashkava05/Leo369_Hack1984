import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import concert from '../api/fixtures/concert_flyer.result.json'
import type { JobResult, StageEvent } from '../types'

const mocks = vi.hoisted(() => ({ start: vi.fn(), followVoice: vi.fn(() => true), reserveVoiceSlot: vi.fn(() => true), setOffline: vi.fn(), action: vi.fn() }))
vi.mock('../state/useJob', () => ({ start: mocks.start, followVoice: mocks.followVoice, reserveVoiceSlot: mocks.reserveVoiceSlot }))
vi.mock('../api/privacy', () => ({ getOffline: vi.fn().mockResolvedValue(false), setOffline: mocks.setOffline }))
vi.mock('../components/cards/cardActions', () => ({ runAction: mocks.action }))

let store: typeof import('./store')
let storage: Map<string, string>
const result = () => structuredClone(concert) as JobResult
const event = (extra: Partial<StageEvent>): StageEvent => ({ job_id: 'j1', seq: 0, ts: 1, stage: 'extract', status: 'ok', message: 'Read locally', local: true, data: null, ...extra })
const image = () => new File(['pixels'], 'test.png', { type: 'image/png' })
const asks = () => store.chatSnapshot().messages.filter((m) => m.type === 'ask')
const replies = () => store.chatSnapshot().messages.flatMap((m) => m.type === 'agent-text' ? [m.text] : [])

beforeEach(async () => {
  vi.resetModules()
  storage = new Map()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:only-in-memory')
    static revokeObjectURL = vi.fn()
  })
  mocks.start.mockReset().mockResolvedValue(undefined)
  mocks.setOffline.mockReset().mockImplementation(async (value: boolean) => value)
  mocks.action.mockReset().mockResolvedValue(undefined)
  store = await import('./store')
})
afterEach(() => vi.unstubAllGlobals())

describe('conversation turns', () => {
  it('validates uploads without starting a job or persisting image data', async () => {
    await store.sendImage(new File(['x'], 'bad.pdf', { type: 'application/pdf' }))
    await store.sendImage(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }))
    expect(mocks.start).not.toHaveBeenCalled()
    expect(replies().join(' ')).toContain('PNG, JPEG or WebP')
    expect(replies().join(' ')).toContain('over 10 MB')
    expect(storage.size).toBe(0)
  })

  it('retains prior image messages and removes typing at the first extract event', async () => {
    await store.sendImage(image())
    expect(store.chatSnapshot().messages.some((m) => m.type === 'typing')).toBe(true)
    await store.sendImage(image())
    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect(replies().at(-1)).toContain('still on the last one')
    store.syncJob({ status: 'running', events: [event({ stage: 'extract', status: 'start' })] })
    expect(store.chatSnapshot().messages.some((m) => m.type === 'typing')).toBe(false)
    store.syncJob({ status: 'done', result: result(), events: [] })
    expect(asks()).toHaveLength(1)
    expect(store.chatSnapshot().messages.some((m) => m.type === 'receipt')).toBe(true)
    await store.sendImage(image())
    expect(store.chatSnapshot().messages.filter((m) => m.type === 'user-image')).toHaveLength(2)
  })

  it('never acts before approval and prevents repeat actions after choosing', async () => {
    await store.sendImage(image())
    store.syncJob({ status: 'done', result: result(), events: [] })
    expect(mocks.action).not.toHaveBeenCalled()
    await store.chooseAsk(asks()[0].id, true)
    await store.chooseAsk(asks()[0].id, true)
    expect(mocks.action).toHaveBeenCalledTimes(1)
    expect(replies().at(-1)).toBe('Done. Your calendar file is ready.')
    const saved = storage.get('latent:kept')!
    expect(saved).not.toMatch(/blob:|pixels|egress|payload_preview|image\/png/)
    expect(JSON.parse(saved)[0].cards).toEqual(result().cards)
    expect(store.chatSnapshot().messages.some((m) => m.type === 'user-text' && m.text === 'Add to calendar')).toBe(true)
  })

  it('not now never executes or persists an action', async () => {
    await store.sendImage(image())
    store.syncJob({ status: 'done', result: result(), events: [] })
    await store.chooseAsk(asks()[0].id, false)
    expect(mocks.action).not.toHaveBeenCalled()
    expect(storage.size).toBe(0)
    expect(replies().at(-1)).toContain('No problem')
  })

  it('retries an offline run with the same File only after explicit approval', async () => {
    const file = image()
    await store.sendImage(file)
    const offline = result()
    offline.egress = offline.egress.map((r) => ({ ...r, blocked: true, reason: 'offline mode' }))
    store.syncJob({ status: 'done', result: offline, events: [] })
    expect(asks()[0].kind).toBe('resume')
    expect(mocks.setOffline).not.toHaveBeenCalled()
    await store.chooseAsk(asks()[0].id, true)
    expect(mocks.setOffline).toHaveBeenCalledWith(false)
    expect(mocks.start).toHaveBeenNthCalledWith(2, file)
  })

  it('reports a failed air-gap toggle and does not retry the screenshot', async () => {
    await store.sendImage(image())
    const offline = result()
    offline.egress = offline.egress.map((r) => ({ ...r, blocked: true, reason: 'offline mode' }))
    store.syncJob({ status: 'done', result: offline, events: [] })
    mocks.setOffline.mockRejectedValueOnce(new Error('network'))
    await store.chooseAsk(asks()[0].id, true)
    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect(replies().at(-1)).toContain("couldn't change air-gap")
    expect(asks().at(-1)?.choice).toBeUndefined()
    expect(asks()).toHaveLength(2)
  })

  it('reserves the approved screenshot while the air-gap toggle is pending', async () => {
    const approved = image()
    await store.sendImage(approved)
    const offline = result()
    offline.egress = offline.egress.map((r) => ({ ...r, blocked: true, reason: 'offline mode' }))
    store.syncJob({ status: 'done', result: offline, events: [] })
    let finishToggle!: (value: boolean) => void
    mocks.setOffline.mockReturnValueOnce(new Promise<boolean>((resolve) => { finishToggle = resolve }))
    const approval = store.chooseAsk(asks()[0].id, true)
    expect(store.chatSnapshot().busy).toBe(true)
    await store.sendImage(new File(['other'], 'other.png', { type: 'image/png' }))
    expect(mocks.start).toHaveBeenCalledTimes(1)
    finishToggle(false)
    await approval
    expect(mocks.start).toHaveBeenNthCalledWith(2, approved)
  })

  it('offers another save approval if local storage was unavailable', async () => {
    await store.sendImage(image())
    store.syncJob({ status: 'done', result: result(), events: [] })
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('blocked') } })
    await store.chooseAsk(asks()[0].id, true)
    expect(mocks.action).toHaveBeenCalledTimes(1)
    const retry = asks().at(-1)!
    expect(retry.kind).toBe('save')
    expect(retry.choice).toBeUndefined()
    vi.stubGlobal('localStorage', { setItem: (_k: string, v: string) => storage.set('latent:kept', v) })
    await store.chooseAsk(retry.id, true)
    expect(storage.has('latent:kept')).toBe(true)
    expect(mocks.action).toHaveBeenCalledTimes(1)
  })

  it('renders actionable errors for model and API key failures', async () => {
    await store.sendImage(image())
    store.syncJob({ status: 'error', events: [], error: 'Local model unavailable' })
    expect(replies().at(-1)).toContain('Start Ollama')
    await store.sendImage(image())
    const degraded = result()
    degraded.error = 'Web search unavailable'
    store.syncJob({ status: 'done', result: degraded, events: [event({ stage: 'search', local: false, status: 'error', message: 'TAVILY_API_KEY not set' })] })
    expect(replies().join(' ')).toContain('TAVILY_API_KEY')
  })
})


describe('reviewed voice results in chat', () => {
  it('follows an accepted save with no raw transcript or screenshot prompt', () => {
    store.beginVoiceJob('j_voice_save', 'save')
    expect(mocks.followVoice).toHaveBeenCalledWith('j_voice_save')
    const saved = { ...result(), queries: [], cards: [], egress: [] }
    store.syncJob({ status: 'done', result: saved, events: [] })
    expect(store.chatSnapshot().busy).toBe(false)
    expect(replies().at(-1)).toContain('saved in the local library')
    expect(asks()).toHaveLength(0)
    expect(store.chatSnapshot().messages.some((m) => m.type === 'user-text' || m.type === 'user-image')).toBe(false)
    expect(storage.size).toBe(0)
  })
  it('shows blocked voice searches without offering a screenshot retry', () => {
    store.beginVoiceJob('j_voice_event', 'explore')
    const blocked = result()
    blocked.egress = blocked.egress.map((r) => ({ ...r, blocked: true, reason: 'offline mode' }))
    store.syncJob({ status: 'done', result: blocked, events: [] })
    expect(asks()).toHaveLength(0)
    expect(replies().at(-1)).toContain('submit your reviewed thought again')
    expect(mocks.start).not.toHaveBeenCalled()
  })
})


it('reserves voice capture and submission against screenshot uploads', async () => {
  expect(store.setVoiceBusy(true)).toBe(true)
  await store.sendImage(image())
  expect(mocks.start).not.toHaveBeenCalled()
  expect(store.chatSnapshot().voicePending).toBe(true)
  store.setVoiceBusy(false)
  await store.sendImage(image())
  expect(mocks.start).toHaveBeenCalledOnce()
  expect(store.setVoiceBusy(true)).toBe(false)
  expect(store.chatSnapshot().voicePending).toBe(false)
})


it('does not resume an old screenshot while voice owns the shared slot', async () => {
  await store.sendImage(image())
  const blocked = result()
  blocked.egress = blocked.egress.map((r) => ({ ...r, blocked: true, reason: 'offline mode' }))
  store.syncJob({ status: 'done', result: blocked, events: [] })
  const resume = asks()[0]
  expect(store.setVoiceBusy(true)).toBe(true)
  await store.chooseAsk(resume.id, true)
  expect(mocks.setOffline).not.toHaveBeenCalled()
  expect(mocks.start).toHaveBeenCalledTimes(1)
  expect(store.chatSnapshot().voicePending).toBe(true)
  expect(store.chatSnapshot().busy).toBe(false)
})


describe('empty voice search outcomes', () => {
  it.each(['explore', 'related'] as const)('explains a zero-query %s result without claiming content was found', (action) => {
    store.beginVoiceJob('j_no_query', action)
    const empty = { ...result(), queries: [], cards: [], egress: [] }
    store.syncJob({ status: 'done', result: empty, events: [] })
    expect(replies().at(-1)).toContain(action === 'related' ? 'Choose another saved item' : 'name a topic or event and a city')
    expect(replies().join(' ')).not.toContain("Here's what I found")
    expect(asks()).toHaveLength(0)
    expect(store.chatSnapshot().busy).toBe(false)
  })
  it('reports no usable cards instead of a successful discovery', () => {
    store.beginVoiceJob('j_no_results', 'explore')
    store.syncJob({ status: 'done', result: { ...result(), cards: [] }, events: [] })
    expect(replies().join(' ')).toContain('without usable cards')
    expect(replies().join(' ')).not.toContain("Here's what I found")
  })
})


it('keeps locally built voice cards even when no web query was needed', () => {
  store.beginVoiceJob('j_local_cards', 'explore')
  store.syncJob({ status: 'done', result: { ...result(), queries: [], egress: [] }, events: [] })
  expect(store.chatSnapshot().messages.some((message) => message.type === 'cards')).toBe(true)
  expect(replies().join(' ')).not.toContain('I need more public details')
})


it.each(['result', 'stage'])('keeps explicit %s errors when a voice result is empty', (source) => {
  store.beginVoiceJob('j_empty_error', 'explore')
  const empty = { ...result(), queries: [], cards: [], egress: [], error: source === 'result' ? 'TAVILY_API_KEY not set' : null }
  const events = source === 'stage' ? [event({ stage: 'search', status: 'error', local: false, message: 'TAVILY_API_KEY not set' })] : []
  store.syncJob({ status: 'done', result: empty, events })
  expect(replies().join(' ')).toContain('TAVILY_API_KEY')
  expect(replies().join(' ')).not.toContain('I need more public details')
})
