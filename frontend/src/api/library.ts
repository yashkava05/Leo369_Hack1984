// Issue #21: local intent library. Finished jobs live in ~/.latent/latent.db on the backend;
// in VITE_MOCK=1 (no backend) an in-memory list stands in, filled as mock jobs finish.
import type { IntentType, JobResult } from '../types'
import { API_URL, MOCK } from './client'

export interface LibraryItem {
  id: string
  created_at: number
  intent_type: IntentType
  summary: string
  card_count: number
}

export interface LibraryQuery {
  q?: string
  type?: IntentType
  limit?: number
}

// --- mock store -----------------------------------------------------------------------

const mockStore = new Map<string, { item: LibraryItem; result: JobResult; text: string }>()

/** VITE_MOCK only: remember a finished mock job, as the backend does on `done`. */
export function recordMockResult(result: JobResult): void {
  if (result.status !== 'done' || !result.intent) return
  const { intent } = result
  mockStore.set(result.job_id, {
    item: {
      id: result.job_id,
      created_at: Date.now() / 1000,
      intent_type: intent.intent_type,
      summary: intent.summary,
      card_count: result.cards.length,
    },
    result: { ...result, egress: [] },
    text: [intent.summary, ...intent.public_entities.map((e) => e.value)].join(' ').toLowerCase(),
  })
}

function mockList({ q = '', type, limit = 50 }: LibraryQuery): LibraryItem[] {
  const words = q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
  if (q.trim() && words.length === 0) return []
  return [...mockStore.values()]
    .filter((row) => !type || row.item.intent_type === type)
    .filter((row) => words.every((w) => row.text.split(/[^\p{L}\p{N}_]+/u).some((t) => t.startsWith(w))))
    .map((row) => row.item)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit)
}

// --- API --------------------------------------------------------------------------------

async function check(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${res.statusText}`)
  return res
}

export async function listLibrary(query: LibraryQuery = {}): Promise<LibraryItem[]> {
  if (MOCK) return mockList(query)
  const params = new URLSearchParams()
  if (query.q) params.set('q', query.q)
  if (query.type) params.set('type', query.type)
  params.set('limit', String(query.limit ?? 50))
  const res = await check(await fetch(`${API_URL}/api/library?${params}`), 'GET /api/library')
  return (await res.json()) as LibraryItem[]
}

export async function getLibraryItem(id: string): Promise<JobResult> {
  if (MOCK) {
    const row = mockStore.get(id)
    if (!row) throw new Error('not in the library')
    return row.result
  }
  const res = await check(
    await fetch(`${API_URL}/api/library/${encodeURIComponent(id)}`),
    'GET /api/library/{id}',
  )
  return (await res.json()) as JobResult
}

export async function deleteLibraryItem(id: string): Promise<void> {
  if (MOCK) {
    mockStore.delete(id)
    return
  }
  await check(
    await fetch(`${API_URL}/api/library/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    'DELETE /api/library/{id}',
  )
}

export async function wipeLibrary(): Promise<void> {
  if (MOCK) {
    mockStore.clear()
    return
  }
  await check(await fetch(`${API_URL}/api/library`, { method: 'DELETE' }), 'DELETE /api/library')
}
