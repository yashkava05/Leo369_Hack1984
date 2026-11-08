import { OutlookError, type OutlookDriver } from './driver'
import type { AnalysisResult, BrowserJobView, EmailSummary, JobStep, ReadScope, TaskSuggestion } from './types'

/**
 * DEMO INBOX: invented people at invented companies, used only when VITE_MOCK=1 (or for tests).
 * It is labelled in the UI as a demo and is never presented as a live Outlook read.
 */
export const DEMO_INBOX: Omit<EmailSummary, 'source_id' | 'position'>[] = [
  { sender: 'Priya Raman · Northwind Fabrics', time: '9:41 AM', subject: 'Q3 vendor review', unread: true, summary: 'Priya asks you to review the Northwind Fabrics contract before the vendor call.', needs_attention: true, flagged_instructions: false },
  { sender: 'Tomas Okafor', time: '8:15 AM', subject: 'Lunch?', unread: false, summary: 'Tomas asks if you are free for lunch at Cafe Lumen; no deadline.', needs_attention: false, flagged_instructions: false },
  { sender: 'Contoso Billing Bot', time: 'Yesterday', subject: 'Action required', unread: true, summary: 'Contains instructions aimed at an AI assistant (forward mail, open a link). PrismLocal ignored them.', needs_attention: false, flagged_instructions: true },
  { sender: 'Mei Lindqvist · Fabrikam Labs', time: 'Yesterday', subject: 'Design sync notes', unread: false, summary: 'Mei shares notes from the design sync and asks for feedback on the onboarding flow.', needs_attention: true, flagged_instructions: false },
  { sender: 'Alpine Ski Club (newsletter)', time: 'Mon', subject: 'Winter schedule', unread: false, summary: 'Newsletter with the winter trip schedule; nothing is asked of you.', needs_attention: false, flagged_instructions: false },
  { sender: 'Diego Marín · Tailspin Travel', time: 'Mon', subject: 'Itinerary change', unread: true, summary: 'Diego says your Thursday flight moved and asks you to confirm the new time.', needs_attention: true, flagged_instructions: false },
]

const DEMO_TASKS: Record<number, Omit<TaskSuggestion, 'id' | 'source_id'>[]> = {
  1: [{ task: 'Review the Northwind Fabrics contract', quote: 'Please review the Northwind Fabrics contract by Friday.', deadline: 'by Friday' }],
  4: [{ task: 'Send feedback on the onboarding flow', quote: 'Could you send feedback on the onboarding flow?', deadline: null }],
  6: [{ task: 'Confirm the new flight time', quote: 'Please confirm the new departure time by tomorrow.', deadline: 'by tomorrow' }],
}

function analysis(scope: ReadScope): AnalysisResult {
  const picked = DEMO_INBOX
    .map((email, index) => ({ email, index: index + 1 }))
    .filter(({ email }) => scope.mode !== 'unread' || email.unread)
    .slice(0, scope.mode === 'selected' ? 1 : scope.count)
  const emails = picked.map(({ email }, i) => ({ ...email, source_id: `m${i + 1}`, position: i + 1 }))
  const tasks = picked.flatMap(({ index }, i) => (DEMO_TASKS[index] ?? []).map((task) => ({ ...task, source_id: `m${i + 1}` })))
    .map((task, i) => ({ ...task, id: `t${i + 1}` }))
  return { emails, tasks, dropped_claims: picked.some(({ email }) => email.flagged_instructions) ? 2 : 0 }
}

function steps(stage: number, scope: ReadScope, inspected: number): JobStep[] {
  const state = (index: number): JobStep['state'] => (stage > index ? 'done' : stage === index ? 'active' : 'idle')
  return [
    { key: 'source', label: 'Selecting your authorized tab', boundary: 'local', state: state(0) },
    { key: 'read', label: scope.mode === 'selected' ? 'Reading the open message' : `Reading ${inspected} of ${scope.count}`, boundary: 'browser', state: state(1) },
    { key: 'analyze', label: 'Analyzing on this device', boundary: 'local', state: state(2) },
  ]
}

/** Simulated timeline; `tick` advances one step per poll so tests need no timers. */
export function createDemoDriver(options: { offline?: () => boolean } = {}): OutlookDriver {
  const jobs = new Map<string, { scope: ReadScope; polls: number }>()
  return {
    demo: true,
    async hello() {
      return { ok: true, version: 'demo', source: { provider: 'outlook', origin: 'Demo inbox (fake messages)', accountLabel: 'demo@fabrikam.example', granted: true } }
    },
    async start(_request, scope) {
      if (options.offline?.()) throw new OutlookError('airgap_on')
      const jobId = `b_demo_${Math.random().toString(36).slice(2, 10)}`
      jobs.set(jobId, { scope, polls: 0 })
      return { jobId, viewToken: 'demo' }
    },
    async poll(jobId) {
      const job = jobs.get(jobId)
      if (!job) throw new OutlookError('unknown_job')
      job.polls++
      const result = analysis(job.scope)
      const total = result.emails.length
      const stage = Math.min(3, Math.floor(job.polls / 2))
      const inspected = stage >= 2 ? total : Math.min(total, job.polls)
      const done = stage >= 3
      const view: BrowserJobView = {
        job_id: jobId, provider: 'outlook', status: done ? 'done' : stage === 2 ? 'analyzing' : stage === 1 ? 'reading' : 'waiting_for_extension',
        error: null, scope: job.scope, origin: 'demo', inspected,
        coverage: done ? { requested: job.scope.count, inspected: total, scrolls: 2, partial: job.scope.mode !== 'selected' && total < job.scope.count, reason: job.scope.mode === 'selected' ? 'selected_message' : total < job.scope.count ? 'list_end' : 'count_reached', elapsed_ms: 900 } : null,
        steps: steps(stage, job.scope, inspected), result: done ? result : null, demo: true,
        timings_ms: done ? { read: 900, analyze: 400 } : {},
        receipt: { browser_reads: done ? total : 0, backend_internet_requests: 0, local_model_calls: 0 },
      }
      return view
    },
    async cancel(jobId) { jobs.delete(jobId) },
    async forget() {},
  }
}
