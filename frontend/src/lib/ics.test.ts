import { describe, expect, it } from 'vitest'
import concertFixture from '../api/fixtures/concert_flyer.result.json'
import type { IcsEvent, JobResult } from '../types'
import { buildIcs, escapeText, foldLine, icsFilename } from './ics'

const NOW = new Date(Date.UTC(2026, 10, 7, 9, 30, 15))
const octets = (s: string) => new TextEncoder().encode(s).length

function event(overrides: Partial<IcsEvent> = {}): IcsEvent {
  return {
    title: 'Lumen Drift live',
    start: '2026-12-05T20:00:00',
    end: null,
    location: null,
    url: null,
    ...overrides,
  }
}

/** Unfold (RFC 5545 §3.1) and split into logical lines. */
function logicalLines(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean)
}

function prop(ics: string, name: string): string | undefined {
  return logicalLines(ics).find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`))
}

describe('buildIcs', () => {
  it('produces the full calendar skeleton with CRLF line endings', () => {
    const ics = buildIcs(event({ location: 'Paradise Rock Club', url: 'https://example.com/e' }), 'c_calendar', NOW)
    expect(ics).toBe(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Latent//HACK1984//EN',
        'BEGIN:VEVENT',
        'UID:c_calendar@latent.local',
        'DTSTAMP:20261107T093015Z',
        'DTSTART:20261205T200000',
        'DTEND:20261205T230000',
        'SUMMARY:Lumen Drift live',
        'LOCATION:Paradise Rock Club',
        'URL:https://example.com/e',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    )
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  })

  it('omits LOCATION and URL when absent', () => {
    const ics = buildIcs(event(), 'x', NOW)
    expect(prop(ics, 'LOCATION')).toBeUndefined()
    expect(prop(ics, 'URL')).toBeUndefined()
  })

  it('escapes backslash, semicolon, comma and newlines in text values', () => {
    expect(escapeText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf')
    const ics = buildIcs(event({ title: 'Rock; Roll, Live\nNight', location: 'C:\\Hall, Boston' }), 'x', NOW)
    expect(prop(ics, 'SUMMARY')).toBe('SUMMARY:Rock\\; Roll\\, Live\\nNight')
    expect(prop(ics, 'LOCATION')).toBe('LOCATION:C:\\\\Hall\\, Boston')
  })

  it('does not backslash-escape the URL value', () => {
    const url = 'https://maps.example.com/?q=a,b;c'
    expect(prop(buildIcs(event({ url }), 'x', NOW), 'URL')).toBe(`URL:${url}`)
  })

  it('folds lines longer than 75 octets and unfolds back to the original', () => {
    const location = 'Paradise Rock Club, 967 Commonwealth Ave, Boston, MA 02215, United States of America, Earth'
    const ics = buildIcs(event({ location }), 'x', NOW)
    for (const physical of ics.split('\r\n')) expect(octets(physical)).toBeLessThanOrEqual(75)
    expect(ics).toMatch(/\r\n /)
    expect(prop(ics, 'LOCATION')).toBe(`LOCATION:${escapeText(location)}`)
  })

  it('folds by octets without splitting multi-byte characters', () => {
    const line = `SUMMARY:${'é'.repeat(50)}${'🎸'.repeat(10)}`
    const folded = foldLine(line)
    const physical = folded.split('\r\n')
    expect(physical.length).toBeGreaterThan(1)
    for (const p of physical) {
      expect(octets(p)).toBeLessThanOrEqual(75)
      expect(p).not.toContain('\uFFFD')
    }
    expect(physical.slice(1).every((p) => p.startsWith(' '))).toBe(true)
    expect(folded.replace(/\r\n /g, '')).toBe(line)
  })

  it('leaves short lines untouched', () => {
    expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short')
    const exact = `X:${'a'.repeat(73)}`
    expect(foldLine(exact)).toBe(exact)
  })

  it('defaults the end to start + 3 hours, across midnight', () => {
    const ics = buildIcs(event({ start: '2026-12-31T22:30:00' }), 'x', NOW)
    expect(prop(ics, 'DTSTART')).toBe('DTSTART:20261231T223000')
    expect(prop(ics, 'DTEND')).toBe('DTEND:20270101T013000')
  })

  it('converts offset times to UTC with a Z suffix', () => {
    const ics = buildIcs(event({ start: '2026-12-05T20:00:00-05:00', end: '2026-12-05T23:00:00-05:00' }), 'x', NOW)
    expect(prop(ics, 'DTSTART')).toBe('DTSTART:20261206T010000Z')
    expect(prop(ics, 'DTEND')).toBe('DTEND:20261206T040000Z')
  })

  it('handles Z, compact and positive offsets and default end in UTC', () => {
    expect(prop(buildIcs(event({ start: '2026-07-01T10:00:00Z' }), 'x', NOW), 'DTEND')).toBe('DTEND:20260701T130000Z')
    expect(prop(buildIcs(event({ start: '2026-07-01T10:00+0530' }), 'x', NOW), 'DTSTART')).toBe(
      'DTSTART:20260701T043000Z',
    )
  })

  it('keeps floating local time when the input has no offset', () => {
    const ics = buildIcs(event({ start: '2026-03-08T02:30:00' }), 'x', NOW)
    expect(prop(ics, 'DTSTART')).toBe('DTSTART:20260308T023000')
  })

  it('writes all-day events for date-only input', () => {
    const ics = buildIcs(event({ start: '2026-12-05' }), 'x', NOW)
    expect(prop(ics, 'DTSTART')).toBe('DTSTART;VALUE=DATE:20261205')
    expect(prop(ics, 'DTEND')).toBe('DTEND;VALUE=DATE:20261206')
  })

  it('rejects malformed dates', () => {
    expect(() => buildIcs(event({ start: 'next Saturday' }), 'x', NOW)).toThrow(/Invalid ISO/)
  })

  it('builds the concert fixture calendar card', () => {
    const card = (concertFixture as JobResult).cards.find((c) => c.kind === 'calendar')!
    const ics = buildIcs(card.actions[0].ics!, card.id, NOW)
    expect(prop(ics, 'UID')).toBe('UID:c_calendar@latent.local')
    expect(prop(ics, 'DTSTART')).toBe('DTSTART:20261206T010000Z')
    expect(prop(ics, 'LOCATION')).toBe('LOCATION:Paradise Rock Club\\, 967 Commonwealth Ave\\, Boston\\, MA')
  })
})

describe('icsFilename', () => {
  it('slugifies the title', () => {
    expect(icsFilename('Lumen Drift live')).toBe('lumen-drift-live.ics')
    expect(icsFilename('Café: Nuits / Été!')).toBe('cafe-nuits-ete.ics')
    expect(icsFilename('???')).toBe('event.ics')
  })
})
