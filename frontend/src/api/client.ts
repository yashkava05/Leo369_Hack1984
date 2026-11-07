import type { HealthResponse } from '../types'

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_URL}/api/health`)
  if (!res.ok) {
    throw new Error(`GET /api/health failed: ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as HealthResponse
}
