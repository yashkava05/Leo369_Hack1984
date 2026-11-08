import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { EgressRecord } from '../types'
import { queryPreview, receiptLabel, receiptTotals } from './receipts'
import { ReceiptsDrawer } from './ReceiptsDrawer'
import { getEgress } from '../api/client'

vi.mock('../api/client', () => ({ MOCK: true, getEgress: vi.fn() }))

function record(overrides: Partial<EgressRecord> = {}): EgressRecord {
  return {
    id: 'sent', ts: 1794000000, method: 'POST', host: 'api.tavily.com', path: '/search',
    bytes_out: 48, payload_preview: '{"query":"public concert tickets"}', blocked: false,
    reason: null, ...overrides,
  }
}

describe('receiptTotals', () => {
  it('counts sent bytes, excluding attempted bytes from blocked requests', () => {
    expect(receiptTotals([record(), record({ bytes_out: 12 }), record({ blocked: true, bytes_out: 999 })]))
      .toEqual({ sent: 2, bytes: 60, blocked: 1 })
  })

  it('handles empty and entirely blocked records', () => {
    expect(receiptTotals([])).toEqual({ sent: 0, bytes: 0, blocked: 0 })
    expect(receiptTotals([record({ blocked: true })])).toEqual({ sent: 0, bytes: 0, blocked: 1 })
  })
})

describe('receiptLabel', () => {
  it('uses the normal screenshot receipt for sent and empty records', () => {
    expect(receiptLabel([record()])).toBe('🔒 Screenshot stayed here. 1 text searches sent (48 bytes).')
    expect(receiptLabel([])).toBe('🔒 Screenshot stayed here. 0 text searches sent (0 bytes).')
  })

  it('says nothing left only when every search was blocked', () => {
    expect(receiptLabel([record({ blocked: true }), record({ blocked: true })]))
      .toBe('Nothing left this device. 2 searches blocked.')
  })

  it('accurately reports both sent and blocked searches in a mixed result', () => {
    expect(receiptLabel([record(), record({ blocked: true, bytes_out: 999 })]))
      .toBe('🔒 Screenshot stayed here. 1 text searches sent (48 bytes). 1 searches blocked.')
  })
})

describe('queryPreview', () => {
  it('returns only the top-level query, excluding headers, API keys and image fields', () => {
    const payload_preview = JSON.stringify({
      headers: { Authorization: 'Bearer fake-secret' }, api_key: 'fake-key',
      image: 'data:image/png;base64,fake-image', query: 'public concert tickets',
    })
    expect(queryPreview(record({ payload_preview }))).toBe('public concert tickets')
  })

  it('preserves escaped characters in a valid query as plain text', () => {
    const query = 'concert "tickets" <script>alert("fake")</script>'
    expect(queryPreview(record({ payload_preview: JSON.stringify({ query }) }))).toBe(query)
  })

  it.each([
    '{"query":"public concert tickets", "headers":{"Authorization":"fake-secret"',
    '{"query":"unterminated fake-secret',
    '{"headers":{"query":"nested fake-secret"}}',
    '{"query":{"api_key":"fake-secret"}}',
    '{"query":["fake-secret"]}',
    '{"query":null}',
    '{"query":"   "}',
    '{"query":"data:image/png;base64,fake-image"}',
    '[{"query":"fake-secret"}]',
    'null',
    'Authorization: Bearer fake-secret',
    '',
  ])('fails closed for unsafe or unavailable preview %s', (payload_preview) => {
    expect(queryPreview(record({ payload_preview }))).toBe('Query preview unavailable.')
  })
})

describe('ReceiptsDrawer markup', () => {
  const render = (open: boolean, mockRecords: EgressRecord[]) => renderToStaticMarkup(
    createElement(ReceiptsDrawer, { open, mockRecords, onClose: () => {} }),
  )

  it('renders an accessible dialog with exact totals and newest searches first', () => {
    const records = [record(), record({
      id: 'blocked', ts: 1794000001, blocked: true, bytes_out: 999, reason: 'offline mode',
      payload_preview: '{"query":"newest search"}',
    })]
    const html = render(true, records)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    const titleId = html.match(/aria-labelledby="([^"]+)"/)?.[1]
    expect(titleId).toBeTruthy()
    expect(html).toContain(`id="${titleId}">What left this device</h2>`)
    expect(html).toContain('aria-label="Close receipts"')
    expect(html).toContain('Image data sent: 0 bytes. 1 text searches sent, 48 bytes. 1 blocked.')
    expect(html).toContain('Sent 48 bytes')
    expect(html).toContain('Blocked: offline mode')
    expect(html.indexOf('newest search')).toBeLessThan(html.indexOf('public concert tickets'))
    expect(records[0].id).toBe('sent')
    expect(getEgress).not.toHaveBeenCalled()
  })

  it('does not render raw payloads, keys, headers, image data or executable markup', () => {
    const html = render(true, [record({ payload_preview: JSON.stringify({
      query: '<script>fake query</script>', headers: { Authorization: 'fake-secret' },
      api_key: 'fake-key', image: 'data:image/png;base64,fake-image',
    }) }), record({ id: 'truncated', payload_preview: '{"query":"incomplete", "api_key":"fake-secret' })])
    expect(html).toContain('&lt;script&gt;fake query&lt;/script&gt;')
    expect(html).toContain('Query preview unavailable.')
    for (const secret of ['<script>', 'Authorization', 'fake-secret', 'api_key', 'fake-key', 'data:image', 'base64']) {
      expect(html).not.toContain(secret)
    }
  })

  it('renders nothing while closed and an empty state while open without records', () => {
    expect(render(false, [record()])).toBe('')
    expect(render(true, [])).toContain('No searches recorded yet.')
  })
})
