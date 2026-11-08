// Issue #16: runtime air-gap toggle + audit-log reads. Reuses the shared client's
// API_URL / MOCK so these views work identically against a live backend or, in
// VITE_MOCK=1, with no backend at all (fixtures + a local in-memory toggle).
import type { EgressRecord } from '../types'
import concertResult from './fixtures/concert_flyer.result.json'
import docResult from './fixtures/sensitive_doc.result.json'
import { API_URL, MOCK, getEgress } from './client'

// In-memory air-gap flag used only in VITE_MOCK mode (no backend to persist it).
let mockOffline = false

/** The mock air-gap flag, read by the VITE_MOCK event replay. */
export function isMockOffline(): boolean {
  return mockOffline
}

export async function getOffline(): Promise<boolean> {
  if (MOCK) return mockOffline
  const res = await fetch(`${API_URL}/api/offline`)
  if (!res.ok) throw new Error(`GET /api/offline failed: ${res.status} ${res.statusText}`)
  return ((await res.json()) as { offline: boolean }).offline
}

export async function setOffline(offline: boolean): Promise<boolean> {
  if (MOCK) {
    mockOffline = offline
    return mockOffline
  }
  const res = await fetch(`${API_URL}/api/offline`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offline }),
  })
  if (!res.ok) throw new Error(`POST /api/offline failed: ${res.status} ${res.statusText}`)
  return ((await res.json()) as { offline: boolean }).offline
}

// Fixture audit records for mock mode: the exact query bytes two demo jobs sent.
const MOCK_EGRESS: EgressRecord[] = [
  ...(concertResult.egress as EgressRecord[]),
  ...(docResult.egress as EgressRecord[]),
]

export async function fetchEgress(): Promise<EgressRecord[]> {
  if (MOCK) return [...MOCK_EGRESS].sort((a, b) => b.ts - a.ts)
  return getEgress()
}
