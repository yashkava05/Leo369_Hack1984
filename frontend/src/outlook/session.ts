import { OutlookError, type OutlookDriver } from './driver'
import { clampCount, scopeFromRequest } from './scope'
import type { BrowserJobView, ReadScope, SelectedSource } from './types'

export type OutlookPhase = 'checking' | 'setup' | 'review' | 'running' | 'done' | 'error' | 'cancelled'
export interface OutlookState {
  phase: OutlookPhase
  request: string
  scope: ReadScope
  source: SelectedSource | null
  job: BrowserJobView | null
  error: string | null
  demo: boolean
}

const TERMINAL = new Set(['done', 'error', 'cancelled', 'blocked'])
const MAX_POLLS = 600

/**
 * One reviewed request → one bounded read. Private results live only in this object's memory;
 * cancel/close drop them and bump the generation so a late poll can never resurrect them.
 */
export function createOutlookSession(driver: OutlookDriver, request: string, options: {
  offline?: () => boolean
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
} = {}) {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollMs = options.pollMs ?? 400
  let state: OutlookState = { phase: 'checking', request, scope: scopeFromRequest(request), source: null, job: null, error: null, demo: driver.demo }
  let generation = 0
  let offline = false
  const isOffline = () => offline || !!options.offline?.()
  let active: { jobId: string; viewToken: string } | null = null
  const listeners = new Set<() => void>()
  const update = (next: Partial<OutlookState>) => { state = { ...state, ...next }; listeners.forEach((listener) => listener()) }
  const codeOf = (error: unknown) => (error instanceof OutlookError ? error.code : 'backend_error')

  const check = async () => {
    const gen = ++generation
    update({ phase: 'checking', error: null })
    try {
      const hello = await driver.hello()
      if (gen !== generation) return
      if (!hello.source) { update({ phase: 'setup', source: null, error: 'no_source_selected' }); return }
      if (!hello.source.granted) { update({ phase: 'setup', source: hello.source, error: 'permission_denied' }); return }
      update({ phase: 'review', source: hello.source, error: null })
    } catch (error) {
      if (gen === generation) update({ phase: 'setup', source: null, error: codeOf(error) })
    }
  }

  const setScope = (scope: ReadScope) => {
    if (!['review', 'error', 'cancelled', 'done'].includes(state.phase)) return
    update({ scope: scope.mode === 'selected' ? { mode: 'selected', count: 1 } : { mode: scope.mode, count: clampCount(scope.count) } })
  }

  /** Stop tracking the backend job and delete it there (also tells the extension to stop). */
  const release = async () => {
    const current = active
    active = null
    if (current) await driver.cancel(current.jobId, current.viewToken).catch(() => {})
  }

  const confirm = async () => {
    if (!['review', 'error', 'cancelled', 'done'].includes(state.phase) || !state.source) return
    if (isOffline()) { update({ phase: 'error', error: 'airgap_on', job: null }); return }
    const gen = ++generation
    void release() // a previous job (finished or not) never outlives a new request
    update({ phase: 'running', error: null, job: null })
    try {
      const started = await driver.start(state.request, state.scope)
      if (gen !== generation) {
        // Stop (or close) was pressed while the job was being created: cancel it right away.
        await driver.cancel(started.jobId, started.viewToken).catch(() => {})
        return
      }
      active = started
      for (let polls = 0; polls < MAX_POLLS; polls++) {
        if (gen !== generation || !active) return
        const view = await driver.poll(active.jobId, active.viewToken)
        if (gen !== generation) return
        update({ job: view })
        if (TERMINAL.has(view.status)) {
          // The panel now holds what it needs; delete the backend's copy right away.
          void release()
          if (view.status === 'done') update({ phase: 'done' })
          else update({ phase: view.status === 'cancelled' ? 'cancelled' : 'error', error: view.error ?? 'read_failed', job: { ...view, result: null } })
          return
        }
        await sleep(pollMs)
      }
      if (gen === generation) { await cancel(); update({ phase: 'error', error: 'read_failed' }) }
    } catch (error) {
      if (gen !== generation) return
      await release() // a failed poll must not leave the backend job or the extension read running
      update({ phase: 'error', error: codeOf(error), job: null })
    }
  }

  const cancel = async () => {
    generation++
    update({ phase: 'cancelled', job: null, error: null })
    await release()
  }

  /**
   * Unmount/close: stop any read and drop the results. The reviewed request text stays only in
   * this object, which is garbage once the panel is gone (and StrictMode can re-check it).
   */
  const dispose = async () => {
    const current = active
    generation++
    active = null
    state = { ...state, job: null, phase: 'cancelled' }
    if (current) await driver.cancel(current.jobId, current.viewToken).catch(() => {})
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    check, setScope, confirm, cancel, dispose,
    /** Air-gap state from the chat header; the backend enforces it again for real reads. */
    setOffline: (value: boolean) => {
      offline = value
      if (value && state.phase === 'running') {
        // Air-gap disables browser retrieval: stop the read in progress, not just the next one.
        generation++
        update({ phase: 'error', error: 'airgap_on', job: null })
        void release()
      }
    },
    forget: async () => { await driver.forget(); await check() },
  }
}
export type OutlookSession = ReturnType<typeof createOutlookSession>
