/** SQLite is authoritative; browser storage holds acknowledged previews and a durable offline queue. */
import { API_URL, MOCK } from '../api/client'
import { KEPT_KEY, parseKept, readKept, writeKept } from './kept'
import type { KeptItem } from './messages'

const FENCE = 'latent:saved:epoch'
const SNAPSHOT = 'latent:saved:snapshot'
const QUEUE = 'latent:saved:pending:'
interface Pending { id: string; epoch: number | null; item: KeptItem; blocked?: boolean }
interface Snapshot { epoch: number; items: KeptItem[] }
interface SavedResponse { memory_epoch: number; items: { id: string; label: string; intent_type: KeptItem['intent_type']; saved_at: number; cards: KeptItem['cards'] }[] }
export interface SavedView { items: KeptItem[]; blocked: Pending[]; notice: string }
let observedEpoch: number | null = null
let localGeneration = 0
let deleting = false
let syncing: Promise<SavedView> | null = null

function fence(): number {
  const value = Number(localStorage.getItem(FENCE) ?? '0')
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Unreadable reset fence')
  return value
}
async function locked<T>(operation: () => T): Promise<T> {
  if (!globalThis.navigator?.locks) throw new Error('Browser storage locking unavailable')
  return navigator.locks.request('latent-saved-memory', operation)
}
function snapshot(): Snapshot | null {
  try {
    const value = JSON.parse(localStorage.getItem(SNAPSHOT) ?? 'null')
    return value && Number.isInteger(value.epoch) && value.epoch >= fence() ? { epoch: value.epoch, items: parseKept(value.items) } : null
  } catch { return null }
}
function pending(): Pending[] {
  const out: Pending[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(QUEUE)) continue
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as Pending | null
    if (!value || typeof value.id !== 'string' || (value.epoch !== null && !Number.isInteger(value.epoch)) || parseKept([value.item]).length !== 1) throw new Error('Unreadable pending save; browser copy retained.')
    out.push(value)
  }
  return out
}
function writePending(value: Pending) { localStorage.setItem(QUEUE + value.id, JSON.stringify(value)) }
function view(notice = ''): SavedView {
  const cached = snapshot()
  const queue = pending()
  const items = new Map<string, KeptItem>()
  for (const item of [...(cached?.items ?? []), ...readKept(), ...queue.filter((p) => !p.blocked).map((p) => p.item)]) items.set(item.id ?? `${item.savedAt}:${item.label}`, item)
  return { items: [...items.values()].sort((a, b) => b.savedAt - a.savedAt), blocked: queue.filter((p) => p.blocked), notice }
}
export function initialSaved(): KeptItem[] {
  if (MOCK) return readKept()
  try { return view().items } catch { return readKept() }
}
async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_URL}/api${path}`, init)
}
async function getSaved(): Promise<SavedResponse> {
  const response = await request('/saved')
  if (!response.ok) throw new Error('Saved items unavailable')
  return response.json() as Promise<SavedResponse>
}
async function legacyId(item: KeptItem): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(item)))
  return 'legacy-' + Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')
}
async function sync(): Promise<SavedView> {
  const generation = localGeneration
  const check = () => { if (generation !== localGeneration) throw new Error('Local memory was reset') }
  await getSaved()
  check()
  // Persist the original epoch with each queue entry. A status refresh never upgrades it.
  const legacySource = localStorage.getItem(KEPT_KEY)
  for (const item of parseKept(JSON.parse(legacySource ?? '[]'))) {
    const id = await legacyId(item)
    check()
    if (!localStorage.getItem(QUEUE + id)) writePending({ id, epoch: null, item: { ...item, id } })
  }
  for (const entry of pending()) {
    if (entry.blocked) continue
    check()
    const response = await request('/saved/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memory_epoch: entry.epoch, items: [{ id: entry.id, label: entry.item.label, intent_type: entry.item.intent_type, saved_at: entry.item.savedAt / 1000, cards: entry.item.cards }] }),
    })
    check()
    if (response.status === 409) {
      writePending({ ...entry, blocked: true })
      continue
    }
    if (!response.ok) throw new Error('Save not acknowledged')
    const body = await response.json() as { results: { id: string; status: string }[] }
    if (!body.results.some((r) => r.id === entry.id && ['saved', 'exists', 'tombstoned'].includes(r.status))) throw new Error('Save not acknowledged')
    check()
    localStorage.removeItem(QUEUE + entry.id)
  }
  // Only discard the legacy source after every item has been acknowledged or durably quarantined.
  if (localStorage.getItem(KEPT_KEY) === legacySource) localStorage.removeItem(KEPT_KEY)
  const latest = await getSaved()
  const cached: Snapshot = { epoch: latest.memory_epoch, items: latest.items.map((item) => ({ id: item.id, label: item.label, intent_type: item.intent_type, savedAt: item.saved_at * 1000, cards: item.cards })) }
  await locked(() => {
    check()
    if (latest.memory_epoch < fence()) throw new Error('Snapshot predates a reset in another tab')
    const serialized = JSON.stringify(cached)
    if (localStorage.getItem(SNAPSHOT) !== serialized) localStorage.setItem(SNAPSHOT, serialized)
    if (latest.memory_epoch > fence()) localStorage.setItem(FENCE, String(latest.memory_epoch))
    observedEpoch = latest.memory_epoch
  })
  const result = view()
  result.notice = result.blocked.length ? 'Some browser saves predate a reset. Review them before restoring.' : pending().length ? 'Your save is queued in this browser. Sync again to confirm persistence.' : ''
  return result
}
export async function syncSaved(): Promise<SavedView> {
  if (MOCK) return { items: readKept(), blocked: [], notice: 'Demo saves stay in this browser.' }
  if (syncing) return syncing
  syncing = sync().catch(() => view('Saved sync unavailable. Unacknowledged saves remain in this browser; retry when the backend is available.')).finally(() => { syncing = null })
  return syncing
}
export async function keepSaved(item: KeptItem): Promise<SavedView> {
  if (deleting) throw new Error('Memory reset in progress; retry saving afterward')
  if (MOCK) { writeKept([item, ...readKept()]); return { items: readKept(), blocked: [], notice: '' } }
  const id = crypto.randomUUID()
  const epoch = observedEpoch ?? snapshot()?.epoch ?? null
  writePending({ id, epoch, item: { ...item, id } })
  return syncSaved()
}
export async function resolvePending(id: string, restore: boolean): Promise<SavedView> {
  if (deleting) throw new Error('Memory reset in progress')
  const generation = localGeneration
  const entry = pending().find((p) => p.id === id && p.blocked)
  if (!entry) return syncSaved()
  if (restore) {
    const remote = await getSaved()
    if (generation !== localGeneration) throw new Error('Local memory was reset')
    // Explicit restoration is a new save, not a replay that bypasses a deletion tombstone.
    const newId = crypto.randomUUID()
    writePending({ id: newId, epoch: remote.memory_epoch, item: { ...entry.item, id: newId } })
  }
  localStorage.removeItem(QUEUE + id)
  return syncSaved()
}
export async function deleteMemory(): Promise<void> {
  if (deleting) throw new Error('Memory reset already in progress')
  deleting = true
  localGeneration++
  try {
    // A different tab may create new offline saves during the request. Leave those queued.
    const oldPending = pending()
    const oldLegacy = localStorage.getItem(KEPT_KEY)
    if (!MOCK) {
      const response = await request('/memory?confirm=DELETE_ALL_LOCAL_DATA', { method: 'DELETE' })
      if (!response.ok) throw new Error('Delete All was not confirmed by the backend')
      observedEpoch = ((await response.json()) as { memory_epoch: number }).memory_epoch
    }
    await locked(() => {
      // Keep only the non-content epoch fence, including across reloads and other tabs.
      if (observedEpoch !== null) localStorage.setItem(FENCE, String(Math.max(fence(), observedEpoch)))
      for (const entry of oldPending) localStorage.removeItem(QUEUE + entry.id)
      if (localStorage.getItem(KEPT_KEY) === oldLegacy) localStorage.removeItem(KEPT_KEY)
      localStorage.removeItem(SNAPSHOT)
    })
  } finally { deleting = false }
}
