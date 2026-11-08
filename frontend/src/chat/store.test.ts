import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import concert from '../api/fixtures/concert_flyer.result.json'
import type { JobResult, StageEvent } from '../types'

const mocks = vi.hoisted(() => ({ start: vi.fn(), reset: vi.fn(), setOffline: vi.fn(), action: vi.fn() }))
vi.mock('./saved', async () => {
  const { readKept, writeKept } = await import('./kept')
  return {
    initialSaved: readKept,
    keepSaved: async (item: import('./messages').KeptItem) => {
      writeKept([item, ...readKept()])
      return { items: readKept(), blocked: [], notice: '' }
    },
    syncSaved: async () => ({ items: readKept(), blocked: [], notice: '' }),
    resolvePending: vi.fn(), deleteMemory: vi.fn(),
  }
})
vi.mock('../state/useJob', () => ({ start: mocks.start, reset: mocks.reset }))
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

it('Delete All resets the active job and releases the conversation previews', async () => {
  await store.sendImage(image())
  await store.clearMemory()
  expect(mocks.reset).toHaveBeenCalled()
  expect(store.chatSnapshot().busy).toBe(false)
  expect(store.chatSnapshot().kept).toEqual([])
  expect(store.chatSnapshot().messages).toHaveLength(1)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:only-in-memory')
})
