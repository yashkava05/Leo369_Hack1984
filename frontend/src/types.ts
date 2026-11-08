export interface HealthResponse {
  status: string
  ollama: string
  model: string | null
  model_loaded: boolean
  tavily_key: boolean
}

// Pipeline contract: mirror of backend/app/models.py. Keep field for field in sync with the Pydantic models.
// Optional Python fields with a default ('= None', '= []') are always present in API JSON,
// so they are typed as required here ('T | null', 'T[]').

export type IntentType = 'event' | 'product' | 'book' | 'place' | 'chart' | 'document' | 'other'

export type EntityType =
  | 'performer'
  | 'event_name'
  | 'venue'
  | 'city'
  | 'date'
  | 'time'
  | 'product'
  | 'brand'
  | 'price'
  | 'book_title'
  | 'author'
  | 'place'
  | 'topic'
  | 'public_org'
  | 'metric'

export interface Entity {
  type: EntityType
  value: string // public info only
}

export interface Intent {
  intent_type: IntentType
  summary: string // <= 140 chars, no PII
  public_entities: Entity[]
  redaction_counts: Record<string, number> // counts only, never values
  confidence: number // 0..1
}

export type QueryPurpose = 'tickets' | 'shopping' | 'book' | 'place' | 'context' | 'related'
export type QueryTopic = 'general' | 'news' | 'finance'

export interface SearchQuery {
  text: string // what is sent to Tavily, verbatim
  purpose: QueryPurpose
  topic: QueryTopic
  include_domains: string[]
}

export interface EgressRecord {
  id: string
  ts: number
  method: string
  host: string
  path: string
  bytes_out: number
  payload_preview: string // first 300 chars of the JSON body, API key removed
  blocked: boolean
  reason: string | null
}

export interface IcsEvent {
  title: string
  start: string // ISO 8601, with offset if known
  end: string | null
  location: string | null
  url: string | null
}

export type CardActionType = 'open_url' | 'download_ics' | 'copy'

export interface CardAction {
  label: string
  type: CardActionType
  url: string | null
  ics: IcsEvent | null
  text: string | null
}

export type CardKind =
  | 'tickets'
  | 'shop'
  | 'book'
  | 'calendar'
  | 'insight'
  | 'place'
  | 'link'
  | 'related'

export interface Card {
  id: string
  kind: CardKind
  title: string
  subtitle: string | null
  url: string | null
  price: string | null // as displayed by the source, e.g. '$89'
  source: string // domain, e.g. 'ticketmaster.com'
  snippet: string | null // <= 240 chars
  score: number
  actions: CardAction[]
}

export type FeedItemKind = 'discovery' | 'connection' | 'follow_up' | 'pattern'
export type FeedFeedbackAction = 'save' | 'useful' | 'not_useful' | 'dismiss' | 'less_like_this'
export type FeedProvenance = 'local' | 'web'

export interface FeedHero {
  url: string
  alt: string
}

export interface FeedSource {
  title: string
  url: string | null
  job_id: string | null
}

export interface FeedItem {
  id: string
  kind: FeedItemKind
  title: string
  teaser: string
  hero: FeedHero | null
  source_job_ids: string[]
  why: string
  created_at: number
  provenance: FeedProvenance
  actions: CardAction[]
  feedback: FeedFeedbackAction[]
}

export interface FeedItemDetail extends FeedItem {
  body: string
  sources: FeedSource[]
  cards: Card[]
}

export interface FeedResponse {
  items: FeedItem[]
  next_cursor: string | null
  generated_at: number
}

export type Stage = 'ingest' | 'extract' | 'scrub' | 'query' | 'search' | 'cards' | 'done' | 'error'
export type StageStatus = 'start' | 'progress' | 'ok' | 'error'

export interface StageEvent {
  job_id: string
  seq: number
  ts: number
  stage: Stage
  status: StageStatus
  message: string // one human line for the terminal
  local: boolean // true = on-device, false = network
  data: Record<string, unknown> | null // JobResult when stage is 'done'
}

export type JobStatus = 'running' | 'done' | 'error'

export interface JobResult {
  job_id: string
  status: JobStatus
  intent: Intent | null
  queries: SearchQuery[]
  cards: Card[]
  egress: EgressRecord[]
  timings_ms: Record<string, number>
  error: string | null
}

export interface AnalyzeResponse {
  job_id: string
}
