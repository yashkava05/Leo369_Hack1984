import { describe, expect, it } from 'vitest'
import type { Entity, Intent, IntentType, JobResult, StageEvent } from '../types'
import concertEvents from '../api/fixtures/concert_flyer.events.json'
import { offlineReplay } from '../api/offlineReplay'
import { askFor, keptLabel, mapSteps, replyFor } from './format'

function intent(type: IntentType, entities: Partial<Record<Entity['type'], string>> = {}): Intent {
  return {
    intent_type: type, summary: 'PRIVATE SUMMARY', redaction_counts: { PRIVATE: 99 }, confidence: 1,
    public_entities: Object.entries(entities).map(([type, value]) => ({ type, value }) as Entity),
  }
}
function result(value: Intent | null = null): JobResult {
  return { job_id: 'test', status: 'done', intent: value, queries: [], cards: [], egress: [], timings_ms: {}, error: null }
}
function event(stage: StageEvent['stage'], status: StageEvent['status'], data: StageEvent['data'] = null): StageEvent {
  return { job_id: 'test', seq: 0, ts: 0, stage, status, data, local: stage !== 'search', message: 'PRIVATE MESSAGE' }
}
const fallback = "I couldn't find something to act on in that one. Try a screenshot of an event, a product, a book or a place."

describe('replyFor', () => {
  it.each([
    [intent('event', { performer: 'Lumen Drift', event_name: 'Festival', city: 'Boston', date: '2026-12-05' }), "Looks like you want to see Lumen Drift in Boston on 2026-12-05. Here's what I found."],
    [intent('event', { event_name: 'Festival' }), "Looks like you want to see Festival. Here's what I found."],
    [intent('product', { brand: 'Acme', product: 'Headphones' }), 'You saved Acme Headphones. Here are prices and what reviewers say.'],
    [intent('book', { book_title: 'The Test Book', author: 'A. Example' }), "This one's The Test Book by A. Example. Here's where to get it and what it's about."],
    [intent('place', { place: 'Example Cafe', city: 'Boston' }), "Here's Example Cafe in Boston."],
    [intent('chart', { topic: 'Market trends' }), "Here's the latest on Market trends."],
    [intent('document', { topic: 'Market trends' }), 'This looks like a work document. I kept everything in it on this device and only searched the general topic: Market trends.'],
  ])('uses the exact template for %j', (value, expected) => {
    expect(replyFor(value)).toBe(expected)
  })
  it.each([
    [intent('event', { city: 'Boston' }), "Looks like you want to see an event in Boston. Here's what I found."],
    [intent('event', { date: 'Friday' }), "Looks like you want to see an event on Friday. Here's what I found."],
    [intent('product', { product: 'Headphones' }), 'You saved Headphones. Here are prices and what reviewers say.'],
    [intent('product', { brand: 'Acme' }), 'You saved Acme. Here are prices and what reviewers say.'],
    [intent('product', { topic: 'Audio' }), 'You saved a product. Here are prices and what reviewers say.'],
    [intent('book', { book_title: 'The Test Book' }), "This one's The Test Book. Here's where to get it and what it's about."],
    [intent('book', { author: 'A. Example' }), "This one's a book by A. Example. Here's where to get it and what it's about."],
    [intent('book', { topic: 'Fiction' }), "This one's a book. Here's where to get it and what it's about."],
    [intent('place', { place: 'Example Cafe' }), "Here's Example Cafe."],
    [intent('place', { city: 'Boston' }), "Here's a place in Boston."],
    [intent('chart', { metric: 'Revenue' }), "Here's the latest."],
    [intent('document', { public_org: 'Example Co' }), 'This looks like a work document. I kept everything in it on this device and only searched the general topic.'],
  ])('omits missing values gracefully for %j', (value, expected) => {
    expect(replyFor(value)).toBe(expected)
    expect(replyFor(value)).not.toMatch(/undefined|\b(in|on|by)\./)
  })
  it.each<IntentType>(['event', 'product', 'book', 'place', 'chart', 'document', 'other'])('falls back for %s without usable entities', (type) => {
    expect(replyFor(intent(type))).toBe(fallback)
    expect(replyFor(intent(type, { topic: '   ' }))).toBe(fallback)
  })
  it('handles null and other intents', () => {
    expect(replyFor(null)).toBe(fallback)
    expect(replyFor(intent('other', { topic: 'Something' }))).toBe(fallback)
  })
})

