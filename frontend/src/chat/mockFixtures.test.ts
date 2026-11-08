import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobResult, StageEvent } from '../types'
import { analyze, subscribe } from '../api/events'

const offline = vi.hoisted(() => ({ value: false }))
vi.mock('../api/client', () => ({ API_URL: 'http://localhost:8000', MOCK: true }))
vi.mock('../api/privacy', () => ({ isMockOffline: () => offline.value }))
afterEach(() => { vi.useRealTimers(); offline.value = false })

async function replay(name: string): Promise<StageEvent[]> {
  const { job_id } = await analyze(new File(['sample'], name, { type: 'image/png' }))
  const events: StageEvent[] = []
  const stop = subscribe(job_id, (event) => events.push(event))
  await vi.advanceTimersByTimeAsync(20000)
  stop()
  return events
}

describe('chat samples on the existing event API', () => {
  it.each([
    ['concert_ig.png', 'event'], ['product_amazon.png', 'product'],
    ['book_goodreads.png', 'book'], ['doc_internal_email.png', 'document'],
  ])('%s produces its own complete, correctly typed result', async (filename, type) => {
    vi.useFakeTimers()
    const events = await replay(filename)
    const result = events.at(-1)?.data as unknown as JobResult
    expect(events.at(-1)?.stage).toBe('done')
    expect(result.status).toBe('done')
    expect(result.intent?.intent_type).toBe(type)
    expect(result.cards.length).toBeGreaterThan(0)
    expect(events.some((e) => e.stage === 'search' && !e.local)).toBe(true)
    expect(result.egress.every((r) => r.id.startsWith(result.job_id))).toBe(true)
  })

  it('keeps every sample local when offline and leaves the online fixture unchanged', async () => {
    vi.useFakeTimers()
    for (const filename of ['concert_ig.png', 'product_amazon.png', 'book_goodreads.png', 'doc_internal_email.png']) {
      offline.value = true
      const blocked = await replay(filename)
      const offlineResult = blocked.at(-1)?.data as unknown as JobResult
      expect(offlineResult.egress.length).toBeGreaterThan(0)
      expect(offlineResult.egress.every((r) => r.blocked && r.reason === 'offline mode')).toBe(true)
      expect(blocked.some((e) => e.data?.blocked === true)).toBe(true)
      offline.value = false
      const online = (await replay(filename)).at(-1)?.data as unknown as JobResult
      expect(online.egress.every((r) => !r.blocked)).toBe(true)
      expect(online.cards.length).toBeGreaterThan(0)
    }
  })
})
