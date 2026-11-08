import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { ReceiptsDrawer } from './ReceiptsDrawer'
import type { EgressRecord } from '../types'

vi.mock('../api/client', () => ({ MOCK: false, getEgress: vi.fn() }))

it('keeps a selected turn separate from other jobs even in live mode', () => {
  const record = (query: string): EgressRecord => ({ id: query, ts: 1, method: 'POST', host: 'api.tavily.com', path: '/search', bytes_out: 100, payload_preview: JSON.stringify({ query }), blocked: false, reason: null })
  const a = record('first screenshot query')
  const b = record('different screenshot query')
  const html = renderToStaticMarkup(<ReceiptsDrawer open onClose={() => {}} mockRecords={[a, b]} selectedRecords={[a]} />)
  expect(html).toContain('first screenshot query')
  expect(html).not.toContain('different screenshot query')
  expect(html).toContain('1 text searches sent, 100 bytes. 0 blocked.')
})
