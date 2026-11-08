import { DEFAULT_COUNT, MAX_COUNT, type ReadScope } from './types'

const NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
}

/** Local, deterministic first guess at the scope; the user reviews and edits it before reading. */
export function scopeFromRequest(text: string): ReadScope {
  const lowered = text.toLowerCase()
  if (/\b(selected|this|open|opened|current)\s+(email|message|mail)\b/.test(lowered)) return { mode: 'selected', count: 1 }
  const match = lowered.match(new RegExp(`\\b(\\d{1,3}|${Object.keys(NUMBERS).join('|')})\\b\\s+(?:\\w+\\s+){0,3}?(?:emails?|messages?|mails?)`))
  const raw = match?.[1]
  const count = raw ? (/^\d+$/.test(raw) ? Number(raw) : NUMBERS[raw]) : DEFAULT_COUNT
  return { mode: /\bunread\b/.test(lowered) ? 'unread' : 'latest', count: clampCount(count) }
}

export function clampCount(count: number): number {
  return Number.isFinite(count) ? Math.max(1, Math.min(MAX_COUNT, Math.round(count))) : DEFAULT_COUNT
}

/** Does the reviewed text look like an email request? Used only to order the review buttons. */
export function mentionsMail(text: string): boolean {
  return /\b(outlook|e-?mails?|inbox|mail)\b/i.test(text)
}