describe('mapSteps', () => {
  it('starts with five waiting steps and fixed titles and tags', () => {
    expect(mapSteps([]).map(({ id, title, tag, state }) => ({ id, title, tag, state }))).toEqual([
      { id: 'extract', title: 'Reading your screenshot', tag: 'On device', state: 'waiting' },
      { id: 'scrub', title: 'Hiding personal details', tag: 'On device', state: 'waiting' },
      { id: 'query', title: 'Writing short searches', tag: 'On device', state: 'waiting' },
      { id: 'search', title: 'Searching the web', tag: 'Internet', state: 'waiting' },
      { id: 'cards', title: 'Putting your options together', tag: 'On device', state: 'waiting' },
    ])
  })
  it('keeps reading running across ingest ok until extraction completes', () => {
    const events: StageEvent[] = []
    for (const [stage, status, expected] of [
      ['ingest', 'start', 'running'], ['ingest', 'ok', 'running'],
      ['extract', 'start', 'running'], ['extract', 'progress', 'running'], ['extract', 'ok', 'ok'],
    ] as const) {
      events.push(event(stage, status))
      expect(mapSteps(events)[0].state).toBe(expected)
      expect(mapSteps(events)[1].state).toBe('waiting')
    }
  })
  it.each(['scrub', 'query', 'search', 'cards'] as const)('tracks %s start, progress and completion', (stage) => {
    for (const status of ['start', 'progress', 'ok'] as const) {
      expect(mapSteps([event(stage, status)]).find((step) => step.id === stage)?.state).toBe(status === 'ok' ? 'ok' : 'running')
    }
  })
  it('counts query arrays in live and fixture formats without displaying query text', () => {
    for (const queries of [['PRIVATE QUERY', 'SECOND QUERY'], [{ text: 'PRIVATE QUERY' }, { text: 'SECOND QUERY' }]]) {
      const steps = mapSteps([event('query', 'ok', { queries }), event('search', 'start')])
      expect(steps[3].detail).toBe('2 text searches, no image')
      expect(JSON.stringify(steps)).not.toContain('PRIVATE')
    }
  })
  it('uses final queries for the count and public entities for the query detail', () => {
    const done = result(intent('product', { brand: 'Acme', product: 'Headphones' }))
    done.queries = [{ text: 'PRIVATE QUERY', purpose: 'shopping', topic: 'general', include_domains: [] }]
    expect(mapSteps([], done)[2].detail).toBe('Using only: Acme, Headphones')
    expect(mapSteps([], done)[3].detail).toBe('1 text searches, no image')
    expect(mapSteps([], done).every((step) => step.state === 'ok')).toBe(true)
  })
  it('uses live query counts while a running result snapshot is still empty', () => {
    const live = { ...result(), status: 'running' as const }
    expect(mapSteps([event('query', 'ok', { queries: ['first', 'second'] })], live)[3].detail).toBe('2 text searches, no image')
  })
  it('formats completed fixture events without a separate result', () => {
    const steps = mapSteps(concertEvents as StageEvent[])
    expect(steps.every((step) => step.state === 'ok')).toBe(true)
    expect(steps[2].detail).toBe('Using only: Lumen Drift, Paradise Rock Club, Boston, 2026-12-05, 20:00')
    expect(steps[3].detail).toBe('2 text searches, no image')
  })
  it('keeps offline replay blocked after later search ok and done', () => {
    const events = offlineReplay(concertEvents as StageEvent[])
    const blockedIndex = events.findIndex((value) => value.data?.blocked)
    for (let end = blockedIndex + 1; end <= events.length; end++) {
      expect(mapSteps(events.slice(0, end))[3]).toMatchObject({ state: 'blocked', detail: 'Blocked: offline mode' })
    }
    expect(mapSteps(events)[4].state).toBe('ok')
  })
  it('recognizes blocked egress in a result alone and gives a fallback reason', () => {
    const done = concertEvents.at(-1)?.data as unknown as JobResult
    const blocked = { ...done, egress: done.egress.map((record) => ({ ...record, blocked: true, reason: 'offline mode' })) }
    expect(mapSteps([], blocked)[3]).toMatchObject({ state: 'blocked', detail: 'Blocked: offline mode' })
    expect(mapSteps([event('search', 'error', { blocked: true })])[3]).toMatchObject({ state: 'blocked', detail: 'Blocked: request blocked' })
  })
  it('keeps nonoffline network failures as errors after search ok and completion', () => {
    const events = [event('search', 'start'), { ...event('search', 'error', { blocked: false, reason: 'timeout' }), message: 'Tavily timed out' }, event('search', 'ok')]
    expect(mapSteps(events, result())[3].state).toBe('error')
    expect(mapSteps(events)[3].detail).toBe('Tavily timed out')
  })
  it.each(['ingest', 'extract', 'scrub', 'query', 'cards'] as const)('attributes generic terminal errors to the current %s step', (stage) => {
    const id = stage === 'ingest' ? 'extract' : stage
    expect(mapSteps([event(stage, 'start'), event('error', 'error')]).find((step) => step.id === id)?.state).toBe('error')
    expect(mapSteps([event(stage, 'error'), event(stage, 'ok')]).find((step) => step.id === id)?.state).toBe('error')
  })
  it('attributes an early error to reading and a result failure to the current step', () => {
    expect(mapSteps([event('error', 'error')])[0].state).toBe('error')
    expect(mapSteps([event('query', 'start')], { ...result(), status: 'error' })[2].state).toBe('error')
  })
  it('does not mutate its events or result', () => {
    const events = concertEvents as StageEvent[]
    const before = JSON.stringify(events)
    mapSteps(events, events.at(-1)?.data as unknown as JobResult)
    expect(JSON.stringify(events)).toBe(before)
  })
})

