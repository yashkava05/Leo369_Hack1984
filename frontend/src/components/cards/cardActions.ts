import { downloadIcs } from '../../lib/ics'
import type { Card, CardAction, CardKind } from '../../types'

/** Kinds built on this device from the screenshot itself rather than from a search result. */
export const LOCAL_KINDS: ReadonlySet<CardKind> = new Set<CardKind>(['calendar', 'place'])

export const isLocalCard = (card: Card): boolean => LOCAL_KINDS.has(card.kind)

/** Only http(s) links are opened; card data comes from the network and must not run script URLs. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
  } catch {
    return null
  }
}

/** Actions to show for a card. Insight cards always offer a copy of their quote. */
export function cardActions(card: Card): CardAction[] {
  const actions = card.actions.filter((a) => a.type !== 'open_url' || safeHttpUrl(a.url ?? card.url))
  if (card.kind === 'insight' && card.snippet && !actions.some((a) => a.type === 'copy')) {
    actions.push({ label: 'Copy', type: 'copy', url: null, ics: null, text: null })
  }
  return actions
}

/** Run an action. Resolves once it has been carried out; rejects when it could not be. */
export async function runAction(action: CardAction, card: Card): Promise<void> {
  switch (action.type) {
    case 'open_url': {
      const url = safeHttpUrl(action.url ?? card.url)
      if (!url) throw new Error('No valid link for this card')
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }
    case 'download_ics': {
      if (!action.ics) throw new Error('No event details for this card')
      downloadIcs(action.ics, card.id)
      return
    }
    case 'copy': {
      const text = action.text || card.snippet
      if (!text) throw new Error('Nothing to copy')
      await navigator.clipboard.writeText(text)
      return
    }
  }
}

/** Wall-clock date and time as written in an ISO string, without shifting into the viewer's zone. */
export function formatEventWhen(iso: string): { day: string; time: string | null } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(iso)
  if (!m) return null
  const [, y, mo, d, h, mi] = m
  const wall = new Date(Date.UTC(+y, +mo - 1, +d, h ? +h : 0, mi ? +mi : 0))
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(wall)
  const time =
    h === undefined
      ? null
      : new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(wall)
  return { day, time }
}
