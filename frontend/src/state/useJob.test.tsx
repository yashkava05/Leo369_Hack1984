import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StageEvent } from '../types'

// Drive the real job store with a fake event stream.
let emit: (event: StageEvent) => void = () => {}
vi.mock('../api/events', () => ({
  analyze: async () => ({ job_id: 'j_test' }),
  subscribe: (_jobId: string, onEvent: (event: StageEvent) => void) => {
    emit = onEvent
    return () => {}
  },
}))

const { endsJob, reset, start, useJob } = await import('./useJob')

// Read the shared store the way components do (server render uses the current snapshot).
function Probe() {
  const { status, events, result } = useJob()
  return <pre>{JSON.stringify({ status, events: events.length, cards: result?.cards.length ?? null })}</pre>
}
const read = () => JSON.parse(renderToStaticMarkup(<Probe />).replace(/^<pre>|<\/pre>$/g, '').replace(/&quot;/g, '"'))

const event = (extra: Partial<StageEvent>): StageEvent => ({
  job_id: 'j_test',
  seq: 0,
  ts: 0,
  stage: 'extract',
  status: 'ok',
  message: '',
  local: true,
  data: null,
  ...extra,
})

const blockedSearch = event({
  stage: 'search',
  status: 'error',
  local: false,
  message: 'network ✕ blocked POST api.tavily.com/search · 104 bytes · offline mode',
  data: { host: 'api.tavily.com', path: '/search', bytes_out: 104, blocked: true, reason: 'offline mode' },
})

describe('endsJob', () => {
  it('a blocked network request does not end the job', () => {
    expect(endsJob(blockedSearch)).toBe(false)
  })
  it('a local stage error or an error stage does', () => {
    expect(endsJob(event({ stage: 'extract', status: 'error' }))).toBe(true)
    expect(endsJob(event({ stage: 'error', status: 'error', local: false }))).toBe(true)
  })
  it('ordinary events do not', () => {
    expect(endsJob(event({}))).toBe(false)
  })
})

describe('job store', () => {
  beforeEach(async () => {
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }))
    await start(new File([new Uint8Array([1])], 'doc.png', { type: 'image/png' }))
  })
  afterEach(() => {
    reset()
    vi.unstubAllGlobals()
  })

  it('keeps running past a blocked search and finishes on done', () => {
    expect(read().status).toBe('running')
    emit(blockedSearch)
    expect(read()).toEqual({ status: 'running', events: 1, cards: null })
    emit(event({ stage: 'done', status: 'ok', data: { job_id: 'j_test', status: 'done', cards: [] } }))
    expect(read()).toEqual({ status: 'done', events: 2, cards: 0 })
  })

  it('still fails on a local stage error', () => {
    emit(event({ stage: 'extract', status: 'error', message: 'extract: model crashed' }))
    expect(read().status).toBe('error')
  })
})
