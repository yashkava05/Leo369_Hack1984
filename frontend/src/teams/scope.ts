import { DEFAULT_COUNT, MAX_COUNT, type TeamsScope } from './types'

const NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
}

export function clampCount(count: number): number {
  return Number.isFinite(count) ? Math.max(1, Math.min(MAX_COUNT, Math.round(count))) : DEFAULT_COUNT
}

/** Local, deterministic first guess at the scope; the user reviews and edits it before reading. */
export function teamsScopeFromRequest(text: string): TeamsScope {
  const lowered = text.toLowerCase()
  const match = lowered.match(new RegExp(`\\b(\\d{1,3}|${Object.keys(NUMBERS).join('|')})\\b\\s+(?:\\w+\\s+){0,3}?(?:messages?|posts?|chats?)`))
  const raw = match?.[1]
  const count = clampCount(raw ? (/^\d+$/.test(raw) ? Number(raw) : NUMBERS[raw]) : DEFAULT_COUNT)
  const mode = /\bunread\b/.test(lowered) ? 'unread' : /\btoday('s)?\b/.test(lowered) ? 'today' : 'latest'
  // Replies are read only when the request asks for them; the user can still change it.
  const replies = /\b(repl(y|ies)|threads?)\b/.test(lowered)
  return { mode, count, replies }
}

/** Does the reviewed text look like a Teams request? Used only to order the review buttons. */
export function mentionsTeams(text: string): boolean {
  return /\b(teams|channel|group chat|chat)\b/i.test(text)
}

/**
 * A chat/channel name the request mentions ("in the Fabrikam launch channel"), if any. PrismLocal
 * never searches for it; it only compares it with the one conversation the user shared.
 */
export function namedSource(text: string): string | null {
  const match = text.match(/\b(?:in|from|on)\s+(?:the|my|our)\s+(.{2,60}?)\s+(channel|chat|group)\b/i)
  if (!match) return null
  const name = match[1].trim()
  if (/^(this|that|selected|current|open|same)$/i.test(name) || /^(selected|current|open)\b/i.test(name)) return null
  return name
}

/** Does a named source plausibly refer to the shared conversation? Case/space-insensitive. */
export function matchesSource(name: string, label: string): boolean {
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const a = norm(name)
  const b = norm(label)
  return !!a && !!b && (b === a || b.includes(a) || a.includes(b))
}
