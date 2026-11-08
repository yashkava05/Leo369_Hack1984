import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { KeptItem } from './messages'
vi.mock('../api/client', () => ({ API_URL: '', MOCK: false }))
let saved: typeof import('./saved')
let storage: Map<string, string>
let epoch: number
let remote: Map<string, Record<string, unknown>>
let calls: { epoch: number | null; id: string }[]
let available: boolean
const item: KeptItem = { label: 'Lumen Festival', intent_type: 'event', savedAt: 1000, cards: [] }
const queue = () => [...storage.entries()].filter(([key]) => key.startsWith('latent:saved:pending:')).map(([, value]) => JSON.parse(value))
beforeEach(async () => {
  vi.resetModules()
  storage = new Map(); epoch = 0; remote = new Map(); calls = []; available = true
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, operation: () => unknown) => operation() } })
  vi.stubGlobal('localStorage', {
    get length() { return storage.size }, key: (i: number) => [...storage.keys()][i] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!available) throw new Error('offline')
    if (url.includes('/memory?')) { epoch++; remote.clear(); return Response.json({ memory_epoch: epoch }) }
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string)
      calls.push({ epoch: body.memory_epoch, id: body.items[0].id })
      if ((body.memory_epoch ?? 0) !== epoch) return Response.json({}, { status: 409 })
      const results = body.items.map((entry: Record<string, unknown>) => {
        const exists = remote.has(entry.id as string); remote.set(entry.id as string, entry)
        return { id: entry.id, status: exists ? 'exists' : 'saved' }
      })
      return Response.json({ memory_epoch: epoch, results })
    }
    return Response.json({ memory_epoch: epoch, items: [...remote.values()] })
  }))
  saved = await import('./saved')
})
afterEach(() => vi.unstubAllGlobals())
it('imports legacy Kept once, removing originals only after acknowledgement', async () => {
  storage.set('latent:kept', JSON.stringify([item]))
  expect((await saved.syncSaved()).items).toHaveLength(1)
  expect(remote.size).toBe(1); expect(storage.has('latent:kept')).toBe(false); expect(queue()).toEqual([])
  await saved.syncSaved(); expect(calls).toHaveLength(1)
})
it('retains legacy copies when acknowledgement is missing', async () => {
  storage.set('latent:kept', JSON.stringify([item]))
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ memory_epoch: 0, items: [] })).mockResolvedValueOnce(Response.json({ results: [] }))
  expect((await saved.syncSaved()).notice).toContain('unavailable')
  expect(storage.has('latent:kept')).toBe(true); expect(queue()).toHaveLength(1)
})
it('reopens acknowledged previews offline and queues new saves until persistence succeeds', async () => {
  await saved.syncSaved(); await saved.keepSaved(item); available = false
  expect(saved.initialSaved()).toHaveLength(1)
  const state = await saved.keepSaved({ ...item, savedAt: 2000 })
  expect(state.items).toHaveLength(2); expect(state.notice).toContain('unavailable'); expect(queue()).toHaveLength(1)
  available = true
  expect((await saved.syncSaved()).items).toHaveLength(2); expect(queue()).toEqual([])
})
it('never upgrades an offline queue to the new reset epoch', async () => {
  await saved.syncSaved(); available = false; await saved.keepSaved(item); available = true; epoch = 1
  const state = await saved.syncSaved()
  expect(calls.at(-1)?.epoch).toBe(0); expect(state.items).toEqual([]); expect(state.blocked).toHaveLength(1)
  expect(queue()[0].epoch).toBe(0)
  await saved.syncSaved(); expect(calls).toHaveLength(1)
})
it('requires explicit reconciliation for legacy copies after reset; restore creates a new save', async () => {
  epoch = 1; storage.set('latent:kept', JSON.stringify([item]))
  const state = await saved.syncSaved()
  expect(remote.size).toBe(0); expect(state.blocked).toHaveLength(1); expect(queue()[0].epoch).toBeNull()
  const restored = await saved.resolvePending(state.blocked[0].id, true)
  expect(restored.blocked).toEqual([]); expect(restored.items).toHaveLength(1)
  expect(calls.at(-1)?.epoch).toBe(1); expect(calls.at(-1)?.id).not.toBe(state.blocked[0].id)
})
it('discarding a blocked copy never reimports it', async () => {
  epoch = 1; storage.set('latent:kept', JSON.stringify([item]))
  const state = await saved.syncSaved(); await saved.resolvePending(state.blocked[0].id, false)
  expect(queue()).toEqual([]); expect(remote.size).toBe(0); expect(calls).toHaveLength(1)
})
it('tombstone acknowledgements remove replay copies without restoring them', async () => {
  storage.set('latent:kept', JSON.stringify([item]))
  const original = fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ results: [{ id: JSON.parse(init.body as string).items[0].id, status: 'tombstoned' }] })
    return original(url, init)
  }))
  expect((await saved.syncSaved()).items).toEqual([]); expect(queue()).toEqual([]); expect(storage.has('latent:kept')).toBe(false)
})
it('delete-all clears previews, legacy copies and offline saves', async () => {
  await saved.keepSaved(item); available = false; await saved.keepSaved({ ...item, savedAt: 2000 }); available = true
  storage.set('latent:kept', JSON.stringify([item])); await saved.deleteMemory()
  expect(saved.initialSaved()).toEqual([]); expect([...storage.keys()]).toEqual(['latent:saved:epoch']); expect(remote.size).toBe(0); expect(epoch).toBe(1)
})
it('failed deletion preserves browser copies for recovery', async () => {
  await saved.keepSaved(item); available = false
  await expect(saved.deleteMemory()).rejects.toThrow(); expect(saved.initialSaved()).toHaveLength(1)
})
it('a GET started before deletion cannot restore a browser preview', async () => {
  await saved.keepSaved(item)
  let release!: (response: Response) => void
  vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve }))
  const syncing = saved.syncSaved(); await saved.deleteMemory()
  release(Response.json({ memory_epoch: 0, items: [{ id: 'old', label: item.label, intent_type: item.intent_type, saved_at: 1, cards: [] }] }))
  await syncing
  expect(saved.initialSaved()).toEqual([]); expect([...storage.keys()]).toEqual(['latent:saved:epoch'])
})
it('does not claim success when browser storage cannot persist the offline queue', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('quota') } })
  await expect(saved.keepSaved(item)).rejects.toThrow('quota'); expect(calls).toEqual([])
})
it('does not rewrite unchanged previews and cause cross-tab storage loops', async () => {
  await saved.keepSaved(item); const set = vi.spyOn(localStorage, 'setItem')
  await saved.syncSaved(); expect(set).not.toHaveBeenCalled()
})

it('a stale response in another tab cannot overwrite a newer shared reset fence', async () => {
  await saved.keepSaved(item)
  const old = { memory_epoch: 0, items: [...remote.values()] }
  storage.set('latent:saved:epoch', '1')
  storage.delete('latent:saved:snapshot')
  vi.mocked(fetch).mockResolvedValue(Response.json(old))
  await saved.syncSaved()
  expect(saved.initialSaved()).toEqual([])
  expect(storage.has('latent:saved:snapshot')).toBe(false)
})
it('retains saves created in another tab while delete-all is waiting for the server', async () => {
  let release!: (response: Response) => void
  vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve }))
  const deleting = saved.deleteMemory()
  storage.set('latent:saved:pending:new', JSON.stringify({ id: 'new', epoch: 0, item }))
  release(Response.json({ memory_epoch: 1 }))
  await deleting
  expect(queue()).toHaveLength(1)
})
