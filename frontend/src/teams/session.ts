import { OutlookError } from '../outlook/driver'
import type { TeamsDriver } from './driver'
import { clampCount, matchesSource, namedSource, teamsScopeFromRequest } from './scope'
import type { SharedSource, TeamsJobView, TeamsScope } from './types'

export type TeamsPhase = 'checking' | 'setup' | 'review' | 'running' | 'done' | 'error' | 'cancelled'
export interface TeamsState {
  phase: TeamsPhase
  request: string
  scope: TeamsScope
  source: SharedSource | null
  /** The user ticked "read only this chat/channel" for the currently shared conversation. */
  sourceConfirmed: boolean
  /** A chat/channel name the request mentions, and whether it differs from the shared one. */
  named: string | null
  mismatch: boolean
  job: TeamsJobView | null
  error: string | null
  demo: boolean
}

const TERMINAL = new Set(['done', 'error', 'cancelled', 'blocked'])
const EDITABLE = new Set(['review', 'error', 'cancelled', 'done'])
const MAX_POLLS = 600

/**
 * One reviewed request → one bounded read of one confirmed Teams chat/channel. Private results
 * live only in this object's memory; cancel/close/air-gap drop them and bump the generation so a
 * late poll can never resurrect them. The backend job is deleted as soon as results arrive.
 */
export function createTeamsSession(driver: TeamsDriver, request: string, options: {
  offline?: () => boolean
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
} = {}) {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollMs = options.pollMs ?? 400
  const named = namedSource(request)
  let state: TeamsState = {
    phase: 'checking', request, scope: teamsScopeFromRequest(request), source: null, sourceConfirmed: false,
    named, mismatch: false, job: null, error: null, demo: driver.demo,
  }
  let generation = 0
  let offline = false
  const isOffline = () => offline || !!options.offline?.()
  let active: { jobId: string; viewToken: string } | null = null
  const listeners = new Set<() => void>()
  const update = (next: Partial<TeamsState>) => { state = { ...state, ...next }; listeners.forEach((listener) => listener()) }
  const codeOf = (error: unknown) => (error instanceof OutlookError ? error.code : 'backend_error')
  const release = async () => {
    const current = active
    active = null
    if (current) await driver.cancel(current.jobId, current.viewToken).catch(() => {})
  }

  const check = async () => {
    const gen = ++generation
    update({ phase: 'checking', error: null })
    try {
      const hello = await driver.hello()
      if (gen !== generation) return
      const source = hello.source
      // A shared Outlook tab is not a Teams source.
      if (!source || source.provider !== 'teams') { update({ phase: 'setup', source: null, sourceConfirmed: false, error: 'no_source_selected' }); return }
      if (!source.granted) { update({ phase: 'setup', source, sourceConfirmed: false, error: 'permission_denied' }); return }
      if (!source.conversation) { update({ phase: 'setup', source, sourceConfirmed: false, error: 'nothing_selected' }); return }
      const same = state.source?.conversation?.fp === source.conversation.fp
      update({
        phase: 'review', source, error: null,
        sourceConfirmed: same && state.sourceConfirmed,
        mismatch: !!named && !matchesSource(named, source.conversation.label),
      })
    } catch (error) {
      if (gen === generation) update({ phase: 'setup', source: null, sourceConfirmed: false, error: codeOf(error) })
    }
  }

  const setScope = (scope: TeamsScope) => {
    if (!EDITABLE.has(state.phase)) return
    update({ scope: { mode: scope.mode, count: clampCount(scope.count), replies: !!scope.replies && state.source?.conversation?.kind === 'channel' } })
  }

  const confirmSource = (value: boolean) => {
    if (!EDITABLE.has(state.phase) || !state.source?.conversation) return
    update({ sourceConfirmed: value })
  }

  const confirm = async () => {
    if (!EDITABLE.has(state.phase) || !state.source?.conversation) return
    if (!state.sourceConfirmed) { update({ error: 'source_selection_required' }); return }
    if (isOffline()) { update({ phase: 'error', error: 'airgap_on', job: null }); return }
    const gen = ++generation
    await release() // a new read never leaves an older one running
    update({ phase: 'running', error: null, job: null })
    try {
      const started = await driver.start(state.request, state.scope, state.source.conversation.fp)
      if (gen !== generation) {
        // Stop, close or air-gap landed while the job was being created: cancel it right away.
        await driver.cancel(started.jobId, started.viewToken).catch(() => {})
        return
      }
      active = started
      for (let polls = 0; polls < MAX_POLLS; polls++) {
        if (gen !== generation || !active) return
        let view: TeamsJobView
        try {
          view = await driver.poll(active.jobId, active.viewToken)
        } catch (error) {
          if (gen === generation) { await release(); update({ phase: 'error', error: codeOf(error), job: null }) }
          return
        }
        if (gen !== generation) return
        if (TERMINAL.has(view.status)) {
          await release() // results are in this panel now; the backend copy is wiped
          if (gen !== generation) return
          if (view.status === 'done') update({ phase: 'done', job: view })
          else update({ phase: view.status === 'cancelled' ? 'cancelled' : 'error', error: view.error ?? 'read_failed', job: { ...view, result: null } })
          return
        }
        update({ job: view })
        await sleep(pollMs)
      }
      if (gen === generation) { generation++; await release(); update({ phase: 'error', error: 'read_failed', job: null }) }
    } catch (error) {
      if (gen === generation) update({ phase: 'error', error: codeOf(error), job: null })
    }
  }

  const cancel = async () => {
    generation++
    update({ phase: 'cancelled', job: null, error: null })
    await release()
  }

  /** Unmount/close: stop any read and drop the results. */
  const dispose = async () => {
    generation++
    state = { ...state, job: null, phase: 'cancelled' }
    await release()
  }

  /** Air-gap from the chat header: turning it on stops a running read (the backend refuses too). */
  const setOffline = (value: boolean) => {
    offline = value
    if (value && state.phase === 'running') {
      generation++
      update({ phase: 'error', error: 'airgap_on', job: null })
      void release()
    }
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    check, setScope, confirmSource, confirm, cancel, dispose, setOffline,
    forget: async () => { await driver.forget(); update({ sourceConfirmed: false }); await check() },
  }
}
export type TeamsSession = ReturnType<typeof createTeamsSession>
