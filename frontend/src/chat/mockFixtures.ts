import type { JobResult, StageEvent } from '../types'
import product from './fixtures/product.result.json'
import book from './fixtures/book.result.json'

function eventsFor(result: JobResult): StageEvent[] {
  const event = (stage: StageEvent['stage'], status: StageEvent['status'], message: string, local = true, data: StageEvent['data'] = null): StageEvent => (
    { job_id: result.job_id, seq: 0, ts: 0, stage, status, message, local, data }
  )
  return [
    event('ingest', 'start', 'Reading screenshot in memory'),
    event('ingest', 'ok', 'Image decoded; metadata removed'),
    event('extract', 'start', 'Finding public details with the local model'),
    event('extract', 'ok', `Read ${result.intent?.public_entities.length ?? 0} public details`),
    event('scrub', 'start', 'Checking for personal details'),
    event('scrub', 'ok', 'Only public details kept'),
    event('query', 'ok', `Built ${result.queries.length} short text searches`, true, { queries: result.queries.map((q) => q.text) }),
    event('search', 'start', 'Searching with public details only', false),
    event('search', 'ok', `${result.egress.length} text searches, no image`, false),
    event('cards', 'ok', 'Cards built on this device', true, { count: result.cards.length }),
    event('done', 'ok', 'Your options are ready', true, result as unknown as StageEvent['data']),
  ].map((e, seq) => ({ ...e, seq, ts: 1794000000 + seq * 0.4 }))
}

export const CHAT_FIXTURES: Record<string, StageEvent[]> = {
  product: eventsFor(product as JobResult),
  book: eventsFor(book as JobResult),
}
