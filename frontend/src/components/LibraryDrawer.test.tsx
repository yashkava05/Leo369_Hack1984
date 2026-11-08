import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { LibraryItem } from '../api/library'
import { LibraryDrawerView, type LibraryDrawerViewProps } from './LibraryDrawer'

const items: LibraryItem[] = [
  { id: 'j_a', created_at: 1794000000, intent_type: 'event', summary: 'Tame Impala at TD Garden', card_count: 3 },
  { id: 'j_b', created_at: 1793990000, intent_type: 'product', summary: 'Aurora X2 Headphones', card_count: 1 },
]

const props = (extra: Partial<LibraryDrawerViewProps> = {}): LibraryDrawerViewProps => ({
  open: true,
  items,
  query: '',
  type: null,
  error: null,
  onToggle: vi.fn(),
  onQuery: vi.fn(),
  onType: vi.fn(),
  onOpen: vi.fn(),
  onDelete: vi.fn(),
  onWipe: vi.fn(),
  ...extra,
})

describe('LibraryDrawerView', () => {
  it('lists saved intents with type, card count and delete buttons', () => {
    const html = renderToStaticMarkup(<LibraryDrawerView {...props()} />)
    expect(html).toContain('Tame Impala at TD Garden')
    expect(html).toContain('Aurora X2 Headphones')
    expect(html).toContain('3 cards')
    expect(html).toContain('1 card<')
    expect(html).toContain('Delete &quot;Tame Impala at TD Garden&quot;')
    expect(html).toContain('Delete everything')
    expect(html.indexOf('Tame Impala')).toBeLessThan(html.indexOf('Aurora'))
  })

  it('renders a chip per intent type and marks the active one', () => {
    const html = renderToStaticMarkup(<LibraryDrawerView {...props({ type: 'product' })} />)
    for (const t of ['event', 'product', 'book', 'place', 'chart', 'document', 'other']) {
      expect(html).toContain(`>${t}</button>`)
    }
    expect(html).toContain('aria-pressed="true">product<')
    expect(html).toContain('aria-pressed="false">all<')
  })

  it('distinguishes an empty library from an empty search', () => {
    expect(renderToStaticMarkup(<LibraryDrawerView {...props({ items: [] })} />)).toContain('Nothing saved yet.')
    expect(renderToStaticMarkup(<LibraryDrawerView {...props({ items: [], query: 'x' })} />)).toContain(
      'No saved intents match.',
    )
  })

  it('is hidden when closed and shows errors', () => {
    const closed = renderToStaticMarkup(<LibraryDrawerView {...props({ open: false })} />)
    expect(closed).toContain('aria-hidden="true"')
    const failed = renderToStaticMarkup(<LibraryDrawerView {...props({ error: 'GET /api/library failed' })} />)
    expect(failed).toContain('role="alert"')
  })
})
