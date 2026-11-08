// Standalone types for the browser-session Teams agent (#68). Separate from the shared
// screenshot/voice contract in src/types.ts: none of this is a public intent job.
import type { Boundary, JobStatus, JobStep } from '../outlook/types'

export type TeamsMode = 'latest' | 'unread' | 'today'
export interface TeamsScope { mode: TeamsMode; count: number; replies: boolean }
export const MAX_COUNT = 20
export const DEFAULT_COUNT = 20

export type { Boundary, JobStatus, JobStep }

export interface TeamsCoverage {
  requested: number
  inspected: number
  scrolls: number
  partial: boolean
  reason: 'count_reached' | 'list_end' | 'budget' | 'timeout' | 'window_end' | 'unread_end'
  elapsed_ms: number
  replies: 'not_requested' | 'complete' | 'incomplete'
  collapsed_threads: number
  skipped_undated: number
}

export interface SummaryPoint { text: string; source_ids: string[] }
export interface TeamsMessageSummary {
  source_id: string
  position: number
  author: string
  time: string
  timestamp: string | null
  is_reply: boolean
  unread: boolean
  link: string | null
  excerpt: string
  needs_response: boolean
  flagged_instructions: boolean
}
export interface TeamsTask {
  id: string
  source_id: string
  task: string
  quote: string
  owner: string | null
  owner_basis: 'mentioned' | 'named_in_quote' | null
  deadline: string | null
}
export interface TeamsResult { points: SummaryPoint[]; messages: TeamsMessageSummary[]; tasks: TeamsTask[]; dropped_claims: number }

export interface TeamsJobView {
  job_id: string
  provider: 'teams'
  status: JobStatus
  error: string | null
  scope: TeamsScope
  origin: string | null
  inspected: number
  coverage: TeamsCoverage | null
  steps: JobStep[]
  result: TeamsResult | null
  demo: boolean
  timings_ms: Record<string, number>
  receipt: { browser_reads: number; backend_internet_requests: number; local_model_calls: number }
}

export interface TeamsConversation { fp: string; label: string; kind: 'chat' | 'channel' }
export interface SharedSource {
  provider: 'outlook' | 'teams'
  origin: string
  accountLabel: string
  granted: boolean
  conversation?: TeamsConversation | null
}
export interface TeamsHello { ok: boolean; version?: string; source: SharedSource | null }
