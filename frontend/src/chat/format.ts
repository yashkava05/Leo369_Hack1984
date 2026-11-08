import type { Entity, Intent, JobResult, StageEvent } from '../types'

export type StepState = 'waiting' | 'running' | 'ok' | 'blocked' | 'error'
export interface WorkStep {
  id: string
  title: string
  tag: 'On device' | 'Internet'
  state: StepState
  detail: string
}

const EMPTY_REPLY = "I couldn't find something to act on in that one. Try a screenshot of an event, a product, a book or a place."

function values(intent: Intent | null): string[] {
  return (intent?.public_entities ?? []).map((entity) => entity.value.trim()).filter(Boolean)
}

function entity(intent: Intent, type: Entity['type']): string {
  return intent.public_entities.find((item) => item.type === type && item.value.trim())?.value.trim() ?? ''
}

export function mapSteps(events: StageEvent[], result?: JobResult): WorkStep[] {
  const final = result ?? (events.findLast((event) => event.stage === 'done')?.data as unknown as JobResult | undefined)
  const steps: WorkStep[] = [
    { id: 'extract', title: 'Reading your screenshot', tag: 'On device', state: 'waiting', detail: '' },
    { id: 'scrub', title: 'Hiding personal details', tag: 'On device', state: 'waiting', detail: '' },
    { id: 'query', title: 'Writing short searches', tag: 'On device', state: 'waiting', detail: `Using only: ${values(final?.intent ?? null).join(', ')}` },
    { id: 'search', title: 'Searching the web', tag: 'Internet', state: 'waiting', detail: '' },
    { id: 'cards', title: 'Putting your options together', tag: 'On device', state: 'waiting', detail: '' },
  ]
  let current = 0
  let count = final?.queries?.length ?? 0
  for (const event of events) {
    if (event.stage === 'query' && Array.isArray(event.data?.queries)) count = event.data.queries.length
    if (event.stage === 'done') continue
    const index = event.stage === 'ingest' ? 0 : steps.findIndex((step) => step.id === event.stage)
    if (index >= 0) current = index
    const step = steps[current]
    if (event.stage === 'error') {
      if (step.state !== 'blocked') step.state = 'error'
      step.detail = event.message
      continue
    }
    if (index < 0) continue
    if (index < 2) step.detail = event.message
    if (index === 4) step.detail = 'Cards built on this device'
    if (event.stage === 'search' && event.data?.blocked === true) {
      step.state = 'blocked'
      const reason = typeof event.data.reason === 'string' && event.data.reason.trim() ? event.data.reason.trim() : 'request blocked'
      step.detail = `Blocked: ${reason}`
    } else if (step.state !== 'blocked' && step.state !== 'error') {
      step.state = event.status === 'error' ? 'error'
        : event.status === 'ok' && event.stage !== 'ingest' ? 'ok' : 'running'
      if (step.state === 'error') step.detail = event.message
    }
  }
  const blocked = final?.egress?.find((record) => record.blocked)
  if (blocked && steps[3].state !== 'blocked') {
    steps[3].state = 'blocked'
    steps[3].detail = `Blocked: ${blocked.reason?.trim() || 'request blocked'}`
  }
  if (final?.status === 'done') {
    for (const step of steps) {
      if (step.state === 'waiting' || step.state === 'running') step.state = 'ok'
    }
  } else if (final?.status === 'error' && steps[current].state !== 'blocked') {
    steps[current].state = 'error'
  }
  if (steps[3].state !== 'blocked' && steps[3].state !== 'error') steps[3].detail = `${count} text searches, no image`
  if (!values(final?.intent ?? null).length) steps[2].detail = 'Using only public details from your screenshot'
  return steps
}

export function replyFor(intent: Intent | null): string {
  if (!intent || !values(intent).length) return EMPTY_REPLY
  const get = (type: Entity['type']) => entity(intent, type)
  const city = get('city')
  switch (intent.intent_type) {
    case 'event': {
      const name = get('performer') || get('event_name')
      const date = get('date')
      return `Looks like you want to see ${name || 'an event'}${city ? ` in ${city}` : ''}${date ? ` on ${date}` : ''}. Here's what I found.`
    }
    case 'product':
      return `You saved ${[get('brand'), get('product')].filter(Boolean).join(' ') || 'a product'}. Here are prices and what reviewers say.`
    case 'book': {
      const author = get('author')
      return `This one's ${get('book_title') || 'a book'}${author ? ` by ${author}` : ''}. Here's where to get it and what it's about.`
    }
    case 'place':
      return `Here's ${get('place') || 'a place'}${city ? ` in ${city}` : ''}.`
    case 'chart':
      return `Here's the latest${get('topic') ? ` on ${get('topic')}` : ''}.`
    case 'document':
      return `This looks like a work document. I kept everything in it on this device and only searched the general topic${get('topic') ? `: ${get('topic')}` : ''}.`
    default:
      return EMPTY_REPLY
  }
}

export type SuggestedAsk = { kind: 'calendar' | 'save'; question: string; primary: string }

export function askFor(result: JobResult): SuggestedAsk | null {
  switch (result.intent?.intent_type) {
    case 'event':
      return result.cards.some((card) => card.kind === 'calendar' && card.actions.some((action) => action.type === 'download_ics'))
        ? { kind: 'calendar', question: 'Want me to put it on your calendar?', primary: 'Add to calendar' } : null
    case 'product':
      return { kind: 'save', question: 'Save this to Kept for later?', primary: 'Save' }
    case 'book':
      return { kind: 'save', question: 'Add it to your reading list?', primary: 'Add to reading list' }
    case 'document':
      return { kind: 'save', question: 'Save these market notes for later?', primary: 'Save notes' }
    default:
      return null
  }
}

export function keptLabel(intent: Intent | null): string {
  return values(intent).join(' ')
}
