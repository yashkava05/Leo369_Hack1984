import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import concertFixture from '../api/fixtures/concert_flyer.result.json'
import sensitiveFixture from '../api/fixtures/sensitive_doc.result.json'
import type { Card, JobResult } from '../types'
import { ActionCard } from './cards/ActionCard'
import { Dashboard } from './Dashboard'

// The test environment is Node: there is no document, so no WebGL2 and no measured width.
// That is exactly the fallback path, which must render the grid and never a <canvas>.

const CONCERT_CARDS = (concertFixture as JobResult).cards
const DOC_CARDS = (sensitiveFixture as JobResult).cards

describe('Dashboard fallback grid', () => {
  it('renders renderCard(card) for every card in a grid, and no canvas', () => {
    const html = renderToStaticMarkup(
      <Dashboard stage="cards" cards={CONCERT_CARDS} renderCard={(card) => <b data-probe={card.id}>{card.title}</b>} />,
    )
    expect(html).toContain('data-mode="grid"')
    expect(html).toContain('dashboard-grid')
    for (const card of CONCERT_CARDS) expect(html).toContain(`data-probe="${card.id}"`)
    expect(html.match(/data-probe=/g)).toHaveLength(CONCERT_CARDS.length)
    expect(html).not.toContain('<canvas')
  })

  it('renders the real ActionCard with its buttons', () => {
    const html = renderToStaticMarkup(
      <Dashboard stage="cards" cards={DOC_CARDS} renderCard={(card) => <ActionCard card={card} />} />,
    )
    expect(html.match(/class="action-card /g)).toHaveLength(DOC_CARDS.length)
    expect(html).toContain('<button')
  })

  it('keeps every card in the grid, even beyond the 6 shown in 3D', () => {
    const many: Card[] = Array.from({ length: 8 }, (_, i) => ({ ...CONCERT_CARDS[0], id: `c_${i}` }))
    const html = renderToStaticMarkup(
      <Dashboard stage={undefined} cards={many} renderCard={(card) => <i data-probe={card.id} />} />,
    )
    expect(html.match(/data-probe=/g)).toHaveLength(8)
  })

  it('shows a short status line when there are no cards yet', () => {
    expect(renderToStaticMarkup(<Dashboard stage={undefined} cards={[]} renderCard={() => null} />)).toContain(
      'Drop a screenshot',
    )
    expect(renderToStaticMarkup(<Dashboard stage="extract" cards={[]} renderCard={() => null} />)).toContain(
      'Extracting on this device',
    )
  })
})
