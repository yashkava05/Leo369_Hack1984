import type { IcsEvent } from '../types'

// RFC 5545 calendar file built entirely in the browser: adding an event needs no network.

const CRLF = '\r\n'
const MAX_OCTETS = 75
const DEFAULT_DURATION_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i

interface ParsedTime {
  // Wall-clock fields encoded as a UTC timestamp, so date arithmetic never touches the viewer's zone.
  ms: number
  // true when the input carried an offset: ms is then a real instant and is written in UTC with 'Z'.
  utc: boolean
  dateOnly: boolean
}

function parseIso(value: string): ParsedTime {
  const m = ISO_RE.exec(value.trim())
  if (!m) throw new Error(`Invalid ISO 8601 date-time: ${value}`)
  const [, y, mo, d, h, mi, s, offset] = m
  const wall = Date.UTC(+y, +mo - 1, +d, h ? +h : 0, mi ? +mi : 0, s ? +s : 0)
  // Reject out-of-range fields instead of letting Date roll them over (2026-02-30 -> March 2).
  const check = new Date(wall)
  if (
    check.getUTCFullYear() !== +y ||
    check.getUTCMonth() !== +mo - 1 ||
    check.getUTCDate() !== +d ||
    (h !== undefined && (+h > 23 || +mi > 59 || (s !== undefined && +s > 59)))
  ) {
    throw new Error(`Invalid ISO 8601 date-time: ${value}`)
  }
  if (h === undefined) return { ms: wall, utc: false, dateOnly: true }
  if (offset === undefined) return { ms: wall, utc: false, dateOnly: false }
  if (offset.toUpperCase() === 'Z') return { ms: wall, utc: true, dateOnly: false }
  const sign = offset[0] === '-' ? -1 : 1
  const digits = offset.slice(1).replace(':', '')
  const offsetMs = sign * (+digits.slice(0, 2) * 60 + +(digits.slice(2, 4) || '0')) * 60_000
  return { ms: wall - offsetMs, utc: true, dateOnly: false }
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

function formatDate(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
}

function formatDateTime(ms: number, utc: boolean): string {
  const d = new Date(ms)
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  return `${formatDate(ms)}T${time}${utc ? 'Z' : ''}`
}

function timeProperty(name: string, t: ParsedTime): string {
  return t.dateOnly ? `${name};VALUE=DATE:${formatDate(t.ms)}` : `${name}:${formatDateTime(t.ms, t.utc)}`
}

/** Escape a TEXT property value (RFC 5545 §3.3.11). */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

const encoder = new TextEncoder()

/** Fold a content line to at most 75 octets per physical line (RFC 5545 §3.1), never splitting a character. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= MAX_OCTETS) return line
  const parts: string[] = []
  let current = ''
  let octets = 0
  for (const ch of line) {
    const size = encoder.encode(ch).length
    // Continuation lines start with one space, which counts toward their 75 octets.
    const limit = parts.length === 0 ? MAX_OCTETS : MAX_OCTETS - 1
    if (octets + size > limit) {
      parts.push(current)
      current = ''
      octets = 0
    }
    current += ch
    octets += size
  }
  parts.push(current)
  return parts.join(`${CRLF} `)
}

/** URL value safe to write into the file: http(s) only, no control characters that could inject lines. */
export function safeIcsUrl(url: string | null | undefined): string | null {
  // eslint-disable-next-line no-control-regex
  if (!url || /[\u0000-\u001f\u007f]/.test(url)) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
  } catch {
    return null
  }
}

const sameValueType = (a: ParsedTime, b: ParsedTime): boolean => a.dateOnly === b.dateOnly && a.utc === b.utc

export function buildIcs(e: IcsEvent, uid: string, now: Date = new Date()): string {
  const start = parseIso(e.start)
  const parsedEnd = e.end ? parseIso(e.end) : null
  // RFC 5545 needs DTSTART and DTEND of the same value type, and DTEND (exclusive) after DTSTART.
  const end: ParsedTime =
    parsedEnd && sameValueType(start, parsedEnd) && parsedEnd.ms > start.ms
      ? parsedEnd
      : { ...start, ms: start.ms + (start.dateOnly ? DAY_MS : DEFAULT_DURATION_MS) }
  const url = safeIcsUrl(e.url)

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Latent//HACK1984//EN',
    'BEGIN:VEVENT',
    `UID:${escapeText(uid)}@latent.local`,
    `DTSTAMP:${formatDateTime(now.getTime(), true)}`,
    timeProperty('DTSTART', start),
    timeProperty('DTEND', end),
    `SUMMARY:${escapeText(e.title)}`,
  ]
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`)
  // URL is a URI value, not TEXT, so it is not backslash-escaped.
  if (url) lines.push(`URL:${url}`)
  lines.push('END:VEVENT', 'END:VCALENDAR')

  return lines.map(foldLine).join(CRLF) + CRLF
}

/** Safe file name derived from the event title. */
export function icsFilename(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'event'}.ics`
}

export function downloadIcs(e: IcsEvent, uid: string): void {
  const blob = new Blob([buildIcs(e, uid)], { type: 'text/calendar;charset=utf-8' })
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = icsFilename(e.title)
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Give the browser a moment to start the download before releasing the blob.
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}
