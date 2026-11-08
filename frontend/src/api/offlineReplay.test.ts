import { describe, expect, it } from 'vitest'
import type { JobResult, StageEvent } from '../types'
import concertEvents from './fixtures/concert_flyer.events.json'
import docEvents from './fixtures/sensitive_doc.events.json'
import { offlineReplay } from './offlineReplay'

describe('offlineReplay', () => {
  it('keeps local stages, blocks every search request and finishes with no cards', () => {
    const out = offlineReplay(docEvents as StageEvent[])
    expect(out.map((e) => e.seq)).toEqual(out.map((_, i) => i))
    const stages = out.map((e) => e.stage)
    expect(stages).toContain('extract')
    expect(stages[stages.length - 1]).toBe('done')
    const blocked = out.filter((e) => e.data?.blocked === true)
    expect(blocked).toHaveLength(2)
    expect(blocked.every((e) => !e.local && e.status === 'error' && e.data?.reason === 'offline mode')).toBe(true)
    const result = out[out.length - 1].data as unknown as JobResult
    expect(result.cards).toEqual([])
    expect(result.egress.every((r) => r.blocked && r.reason === 'offline mode')).toBe(true)
  })

  it('leaves the local stages untouched', () => {
    const events = concertEvents as StageEvent[]
    const local = events.filter((e) => ['ingest', 'extract', 'scrub', 'query'].includes(e.stage))
    expect(offlineReplay(events).slice(0, local.length)).toEqual(local)
  })
})