describe('askFor', () => {
  it.each([
    ['product', { kind: 'save', question: 'Save this to Kept for later?', primary: 'Save' }],
    ['book', { kind: 'save', question: 'Add it to your reading list?', primary: 'Add to reading list' }],
    ['document', { kind: 'save', question: 'Save these market notes for later?', primary: 'Save notes' }],
  ] as const)('offers the exact %s ask', (type, expected) => {
    expect(askFor(result(intent(type)))).toEqual(expected)
  })
  it('requires an event intent and a calendar card with a download action', () => {
    const done = concertEvents.at(-1)?.data as unknown as JobResult
    expect(askFor(done)).toEqual({ kind: 'calendar', question: 'Want me to put it on your calendar?', primary: 'Add to calendar' })
    expect(askFor({ ...done, cards: [] })).toBeNull()
    expect(askFor({ ...done, cards: done.cards.map((card) => ({ ...card, actions: [] })) })).toBeNull()
    expect(askFor({ ...done, cards: done.cards.map((card) => ({ ...card, kind: 'link' })) })).toBeNull()
    expect(askFor({ ...done, intent: null })).toBeNull()
  })
  it.each<IntentType>(['chart', 'place', 'other'])('has no %s ask', (type) => {
    expect(askFor(result(intent(type)))).toBeNull()
  })
})

describe('public fields only', () => {
  it.each<IntentType>(['event', 'product', 'book', 'place', 'chart', 'document', 'other'])('never reads summary or redactions for %s', (type) => {
    const value = intent(type, { topic: 'Public topic' })
    for (const key of ['summary', 'redaction_counts']) {
      Object.defineProperty(value, key, { get() { throw new Error(`Read private ${key}`) } })
    }
    const done = result(value)
    const progress = event('query', 'ok', { queries: ['PRIVATE QUERY'] })
    Object.defineProperty(progress, 'message', { get() { throw new Error('Read free text') } })
    expect(replyFor(value)).not.toContain('PRIVATE')
    expect(keptLabel(value)).toBe('Public topic')
    expect(mapSteps([progress], done)[2].detail).toBe('Using only: Public topic')
    expect(() => askFor(done)).not.toThrow()
  })
  it('labels kept items with only trimmed public values and no summary fallback', () => {
    expect(keptLabel(intent('book', { book_title: '  Test Book ', author: 'A. Example', topic: '  ' }))).toBe('Test Book A. Example')
    expect(keptLabel(intent('document'))).toBe('')
    expect(keptLabel(null)).toBe('')
  })
})
