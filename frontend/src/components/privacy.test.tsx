import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import concertResult from '../api/fixtures/concert_flyer.result.json'
import docResult from '../api/fixtures/sensitive_doc.result.json'
import type { EgressRecord, JobResult } from '../types'
import { AuditDrawerView } from './AuditDrawer'
import { auditRow, summarizeJob } from './privacy.format'

const concert = concertResult as JobResult
const doc = docResult as JobResult

const blocked: EgressRecord = {
  id: 'eg_blocked',
  ts: 1794000009.9,
  method: 'POST',
  host: 'api.tavily.com',
  path: '/search',
  bytes_out: 96,
  payload_preview: '{"query": "internal memo acme corp"}',
  blocked: true,
  reason: 'offline mode',
}

describe('auditRow', () => {
  it('formats a sent record', () => {
    const row = auditRow(concert.egress[0])
    expect(row.target).toBe('POST api.tavily.com/search')
    expect(row.status).toBe('SENT')
    expect(row.reason).toBeNull()
    expect(row.bytes).toBe(concert.egress[0].bytes_out)
    expect(row.preview).toBe(concert.egress[0].payload_preview)
  })

  it('formats a blocked record with its reason', () => {
    const row = auditRow(blocked)
    expect(row.status).toBe('BLOCKED')
    expect(row.reason).toBe('offline mode')
  })
})

describe('summarizeJob', () => {
  it('counts only sent requests and lists queries verbatim', () => {
    const summary = summarizeJob(concert)
    const sent = concert.egress.filter((r) => !r.blocked)
    expect(summary.requests).toBe(sent.length)
    expect(summary.bytes).toBe(sent.reduce((s, r) => s + r.bytes_out, 0))
    expect(summary.queries).toEqual(concert.queries.map((q) => q.text))
    expect(summary.headline).toBe(
      `Left this device: ${summary.requests} requests · ${summary.bytes} bytes · text queries only`,
    )
  })

  it('excludes blocked attempts from the byte/request counts', () => {
    const withBlocked: JobResult = { ...doc, egress: [...doc.egress, blocked] }
    const summary = summarizeJob(withBlocked)
    const sent = doc.egress.filter((r) => !r.blocked)
    expect(summary.requests).toBe(sent.length) // blocked attempt not counted
    expect(summary.queries).toEqual(doc.queries.map((q) => q.text))
  })
})

describe('AuditDrawerView', () => {
  it('renders every record with status, bytes and the query preview', () => {
    const html = renderToStaticMarkup(
      <AuditDrawerView open records={[...concert.egress, blocked]} onToggle={() => {}} />,
    )
    expect(html).toContain('SENT')
    expect(html).toContain('BLOCKED')
    expect(html).toContain('offline mode')
    expect(html).toContain('Lumen Drift Paradise Rock Club Boston December 5 2026 tickets')
    expect(html).toContain('audit-drawer-open')
  })

  it('never leaks an API key or image data across any demo fixture record', () => {
    const records = [...concert.egress, ...doc.egress]
    const html = renderToStaticMarkup(<AuditDrawerView open records={records} onToggle={() => {}} />)
    expect(html.toLowerCase()).not.toContain('tvly-')
    expect(html.toLowerCase()).not.toContain('api_key')
    expect(html).not.toContain('data:image')
    expect(html).not.toContain('base64')
  })

  it('shows an empty state when nothing has left', () => {
    const html = renderToStaticMarkup(<AuditDrawerView open={false} records={[]} onToggle={() => {}} />)
    expect(html).toContain('Nothing has left this device yet.')
  })
})
