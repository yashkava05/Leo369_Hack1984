import { API_URL } from '../api/client'
import type { BrowserJobView, ExtensionHello, ReadScope } from './types'

/**
 * The two halves of a real read: the PrismLocal backend (job, nonce, local analysis) and the PrismLocal
 * extension (the only thing that can see the authorized Outlook tab). The demo driver in
 * demo.ts implements the same interface with a clearly labelled fake inbox.
 */
export interface OutlookDriver {
  demo: boolean
  hello(): Promise<ExtensionHello>
  start(request: string, scope: ReadScope): Promise<{ jobId: string; viewToken: string }>
  poll(jobId: string, viewToken: string): Promise<BrowserJobView>
  cancel(jobId: string, viewToken: string): Promise<void>
  forget(): Promise<void>
}

export class OutlookError extends Error {
  code: string
  constructor(code: string) { super(code); this.name = 'OutlookError'; this.code = code }
}

export const EXTENSION_ID: string = import.meta.env.VITE_LATENT_EXTENSION_ID ?? 'kemjkilbmidnkohlldbohmgjaljbkdcc'
const EXTENSION_TIMEOUT_MS = 3000
const KNOWN = new Set([
  'airgap_on', 'untrusted_origin', 'invalid_payload', 'unknown_job', 'bad_token', 'invalid_scope',
  'extension_unavailable', 'unsupported_browser', 'no_source_selected', 'permission_denied', 'wrong_origin',
  'account_changed', 'login_required', 'unsupported_layout', 'empty_mailbox', 'nothing_selected', 'tab_closed',
  'cancelled', 'read_failed', 'local_model_unavailable', 'analysis_failed', 'scope_exceeded', 'scope_mismatch',
])
const known = (code: unknown) => (typeof code === 'string' && KNOWN.has(code) ? code : 'backend_error')

interface ChromeRuntime { sendMessage(id: string, message: unknown, callback: (response: unknown) => void): void; lastError?: { message?: string } }

function runtime(): ChromeRuntime | null {
  const chrome = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome
  return chrome?.runtime?.sendMessage ? chrome.runtime : null
}

/** Message the PrismLocal extension. Pages other than the PrismLocal UI cannot reach it (manifest). */
export function sendToExtension<T>(message: Record<string, unknown>, id = EXTENSION_ID): Promise<T> {
  const rt = runtime()
  // chrome.runtime is only exposed to pages listed in some extension's externally_connectable.
  if (!rt) return Promise.reject(new OutlookError('extension_unavailable'))
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OutlookError('extension_unavailable')), EXTENSION_TIMEOUT_MS)
    try {
      rt.sendMessage(id, message, (response) => {
        clearTimeout(timer)
        if (rt.lastError || !response || typeof response !== 'object') { reject(new OutlookError('extension_unavailable')); return }
        resolve(response as T)
      })
    } catch {
      clearTimeout(timer)
      reject(new OutlookError('extension_unavailable'))
    }
  })
}

async function backend<T>(path: string, init: RequestInit, expected: number): Promise<T> {
  const response = await fetch(`${API_URL}/api/browser${path}`, { ...init, credentials: 'same-origin', cache: 'no-store' })
  if (response.status !== expected) {
    const body = await response.json().catch(() => null)
    throw new OutlookError(known(body?.detail))
  }
  return (expected === 204 ? null : await response.json()) as T
}

export const liveDriver: OutlookDriver = {
  demo: false,
  async hello() {
    const reply = await sendToExtension<ExtensionHello>({ type: 'latent.hello' })
    if (!reply.ok) throw new OutlookError('extension_unavailable')
    return reply
  },
  async start(request, scope) {
    const job = await backend<{ job_id: string; nonce: string; view_token: string }>('/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'outlook', request, mode: scope.mode, count: scope.count }),
    }, 201)
    try {
      const reply = await sendToExtension<{ ok: boolean }>({ type: 'latent.read', jobId: job.job_id, nonce: job.nonce })
      if (!reply.ok) throw new OutlookError('extension_unavailable')
    } catch (error) {
      await liveDriver.cancel(job.job_id, job.view_token).catch(() => {})
      throw error
    }
    return { jobId: job.job_id, viewToken: job.view_token }
  },
  poll(jobId, viewToken) {
    return backend<BrowserJobView>(`/jobs/${encodeURIComponent(jobId)}`, { headers: { 'X-Latent-View': viewToken } }, 200)
  },
  async cancel(jobId, viewToken) {
    await sendToExtension({ type: 'latent.cancel', jobId }).catch(() => {})
    await backend<null>(`/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE', headers: { 'X-Latent-View': viewToken } }, 204).catch(() => {})
  },
  async forget() { await sendToExtension({ type: 'latent.forget' }).catch(() => {}) },
}
