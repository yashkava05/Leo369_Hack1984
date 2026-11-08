import type { Card, CardAction } from '../types'
import type { KeptItem } from './messages'

export const KEPT_KEY = 'latent:kept'
const kinds = new Set(['tickets', 'shop', 'book', 'calendar', 'insight', 'place', 'link', 'related'])
const intents = new Set(['event', 'product', 'book', 'place', 'chart', 'document', 'other'])
const nullableString = (value: unknown) => value === null || typeof value === 'string'

function validAction(value: unknown): value is CardAction {
  if (!value || typeof value !== 'object') return false
  const a = value as CardAction
  if (!['open_url', 'download_ics', 'copy'].includes(a.type) || typeof a.label !== 'string') return false
  if (!nullableString(a.url) || !nullableString(a.text)) return false
  return a.ics === null || !!(a.ics && typeof a.ics.title === 'string' && typeof a.ics.start === 'string'
    && nullableString(a.ics.end) && nullableString(a.ics.location) && nullableString(a.ics.url))
}

function validCard(value: unknown): value is Card {
  if (!value || typeof value !== 'object') return false
  const c = value as Card
  return typeof c.id === 'string' && kinds.has(c.kind) && typeof c.title === 'string'
    && typeof c.source === 'string' && typeof c.score === 'number'
    && [c.subtitle, c.url, c.price, c.snippet].every(nullableString)
    && Array.isArray(c.actions) && c.actions.every(validAction)
}

export function parseKept(parsed: unknown): KeptItem[] {
  if (!Array.isArray(parsed)) return []
  return parsed.filter((v): v is KeptItem => !!v && typeof v.label === 'string'
      && intents.has(v.intent_type) && typeof v.savedAt === 'number' && Number.isFinite(v.savedAt)
      && Array.isArray(v.cards) && v.cards.every(validCard))
      .sort((a, b) => b.savedAt - a.savedAt)
}

export function readKept(): KeptItem[] {
  try { return parseKept(JSON.parse(localStorage.getItem(KEPT_KEY) ?? '[]')) }
  catch { return [] }
}

/** Persist only public card data. No File, object URL, screenshot, event or receipt is saved. */
export function writeKept(items: KeptItem[]): void {
  localStorage.setItem(KEPT_KEY, JSON.stringify(items.map(({ label, intent_type, savedAt, cards }) => (
    { label, intent_type, savedAt, cards }
  ))))
}
