import { useEffect, useState } from 'react'
import { fetchEgress } from '../api/privacy'
import type { EgressRecord } from '../types'
import { auditRow } from './privacy.format'
import './privacy.css'

const POLL_MS = 2000

interface AuditDrawerViewProps {
  open: boolean
  records: EgressRecord[]
  onToggle: () => void
}

// Presentational drawer: pure function of its props so it can be snapshot/statically tested.
// Rows are already newest-first; the body preview is monospace and expandable via <details>.
export function AuditDrawerView({ open, records, onToggle }: AuditDrawerViewProps) {
  return (
    <>
      <button type="button" className="audit-open" aria-expanded={open} onClick={onToggle}>
        Audit log
      </button>
      <aside
        className={open ? 'audit-drawer audit-drawer-open' : 'audit-drawer'}
        aria-hidden={!open}
        aria-label="Egress audit log"
      >
        <header className="audit-header">
          <span>What left this device</span>
          <button type="button" className="audit-close" onClick={onToggle} aria-label="Close audit log">
            ×
          </button>
        </header>
        {records.length === 0 ? (
          <p className="audit-empty">Nothing has left this device yet.</p>
        ) : (
          <ol className="audit-rows">
            {records.map((record) => {
              const row = auditRow(record)
              return (
                <li key={row.id} className={row.status === 'BLOCKED' ? 'audit-row audit-blocked' : 'audit-row'}>
                  <div className="audit-line">
                    <time>{row.time}</time>
                    <span className="audit-target">{row.target}</span>
                    <span className="audit-bytes">{row.bytes} B</span>
                    <span className={`audit-status audit-status-${row.status.toLowerCase()}`}>
                      {row.status}
                      {row.reason ? ` · ${row.reason}` : ''}
                    </span>
                  </div>
                  <details className="audit-preview">
                    <summary>payload</summary>
                    <pre>{row.preview}</pre>
                  </details>
                </li>
              )
            })}
          </ol>
        )}
      </aside>
    </>
  )
}

// Container: owns open state and polls GET /api/egress every 2 s while open (newest first).
export function AuditDrawer() {
  const [open, setOpen] = useState(false)
  const [records, setRecords] = useState<EgressRecord[]>([])

  useEffect(() => {
    if (!open) return
    let active = true
    const load = () => {
      fetchEgress()
        .then((rows) => {
          if (active) setRecords(rows)
        })
        .catch(() => {
          /* keep the last records on a transient failure */
        })
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [open])

  return <AuditDrawerView open={open} records={records} onToggle={() => setOpen((v) => !v)} />
}
