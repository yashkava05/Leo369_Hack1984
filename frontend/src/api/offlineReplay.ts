import type { EgressRecord, JobResult, StageEvent } from '../types'

// VITE_MOCK air-gap replay, mirroring the backend's `jobs.offline_replay`: the local stages run
// unchanged, every search request is blocked with "offline mode", and the job finishes with no
// cards. The blocked records are built from the fixture's own payloads (no real egress guard).

export const OFFLINE_REASON = 'offline mode'
const LOCAL_STAGES = new Set(['ingest', 'extract', 'scrub', 'query'])

export function offlineReplay(events: StageEvent[]): StageEvent[] {
  const fixtureResult = (events.find((e) => e.stage === 'done')?.data ?? null) as JobResult | null
  const blocked: EgressRecord[] = (fixtureResult?.egress ?? []).map((r) => ({ ...r, blocked: true, reason: OFFLINE_REASON }))
  const local = events.filter((e) => LOCAL_STAGES.has(e.stage))
  const base = local[local.length - 1] ?? events[0]
  const make = (
    stage: StageEvent['stage'],
    status: StageEvent['status'],
    message: string,
    isLocal: boolean,
    data: StageEvent['data'] = null,
  ): StageEvent => ({ ...base, stage, status, message, local: isLocal, data })
  const out: StageEvent[] = [
    ...local,
    make('search', 'start', 'search: air-gap on, nothing may leave this device', false),
    ...blocked.map((r) =>
      make('search', 'error', `network ✕ blocked ${r.method} ${r.host}${r.path} · ${r.bytes_out} bytes · ${OFFLINE_REASON}`, false, {
        host: r.host,
        path: r.path,
        bytes_out: r.bytes_out,
        blocked: true,
        reason: OFFLINE_REASON,
      }),
    ),
    make('search', 'ok', 'search: 0 results, every request blocked (offline mode)', false),
    make('cards', 'ok', 'cards: built 0 cards (search blocked)', true),
    make(
      'done',
      'ok',
      `done: 0 cards, 0 network calls, ${blocked.length} blocked`,
      true,
      fixtureResult ? { ...fixtureResult, cards: [], egress: blocked } : null,
    ),
  ]
  return out.map((e, seq) => ({ ...e, seq }))
}
