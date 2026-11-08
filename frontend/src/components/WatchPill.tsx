import { useEffect, useState } from 'react'
import { getWatch, subscribeWatch, type WatchStatus } from '../api/watch'
import { follow } from '../state/useJob'
import './WatchPill.css'

// Issue #20: when the backend watches a screenshot folder, show "Watching ~/Desktop" and
// switch the page to each new job it starts (unless the user is mid-job). Renders nothing
// when the watcher is off (LATENT_WATCH_DIR unset) or the backend is unreachable.
export function WatchPill() {
  const [status, setStatus] = useState<WatchStatus | null>(null)
  const [last, setLast] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getWatch()
      .then((value) => {
        if (active) setStatus(value)
      })
      .catch(() => {
        /* backend not reachable; no pill */
      })
    return () => {
      active = false
    }
  }, [])

  const enabled = status?.enabled ?? false
  useEffect(() => {
    if (!enabled) return
    return subscribeWatch((notice) => {
      setLast(notice.filename)
      follow(notice.job_id)
    })
  }, [enabled])

  return <WatchPillView status={status} last={last} />
}

export function WatchPillView({ status, last }: { status: WatchStatus | null; last?: string | null }) {
  if (!status?.enabled) return null
  return (
    <span className="watch-pill" role="status" title={last ? `Last picked up: ${last}` : undefined}>
      <span className="watch-dot" aria-hidden="true" />
      Watching {status.dir}
    </span>
  )
}
