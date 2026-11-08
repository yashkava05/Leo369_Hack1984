// Issue #20: opt-in folder watcher. The backend starts a job for every new screenshot in
// LATENT_WATCH_DIR and broadcasts it here; the UI shows a pill and follows the newest job.
import { API_URL, MOCK } from './client'

export interface WatchStatus {
  enabled: boolean
  dir: string | null
}

export interface WatchJobNotice {
  job_id: string
  filename: string
}

const OFF: WatchStatus = { enabled: false, dir: null }

/** GET /api/watch. In VITE_MOCK mode there is no backend folder to watch, so it is off. */
export async function getWatch(): Promise<WatchStatus> {
  if (MOCK) return OFF
  const res = await fetch(`${API_URL}/api/watch`)
  if (!res.ok) throw new Error(`GET /api/watch failed: ${res.status} ${res.statusText}`)
  return (await res.json()) as WatchStatus
}

/** Subscribe to GET /api/watch/events (`event: job`). Returns an unsubscribe function. */
export function subscribeWatch(onJob: (notice: WatchJobNotice) => void): () => void {
  if (MOCK) return () => {}
  const source = new EventSource(`${API_URL}/api/watch/events`)
  source.addEventListener('job', (msg) => {
    try {
      onJob(JSON.parse((msg as MessageEvent<string>).data) as WatchJobNotice)
    } catch {
      /* ignore a malformed notice */
    }
  })
  // EventSource reconnects on its own if the backend restarts; nothing else to handle.
  return () => source.close()
}
