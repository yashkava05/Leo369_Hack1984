import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import concertEvents from '../api/fixtures/concert_flyer.events.json'
import concertResult from '../api/fixtures/concert_flyer.result.json'
import docEvents from '../api/fixtures/sensitive_doc.events.json'
import docResult from '../api/fixtures/sensitive_doc.result.json'
import type { JobResult, StageEvent } from '../types'
import { TerminalView } from './Terminal'
import { buildLines, counters, eventLine, formatCounters, formatElapsed, lineToText, terminalModel, typingMs } from './Terminal.format'

const FIXTURES = [
  ['concert_flyer', concertEvents as StageEvent[], concertResult as JobResult],
  ['sensitive_doc', docEvents as StageEvent[], docResult as JobResult],
] as const

const netEvent = (data: Record<string, unknown>, extra: Partial<StageEvent> = {}): StageEvent => ({
  job_id: 'j_test',
  seq: 9,
  ts: 107.1,
  stage: 'search',
  status: 'progress',
  message: 'search: POST api.tavily.com/search',
  local: false,
  data,
  ...extra,
})

describe('formatElapsed', () => {
  it('formats mm:ss.cc', () => {
    expect(formatElapsed(0)).toBe('00:00.00')
    expect(formatElapsed(1.42)).toBe('00:01.42')
    expect(formatElapsed(6.8)).toBe('00:06.80')
    expect(formatElapsed(75.051)).toBe('01:15.05')
  })
})

describe.each(FIXTURES)('%s fixture', (_, events, result) => {
  it('renders every event as one line with the right tag and time', () => {
    const lines = buildLines(events, result)
    expect(lines).toHaveLength(events.length)
    lines.forEach((line, i) => {
      const e = events[i]
      expect(line.tag).toBe(e.local ? 'LOCAL' : 'NET')
      expect(line.tone).toBe(e.local ? 'local' : 'net')
      expect(line.stage).toBe(e.stage)
      expect(line.time).toBe(formatElapsed(e.ts - events[0].ts))
    })
    expect(lines[0].time).toBe('00:00.00')
  })

  it('counters equal sums over result.egress after done', () => {
    const c = counters(events, result)
    const sent = result.egress.filter((r) => !r.blocked)
    expect(c).toEqual({
      requests: sent.length,
      bytes: sent.reduce((s, r) => s + r.bytes_out, 0),
      imageBytes: 0,
      blocked: result.egress.length - sent.length,
    })
  })

  it('renders all lines instantly with reduced motion', () => {
    const model = terminalModel(events, result)
    const html = renderToStaticMarkup(<TerminalView lines={model.lines} counters={model.counters} instant />)
    expect(html.match(/data-testid="terminal-line"/g)).toHaveLength(events.length)
    expect(html).toContain('Image bytes sent: <b>0</b>')
    expect(html).toContain('title="Enforced: requests over 4 KB or containing base64 blobs are blocked"')
    expect(html).not.toContain('terminal-caret')
  })
})

describe('fixture counter values', () => {
  it('concert_flyer: 2 requests, 307 B, 0 blocked', () => {
    expect(formatCounters(counters(concertEvents as StageEvent[], concertResult as JobResult))).toBe(
      'Outbound requests: 2 · Bytes sent: 307 · Image bytes sent: 0 · Blocked: 0',
    )
  })
  it('sensitive_doc: 2 requests, 212 B, 0 blocked', () => {
    expect(formatCounters(counters(docEvents as StageEvent[], docResult as JobResult))).toBe(
      'Outbound requests: 2 · Bytes sent: 212 · Image bytes sent: 0 · Blocked: 0',
    )
  })
})

describe('line format', () => {
  it('matches the issue layout for local and network lines', () => {
    const local = eventLine(
      { ...netEvent({}), stage: 'extract', status: 'start', local: true, data: null, ts: 101.42, message: 'extract: running qwen2.5vl:3b on-device…' },
      100,
    )
    expect(lineToText(local)).toBe('[00:01.42] LOCAL  extract   Running qwen2.5vl:3b on-device…')
    const net = eventLine(netEvent({ host: 'api.tavily.com', path: '/search', bytes_out: 214, blocked: false }), 100)
    expect(lineToText(net)).toBe('[00:07.10] NET    search    POST api.tavily.com/search · 214 B · image data 0 B')
  })

  it('shows blocked requests in red with their reason', () => {
    const line = eventLine(
      netEvent({ host: 'api.tavily.com', path: '/search', bytes_out: 0, blocked: true, reason: 'air-gap enabled' }),
      100,
    )
    expect(line.tone).toBe('blocked')
    expect(line.text).toContain('BLOCKED')
    expect(line.text).toContain('air-gap enabled')
    const html = renderToStaticMarkup(<TerminalView lines={[line]} counters={counters([])} instant />)
    expect(html).toContain('tone-blocked')
  })

  it('appends blocked egress records from the result when no live event showed them', () => {
    const events = concertEvents as StageEvent[]
    const result: JobResult = {
      ...(concertResult as JobResult),
      egress: [
        { id: 'eg_9', ts: 1, method: 'POST', host: 'api.tavily.com', path: '/search', bytes_out: 90, payload_preview: '', blocked: true, reason: 'air-gap enabled' },
      ],
    }
    const lines = buildLines(events, result)
    expect(lines).toHaveLength(events.length + 1)
    expect(lines.at(-1)!.tone).toBe('blocked')
    expect(lines.at(-1)!.text).toContain('air-gap enabled')
    expect(counters(events, result)).toEqual({ requests: 0, bytes: 0, imageBytes: 0, blocked: 1 })
  })

  it('counts live network events before done', () => {
    const events = [
      netEvent({ host: 'api.tavily.com', path: '/search', bytes_out: 214, blocked: false }),
      netEvent({ host: 'api.tavily.com', path: '/search', bytes_out: 120, blocked: false }, { seq: 10 }),
      netEvent({ host: 'api.exa.ai', path: '/search', bytes_out: 5000, blocked: true, reason: 'too large' }, { seq: 11 }),
    ]
    expect(counters(events)).toEqual({ requests: 2, bytes: 334, imageBytes: 0, blocked: 1 })
  })

  it('marks error events red', () => {
    const line = eventLine({ ...netEvent({}), stage: 'error', status: 'error', local: true, data: null, message: 'error: model timed out' }, 100)
    expect(line.tone).toBe('error')
  })

  it('caps the typewriter at 400 ms per line', () => {
    expect(typingMs('abcde')).toBe(40)
    expect(typingMs('x'.repeat(500))).toBe(400)
  })
})
