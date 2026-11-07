import type { EgressRecord, JobResult, StageEvent } from '../types'

// Pure formatting for the live terminal: no React, so it is easy to test against the fixtures.

export type LineTone = 'local' | 'net' | 'error' | 'blocked'

export interface TerminalLine {
  key: string
  time: string // mm:ss.cc since the first event
  tag: 'LOCAL' | 'NET'
  stage: string
  text: string
  tone: LineTone
}

export interface EgressCounters {
  requests: number // requests that actually went out
  bytes: number // bytes_out summed over requests that went out
  imageBytes: 0 // enforced by the egress guard, never anything else
  blocked: number
}

/** Shape of `data` on a network event emitted by the egress guard. */
interface NetData {
  host: string
  path: string
  bytes_out: number
  blocked: boolean
  method?: string
  reason?: string | null
}

export const TAG_WIDTH = 'LOCAL'.length + 2
export const STAGE_WIDTH = 'extract'.length + 3

export function formatElapsed(seconds: number): string {
  const centis = Math.max(0, Math.round(seconds * 100))
  const mm = Math.floor(centis / 6000)
  const ss = Math.floor((centis % 6000) / 100)
  const cc = centis % 100
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(mm)}:${pad(ss)}.${pad(cc)}`
}

export function netData(event: StageEvent): NetData | null {
  const d = event.data
  if (event.local || !d) return null
  if (typeof d.host !== 'string' || typeof d.path !== 'string' || typeof d.bytes_out !== 'number') return null
  return {
    host: d.host,
    path: d.path,
    bytes_out: d.bytes_out,
    blocked: d.blocked === true,
    method: typeof d.method === 'string' ? d.method : undefined,
    reason: typeof d.reason === 'string' ? d.reason : null,
  }
}

/** Fixture messages repeat the stage ("extract: running…"); the stage column already says it. */
function stripStagePrefix(stage: string, message: string): string {
  const prefix = `${stage}: `
  const text = message.startsWith(prefix) ? message.slice(prefix.length) : message
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function requestText(net: { method?: string; host: string; path: string; bytes_out: number }): string {
  return `${net.method ?? 'POST'} ${net.host}${net.path} · ${net.bytes_out} B · image data 0 B`
}

function blockedText(base: string, reason: string | null | undefined): string {
  return `BLOCKED ${base}${reason ? ` — ${reason}` : ''}`
}

export function eventLine(event: StageEvent, t0: number): TerminalLine {
  const net = netData(event)
  let text: string
  let tone: LineTone
  if (net) {
    const base = requestText(net)
    tone = net.blocked ? 'blocked' : 'net'
    text = net.blocked ? blockedText(base, net.reason ?? stripStagePrefix(event.stage, event.message)) : base
  } else {
    text = stripStagePrefix(event.stage, event.message)
    tone = event.status === 'error' || event.stage === 'error' ? 'error' : event.local ? 'local' : 'net'
  }
  return {
    key: `${event.job_id}:${event.seq}`,
    time: formatElapsed(event.ts - t0),
    tag: event.local ? 'LOCAL' : 'NET',
    stage: event.stage,
    text,
    tone,
  }
}

/**
 * One line per event, in arrival order. After `done`, blocked egress records that never showed
 * up as a live network event are appended so a blocked request is always visible with its reason.
 */
export function buildLines(events: StageEvent[], result?: JobResult): TerminalLine[] {
  if (events.length === 0) return []
  const t0 = events[0].ts
  const lines = events.map((e) => eventLine(e, t0))
  if (result) {
    const seenBlocked = events.some((e) => netData(e)?.blocked)
    if (!seenBlocked) {
      const doneTs = events[events.length - 1].ts
      for (const rec of result.egress.filter((r) => r.blocked)) {
        lines.push({
          key: `${result.job_id}:egress:${rec.id}`,
          time: formatElapsed(doneTs - t0),
          tag: 'NET',
          stage: 'egress',
          text: blockedText(requestText(rec), rec.reason),
          tone: 'blocked',
        })
      }
    }
  }
  return lines
}

export function countersFromEgress(egress: EgressRecord[]): EgressCounters {
  const sent = egress.filter((r) => !r.blocked)
  return {
    requests: sent.length,
    bytes: sent.reduce((sum, r) => sum + r.bytes_out, 0),
    imageBytes: 0,
    blocked: egress.length - sent.length,
  }
}

/** Live counters from the guard's network events; `result.egress` is the source of truth once done. */
export function counters(events: StageEvent[], result?: JobResult): EgressCounters {
  if (result) return countersFromEgress(result.egress)
  const nets = events.map(netData).filter((n): n is NetData => n !== null)
  return countersFromEgress(nets.map((n, i) => ({ ...n, id: String(i), ts: 0, method: n.method ?? 'POST', payload_preview: '', reason: n.reason ?? null })))
}

export function formatCounters(c: EgressCounters): string {
  return `Outbound requests: ${c.requests} · Bytes sent: ${c.bytes} · Image bytes sent: ${c.imageBytes} · Blocked: ${c.blocked}`
}

/** Plain-text rendering of a line, matching the issue's format (used for copy and tests). */
export function lineToText(line: TerminalLine): string {
  return `[${line.time}] ${line.tag.padEnd(TAG_WIDTH)}${line.stage.padEnd(STAGE_WIDTH)}${line.text}`
}

/** Typewriter duration for a line: ≈ 8 ms/char, capped at 400 ms. */
export const MS_PER_CHAR = 8
export const MAX_LINE_MS = 400
export function typingMs(text: string): number {
  return Math.min(MAX_LINE_MS, text.length * MS_PER_CHAR)
}

export function terminalModel(events: StageEvent[], result?: JobResult): { lines: TerminalLine[]; counters: EgressCounters } {
  return { lines: buildLines(events, result), counters: counters(events, result) }
}
