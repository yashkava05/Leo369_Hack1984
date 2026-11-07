import type { EgressRecord, HealthResponse, JobResult } from '../types'

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'
export const MOCK: boolean = import.meta.env.VITE_MOCK === '1'

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_URL}/api/health`)
  if (!res.ok) {
    throw new Error(`GET /api/health failed: ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as HealthResponse
}

export async function getJob(jobId: string): Promise<JobResult> {
  const res = await fetch(`${API_URL}/api/jobs/${encodeURIComponent(jobId)}`)
  if (!res.ok) {
    throw new Error(`GET /api/jobs/${jobId} failed: ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as JobResult
}

export async function getEgress(): Promise<EgressRecord[]> {
  const res = await fetch(`${API_URL}/api/egress`)
  if (!res.ok) {
    throw new Error(`GET /api/egress failed: ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as EgressRecord[]
}
