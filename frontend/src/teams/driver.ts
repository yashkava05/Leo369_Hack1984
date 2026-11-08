import { API_URL } from '../api/client'
import { OutlookError, sendToExtension } from '../outlook/driver'
import type { TeamsHello, TeamsJobView, TeamsScope } from './types'

/**
 * The two halves of a real Teams read: the PrismLocal backend (job, nonce, local analysis) and the
 * PrismLocal extension (the only thing that can see the authorized Teams tab). The demo driver in
 * demo.ts implements the same interface with a clearly labelled fake chat.
 */
export interface TeamsDriver {
  demo: boolean
  hello(): Promise<TeamsHello>
  start(request: string, scope: TeamsScope, source: string): Promise<{ jobId: string; viewToken: string }>
  poll(jobId: string, viewToken: string): Promise<TeamsJobView>
  cancel(jobId: string, viewToken: string): Promise<void>
  forget(): Promise<void>
}

/** Same constant-code error as the Outlook agent; codes never carry page text. */
export { OutlookError as TeamsError }

const KNOWN = new Set([
  'airgap_on', 'untrusted_origin', 'invalid_payload', 'unknown_job', 'bad_token', 'invalid_scope',
  'source_selection_required', 'extension_unavailable', 'unsupported_browser', 'no_source_selected',
  'permission_denied', 'wrong_origin', 'account_changed', 'login_required', 'unsupported_layout',
  'nothing_selected', 'tab_closed', 'cancelled', 'read_failed', 'conversation_changed', 'org_blocked',
  'empty_conversation', 'local_model_unavailable', 'analysis_failed', 'scope_exceeded', 'scope_mismatch',
])
export const knownTeamsCode = (code: unknown) => (typeof code === 'string' && KNOWN.has(code) ? code : 'backend_error')

async function backend<T>(path: string, init: RequestInit, expected: number): Promise<T> {
  const response = await fetch(`${API_URL}/api/browser${path}`, { ...init, credentials: 'same-origin', cache: 'no-store' })
  if (response.status !== expected) {
    const body = await response.json().catch(() => null)
    throw new OutlookError(knownTeamsCode(body?.detail))
  }
  return (expected === 204 ? null : await response.json()) as T
}

export const liveTeamsDriver: TeamsDriver = {
  demo: false,
  async hello() {
    const reply = await sendToExtension<TeamsHello>({ type: 'latent.hello' })
    if (!reply.ok) throw new OutlookError('extension_unavailable')
    return reply
  },
  async start(request, scope, source) {
    const job = await backend<{ job_id: string; nonce: string; view_token: string }>('/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'teams', request, mode: scope.mode, count: scope.count, replies: scope.replies, source, source_confirmed: true }),
    }, 201)
    try {
      const reply = await sendToExtension<{ ok: boolean }>({ type: 'latent.read', jobId: job.job_id, nonce: job.nonce })
      if (!reply.ok) throw new OutlookError('extension_unavailable')
    } catch (error) {
      await liveTeamsDriver.cancel(job.job_id, job.view_token).catch(() => {})
      throw error
    }
    return { jobId: job.job_id, viewToken: job.view_token }
  },
  poll(jobId, viewToken) {
    return backend<TeamsJobView>(`/jobs/${encodeURIComponent(jobId)}`, { headers: { 'X-Latent-View': viewToken } }, 200)
  },
  async cancel(jobId, viewToken) {
    await sendToExtension({ type: 'latent.cancel', jobId }).catch(() => {})
    await backend<null>(`/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE', headers: { 'X-Latent-View': viewToken } }, 204).catch(() => {})
  },
  async forget() { await sendToExtension({ type: 'latent.forget' }).catch(() => {}) },
}
