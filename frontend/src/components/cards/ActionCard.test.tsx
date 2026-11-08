import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import concertFixture from '../../api/fixtures/concert_flyer.result.json'
import sensitiveFixture from '../../api/fixtures/sensitive_doc.result.json'
import { SAMPLE_CARDS } from '../../pages/sampleCards'
import type { Card, CardKind, JobResult } from '../../types'
import { ActionCard } from './ActionCard'
import { cardActions, formatEventWhen, runAction, safeHttpUrl, safeImageLinkUrl } from './cardActions'

const ALL_CARDS: Card[] = [
  ...(concertFixture as JobResult).cards,
  ...(sensitiveFixture as JobResult).cards,
  ...SAMPLE_CARDS,
]
const ALL_KINDS: CardKind[] = ['tickets', 'shop', 'book', 'calendar', 'insight', 'place', 'link', 'related']
const byId = (id: string) => ALL_CARDS.find((c) => c.id === id)!

describe('ActionCard', () => {
  it('gallery data covers all 8 kinds', () => {
    expect(new Set(ALL_CARDS.map((c) => c.kind))).toEqual(new Set(ALL_KINDS))
  })

  it.each(ALL_CARDS.map((c) => [c.id, c] as const))('renders %s with title and labelled actions', (_, card) => {
    const html = renderToStaticMarkup(<ActionCard card={card} />)
    expect(html).toContain(`data-kind="${card.kind}"`)
    expect(html).toContain('card-title')
    for (const action of cardActions(card)) expect(html).toContain(`aria-label="${action.label}`)
  })

  it('labels local cards as built on-device and network cards with their source', () => {
    expect(renderToStaticMarkup(<ActionCard card={byId('c_calendar')} />)).toContain('Built on-device')
    expect(renderToStaticMarkup(<ActionCard card={byId('c_place')} />)).toContain('Built on-device')
    const tickets = renderToStaticMarkup(<ActionCard card={byId('c_tickets')} />)
    expect(tickets).not.toContain('Built on-device')
    expect(tickets).toContain('ticketmaster.com')
    expect(tickets).toContain('from $45')
  })

  it('shows the event date and time big on calendar cards', () => {
    const html = renderToStaticMarkup(<ActionCard card={byId('c_calendar')} />)
    expect(html).toContain('Sat, Dec 5, 2026')
    expect(html).toContain('8:00 PM')
  })

  it('gives insight cards a copy action', () => {
    expect(cardActions(byId('c_insight')).map((a) => a.type)).toEqual(['copy'])
  })
})

describe('card actions', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('opens links in a new tab with noopener', async () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    const card = byId('c_tickets')
    await runAction(card.actions[0], card)
    expect(open).toHaveBeenCalledWith(card.actions[0].url, '_blank', 'noopener,noreferrer')
  })

  it('refuses non-http links', async () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(safeHttpUrl('not a url')).toBeNull()
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    const card = { ...byId('c_tickets'), url: null }
    const action = { ...card.actions[0], url: 'javascript:alert(1)' }
    await expect(runAction(action, card)).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
    expect(cardActions({ ...card, actions: [action] })).toEqual([])
  })

  it('copies the action text, falling back to the snippet', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const place = byId('c_place')
    await runAction(place.actions[1], place)
    expect(writeText).toHaveBeenLastCalledWith('967 Commonwealth Ave, Boston, MA 02215')
    const insight = byId('c_insight')
    await runAction(cardActions(insight)[0], insight)
    expect(writeText).toHaveBeenLastCalledWith(insight.snippet)
  })

  it('falls back to the snippet when the action text is empty', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const insight = byId('c_insight')
    await runAction({ label: 'Copy', type: 'copy', url: null, ics: null, text: '' }, insight)
    expect(writeText).toHaveBeenLastCalledWith(insight.snippet)
  })

  it('renders two actions with the same type and label without key collisions', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const card = byId('c_tickets')
    const dup = { ...card, actions: [card.actions[0], { ...card.actions[0] }] }
    renderToStaticMarkup(<ActionCard card={dup} />)
    expect(error.mock.calls.filter((c) => String(c[0]).includes('same key'))).toEqual([])
    error.mockRestore()
  })

  it('downloads a text/calendar blob named after the event', async () => {
    const click = vi.fn()
    const anchor = { click, remove: vi.fn(), href: '', download: '', rel: '' }
    vi.stubGlobal('document', { createElement: () => anchor, body: { appendChild: vi.fn() } })
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:ics')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    const card = byId('c_calendar')
    await runAction(card.actions[0], card)
    expect(click).toHaveBeenCalled()
    expect(anchor.download).toBe('lumen-drift-live.ics')
    const blob = createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe('text/calendar;charset=utf-8')
    expect(await blob.text()).toContain('UID:c_calendar@latent.local\r\n')
  })

  it('formats wall-clock times without shifting zones', () => {
    expect(formatEventWhen('2026-12-05T20:00:00-05:00')).toEqual({ day: 'Sat, Dec 5, 2026', time: '8:00 PM' })
    expect(formatEventWhen('2026-12-05')).toEqual({ day: 'Sat, Dec 5, 2026', time: null })
  })
})


