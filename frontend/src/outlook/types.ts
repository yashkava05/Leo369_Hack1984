// Standalone types for the browser-session Outlook agent (#67). Deliberately separate from the
// shared screenshot/voice contract in src/types.ts: none of this is a public intent job.

export type ReadMode = 'latest' | 'unread' | 'selected'
export interface ReadScope { mode: ReadMode; count: number }
export const MAX_COUNT = 20
export const DEFAULT_COUNT = 10

export type JobStatus = 'waiting_for_extension' | 'reading' | 'analyzing' | 'done' | 'error' | 'cancelled' | 'blocked'
export type Boundary = 'local' | 'browser'

export interface JobStep { key: string; label: string; boundary: Boundary; state: 'idle' | 'active' | 'done' | 'error' }
export interface Coverage {
  requested: number
  inspected: number
  /** Rows looked at; larger than `inspected` in unread mode. */
  examined?: number
  scrolls: number
  partial: boolean
  reason: 'count_reached' | 'list_end' | 'budget' | 'timeout' | 'selected_message'
  elapsed_ms: number
}
export interface EmailSummary {
  source_id: string
  position: number
  sender: string
  time: string
  subject: string
  unread: boolean
  summary: string
  needs_attention: boolean
  flagged_instructions: boolean
}
export interface TaskSuggestion { id: string; source_id: string; task: string; quote: string; deadline: string | null }
export interface AnalysisResult { emails: EmailSummary[]; tasks: TaskSuggestion[]; dropped_claims: number }

export interface BrowserJobView {
  job_id: string
  provider: 'outlook'
  status: JobStatus
  error: string | null
  scope: ReadScope
  origin: string | null
  inspected: number
  coverage: Coverage | null
  steps: JobStep[]
  result: AnalysisResult | null
  demo: boolean
  timings_ms: Record<string, number>
  receipt: { browser_reads: number; backend_internet_requests: number; local_model_calls: number }
}

export interface SelectedSource { provider: 'outlook'; origin: string; accountLabel: string; granted: boolean }
export interface ExtensionHello { ok: boolean; version?: string; source: SelectedSource | null }
