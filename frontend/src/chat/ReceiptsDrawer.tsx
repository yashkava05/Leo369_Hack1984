import { useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { MOCK, getEgress } from '../api/client'
import type { EgressRecord } from '../types'
import { queryPreview, receiptTotals } from './receipts'

export function ReceiptsDrawer({ open, onClose, mockRecords, selectedRecords = null }: {
  open: boolean
  onClose: () => void
  mockRecords: EgressRecord[]
  selectedRecords?: EgressRecord[] | null
}) {
  const titleId = useId()
  const drawerRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  const [records, setRecords] = useState<EgressRecord[]>([])
  const [pollError, setPollError] = useState(false)

  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  useEffect(() => {
    if (!open) return
    const opener = document.activeElement
    closeRef.current?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
      } else if (event.key === 'Tab') {
        const buttons = drawerRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        if (!buttons?.length) return
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        const active = document.activeElement
        if (!drawerRef.current?.contains(active) || (event.shiftKey ? active === first : active === last)) {
          event.preventDefault()
          const target = event.shiftKey ? last : first
          target.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open || MOCK || selectedRecords !== null) return
    let active = true
    let pending = false
    const poll = async () => {
      if (pending) return
      pending = true
      try {
        const next = await getEgress()
        if (active) {
          setRecords(next)
          setPollError(false)
        }
      } catch {
        if (active) setPollError(true)
      } finally {
        pending = false
      }
    }
    void poll()
    const interval = window.setInterval(() => { void poll() }, 2000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [open, selectedRecords])

  if (!open) return null
  const visibleRecords = selectedRecords ?? (MOCK ? mockRecords : records)
  const { sent, bytes, blocked } = receiptTotals(visibleRecords)

  return (
    <div className="chat-receipt-scrim" onClick={onClose}>
      <aside className="chat-receipts" role="dialog" aria-modal="true" aria-labelledby={titleId}
        ref={drawerRef} onClick={(event) => event.stopPropagation()}>
        <div className="chat-receipts-head">
          <h2 id={titleId}>What left this device</h2>
          <button ref={closeRef} className="chat-icon-button" type="button" onClick={onClose}
            aria-label="Close receipts">
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <p className="chat-receipts-summary">
          {`Image data sent: 0 bytes. ${sent} text searches sent, ${bytes} bytes. ${blocked} blocked.`}
        </p>
        {pollError && <p className="chat-error" role="alert">Could not load receipts. Retrying every 2 seconds.</p>}
        {visibleRecords.length === 0 && <p className="chat-muted">No searches recorded yet.</p>}
        <ul className="chat-receipt-list">
          {[...visibleRecords].sort((a, b) => b.ts - a.ts).map((record) => (
            <li className="chat-receipt-row" key={record.id}>
              <time dateTime={new Date(record.ts * 1000).toISOString()}>
                {new Date(record.ts * 1000).toLocaleTimeString()}
              </time>
              <span>Web search</span>
              <span className={`chat-tag ${record.blocked ? 'block' : 'net'}`}>
                {record.blocked ? `Blocked: ${record.reason || 'Search blocked'}` : `Sent ${record.bytes_out} bytes`}
              </span>
              <pre className="chat-receipt-query">{queryPreview(record)}</pre>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  )
}