describe('visible source citations', () => {
  it('links result sources to their exact page with safe new-tab attributes', () => {
    const html = renderToStaticMarkup(<ActionCard card={byId('c_tickets')} />)
    expect(html).toContain(`href="${byId('c_tickets').url}"`)
    expect(html).toContain('target="_blank" rel="noopener noreferrer"')
    expect(html).toContain('Source: ticketmaster.com')
  })
  it('shows all quick-answer search sources while keeping Copy as the action', () => {
    const card: Card = { ...byId('c_insight'), actions: [
      { label: 'Source: Festival schedule', type: 'open_url', url: 'https://events.example/schedule', ics: null, text: null },
      { label: 'Source: Venue guide', type: 'open_url', url: 'https://venue.example/guide', ics: null, text: null },
    ] }
    const html = renderToStaticMarkup(<ActionCard card={card} />)
    expect(html).toContain('Search sources')
    expect(html).toContain('href="https://events.example/schedule"')
    expect(html).toContain('href="https://venue.example/guide"')
    expect(html).toContain('Festival schedule · events.example')
    expect(cardActions(card).map((action) => action.type)).toEqual(['copy'])
  })
  it('uses the source URL rather than the affiliate purchase URL', () => {
    const card: Card = { ...byId('c_tickets'), url: 'https://tickets.example/buy?affiliate=demo', actions: [
      { label: 'Source: Event listing', type: 'open_url', url: 'https://events.example/listing', ics: null, text: null },
    ] }
    const html = renderToStaticMarkup(<ActionCard card={card} />)
    expect(html).toContain('href="https://events.example/listing"')
    expect(html).not.toContain('href="https://tickets.example/buy?affiliate=demo"')
  })
  it('never fabricates a publisher link for saved answers without a source URL', () => {
    const html = renderToStaticMarkup(<ActionCard card={{ ...byId('c_insight'), source: 'tavily.com', url: null, actions: [] }} />)
    expect(html).toContain('Source links unavailable for this saved answer.')
    expect(html).not.toContain('href=')
  })
  it('filters unsafe citation links, deduplicates URLs, and escapes titles', () => {
    const card: Card = { ...byId('c_insight'), url: null, actions: [
      { label: 'Source: Unsafe', type: 'open_url', url: 'javascript:alert(1)', ics: null, text: null },
      { label: 'Source: <script>test</script>', type: 'open_url', url: 'https://events.example/page', ics: null, text: null },
      { label: 'Source: Duplicate', type: 'open_url', url: 'https://events.example/page', ics: null, text: null },
    ] }
    const html = renderToStaticMarkup(<ActionCard card={card} />)
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<script>')
    expect(html.match(/href=/g)).toHaveLength(1)
  })
  it('keeps local calendar and map cards labelled on-device without web citations', () => {
    for (const id of ['c_calendar', 'c_place']) {
      const html = renderToStaticMarkup(<ActionCard card={byId(id)} />)
      expect(html).toContain('Built on-device')
      expect(html).not.toContain('card-citations')
    }
  })
})


it('opens and copies an image-extracted URL while labelling it on-device', () => {
  const card: Card = { ...byId('c_tickets'), kind: 'link', source: 'on-device', title: 'My website', url: 'https://folio.example', actions: [
    { type: 'open_url', label: 'Open link', url: 'https://folio.example', text: null, ics: null },
    { type: 'copy', label: 'Copy link', url: null, text: 'https://folio.example', ics: null },
  ] }
  const html = renderToStaticMarkup(<ActionCard card={card} />)
  expect(html).toContain('Built on-device')
  expect(html).toContain('Open link')
  expect(html).toContain('Copy link')
  expect(html).not.toContain('card-citations')
})

it('requires a review before opening an ambiguous or cut-off screenshot URL', () => {
  const card: Card = { ...byId('c_tickets'), kind: 'link', source: 'on-device', title: 'Product — unavailable', url: null, subtitle: 'go.example/Fake|GReel2', actions: [] }
  const html = renderToStaticMarkup(<ActionCard card={card} />)
  expect(html).toContain('Review URL')
  expect(html).toContain('Open reviewed link')
  expect(html).toContain('disabled=""')
  expect(html).not.toContain('href=')
})


it.each(['http://localhost:8080/private', 'https://user:pass@folio.example/a', 'https://folio.example/?token=SYNTHETIC', 'https://folio.example/#id_token=SYNTHETIC', 'https://folio.example/#/auth?refresh_token=SYNTHETIC'])('rejects reviewed URLs outside the extraction policy: %s', (url) => {
  expect(safeImageLinkUrl(url)).toBeNull()
})
it('accepts a reviewed public URL and preserves path case', () => {
  expect(safeImageLinkUrl('go.example/FakeIGReel2')).toBe('https://go.example/FakeIGReel2')
})
