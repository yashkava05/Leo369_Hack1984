import { API_URL, MOCK } from './client'
import feedFixture from './fixtures/feed.result.json'
import type {
  FeedFeedbackAction,
  FeedItemDetail,
  FeedResponse,
} from '../types'

export type {
  FeedFeedbackAction,
  FeedItem,
  FeedItemDetail,
} from '../types'

const MOCK_DETAILS = feedFixture as FeedItemDetail[]

const MOCK_TOPICS: Record<string, string[]> = {
  'feed-discovery-nova': ['live-music', 'port-aurora'],
  'feed-connection-trip': ['port-aurora', 'weekend-plans'],
  'feed-follow-up-calendar': ['events'],
  'feed-pattern-ceramics': ['independent-ceramics'],
}
const STORAGE_KEY = 'latent.feed.feedback.v2'
let memoryFeedback: Record<string, FeedFeedbackAction[]> = {}

function feedbackState(): Record<string, FeedFeedbackAction[]> {
  if (typeof localStorage === 'undefined') return memoryFeedback
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, FeedFeedbackAction[]>
  } catch {
    return memoryFeedback
  }
}

function storeFeedback(value: Record<string, FeedFeedbackAction[]>) {
  memoryFeedback = value
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    } catch {
      // The in-memory fallback still keeps mock feedback for this session.
    }
  }
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, init)
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status} ${response.statusText}`)
  return (await response.json()) as T
}

export async function getFeed(limit = 20): Promise<FeedResponse> {
  if (MOCK) {
    const hidden = feedbackState()
    const suppressedTopics = new Set(
      Object.entries(hidden)
        .filter(([, values]) => values.includes('less_like_this'))
        .flatMap(([id]) => MOCK_TOPICS[id] ?? []),
    )
    const items = MOCK_DETAILS.filter((item) => {
      const direct = hidden[item.id] ?? []
      if (direct.some((value) => value === 'dismiss' || value === 'not_useful')) return false
      return !(MOCK_TOPICS[item.id] ?? []).some((topic) => suppressedTopics.has(topic))
    })
      .slice(0, Math.min(20, limit))
      .map(({ body: _body, sources: _sources, cards: _cards, ...item }) => ({
        ...item,
        feedback: hidden[item.id] ?? [],
      }))
    return { items, next_cursor: null, generated_at: 1794088800 }
  }
  return json<FeedResponse>(`/api/feed?limit=${Math.min(20, Math.max(1, limit))}`)
}

export async function getFeedDetail(id: string): Promise<FeedItemDetail> {
  if (MOCK) {
    const item = MOCK_DETAILS.find((candidate) => candidate.id === id)
    if (!item) throw new Error('This feed item is no longer available.')
    return { ...structuredClone(item), feedback: feedbackState()[id] ?? [] }
  }
  return json<FeedItemDetail>(`/api/feed/${encodeURIComponent(id)}`)
}

export async function sendFeedFeedback(id: string, action: FeedFeedbackAction): Promise<void> {
  if (MOCK) {
    const state = feedbackState()
    storeFeedback({ ...state, [id]: [...new Set([...(state[id] ?? []), action])] })
    return
  }
  const response = await fetch(`${API_URL}/api/feed/${encodeURIComponent(id)}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  if (!response.ok) throw new Error(`POST /api/feed/${id}/feedback failed: ${response.status} ${response.statusText}`)
}

export async function refreshFeed(): Promise<{ accepted: true }> {
  if (MOCK) return { accepted: true }
  return json<{ accepted: true }>('/api/feed/refresh', { method: 'POST' })
}
