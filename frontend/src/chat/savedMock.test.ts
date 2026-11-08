import { afterEach, expect, it, vi } from 'vitest'
import concert from '../api/fixtures/concert_flyer.result.json'
import type { JobResult } from '../types'

vi.mock('../api/client', () => ({ API_URL: '', MOCK: true }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it('Delete All in mock mode clears history and stops timers from restoring it', async () => {
  vi.useFakeTimers()
  const data = new Map<string, string>()
  vi.stubGlobal('navigator', { locks: { request: async (_: string, fn: () => unknown) => fn() } })
  vi.stubGlobal('localStorage', {
    get length() { return data.size }, key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key),
  })
  const library = await import('../api/library')
  const store = await import('./store')
  library.recordMockResult(concert as JobResult)
  await store.sendImage(new File(['in-memory test'], 'sample.png', { type: 'image/png' }))
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  await store.clearMemory()
  expect(vi.getTimerCount()).toBe(0)
  await vi.runAllTimersAsync()
  expect(await library.listLibrary()).toEqual([])
  expect(store.chatSnapshot().messages).toHaveLength(1)
  expect(store.chatSnapshot().busy).toBe(false)
})
