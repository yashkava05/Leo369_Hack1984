import type { Card, EgressRecord, IntentType, JobResult, StageEvent } from '../types'

interface Message { id: string }
export type ChatMessage =
  | (Message & { type: 'user-image'; url: string; name: string })
  | (Message & { type: 'user-text' | 'agent-text'; text: string })
  | (Message & { type: 'typing'; turn: string })
  | (Message & { type: 'work-steps'; source?: 'voice'; savedLocally?: boolean; turn: string; events: StageEvent[]; startedAt: number; finishedAt?: number; result?: JobResult; failed?: boolean })
  | (Message & { type: 'cards'; cards: Card[] })
  | (Message & { type: 'receipt'; source?: 'voice'; records: EgressRecord[] })
  | (Message & { type: 'ask'; kind: 'calendar' | 'save' | 'resume'; question: string; primary: string; result: JobResult; file?: File; choice?: string })

export interface KeptItem {
  id?: string
  label: string
  intent_type: IntentType
  savedAt: number
  cards: Card[]
}
