import type { EgressRecord } from '../types'

export function receiptTotals(records: EgressRecord[]): { sent: number; bytes: number; blocked: number } {
  return records.reduce((totals, record) => {
    if (record.blocked) totals.blocked += 1
    else {
      totals.sent += 1
      totals.bytes += record.bytes_out
    }
    return totals
  }, { sent: 0, bytes: 0, blocked: 0 })
}

export function receiptLabel(records: EgressRecord[], source?: 'voice'): string {
  const { sent, bytes, blocked } = receiptTotals(records)
  if (sent === 0 && blocked > 0) return `Nothing left this device. ${blocked} searches blocked.`
  return `🔒 ${source === 'voice' ? 'Audio and transcript stayed here.' : 'Screenshot stayed here.'} ${sent} text searches sent (${bytes} bytes).${blocked > 0 ? ` ${blocked} searches blocked.` : ''}`
}

export function queryPreview(record: EgressRecord): string {
  try {
    const payload: unknown = JSON.parse(record.payload_preview)
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'query' in payload &&
      typeof payload.query === 'string' && payload.query.trim() &&
      !/data:image|base64/i.test(payload.query)) {
      return payload.query
    }
  } catch {
    // A truncated preview is not safe to display as raw text.
  }
  return 'Query preview unavailable.'
}
