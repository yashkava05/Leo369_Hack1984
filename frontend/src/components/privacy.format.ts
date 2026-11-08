// Pure formatting for the privacy-proof views (issue #16). Kept out of the .tsx files so
// they can be unit-tested without a DOM and so the components export only components.
import type { EgressRecord, JobResult } from '../types'

export interface AuditRow {
  id: string
  time: string // local wall-clock HH:MM:SS
  target: string // "POST api.tavily.com/search"
  bytes: number
  status: 'SENT' | 'BLOCKED'
  reason: string | null
  preview: string // monospace JSON body preview, API key already removed by the backend
}

export function formatTime(ts: number): string {
  // Egress timestamps are epoch seconds (float).
  return new Date(ts * 1000).toLocaleTimeString()
}

export function auditRow(record: EgressRecord): AuditRow {
  return {
    id: record.id,
    time: formatTime(record.ts),
    target: `${record.method} ${record.host}${record.path}`,
    bytes: record.bytes_out,
    status: record.blocked ? 'BLOCKED' : 'SENT',
    reason: record.reason,
    preview: record.payload_preview,
  }
}

export interface DeviceSummary {
  requests: number // requests that actually left (not blocked)
  bytes: number
  queries: string[] // verbatim query strings sent for this job
  headline: string
}

export function summarizeJob(result: JobResult): DeviceSummary {
  const sent = result.egress.filter((r) => !r.blocked)
  const requests = sent.length
  const bytes = sent.reduce((total, r) => total + r.bytes_out, 0)
  const queries = result.queries.map((q) => q.text)
  return {
    requests,
    bytes,
    queries,
    headline: `Left this device: ${requests} requests · ${bytes} bytes · text queries only`,
  }
}
