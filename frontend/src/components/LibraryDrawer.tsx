import { useEffect, useState } from 'react'
import { deleteLibraryItem, getLibraryItem, listLibrary, wipeLibrary, type LibraryItem } from '../api/library'
import { openResult, useJob } from '../state/useJob'
import type { IntentType } from '../types'
import './library.css'

// Issue #21: the local intent library. Every finished job is saved on this device; this drawer
// lists, searches, reopens and deletes them. Nothing here leaves the machine.

const INTENT_TYPES: IntentType[] = ['event', 'product', 'book', 'place', 'chart', 'document', 'other']
const SEARCH_DEBOUNCE_MS = 200

function formatSavedAt(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export interface LibraryDrawerViewProps {
  open: boolean
  items: LibraryItem[]
  query: string
  type: IntentType | null
  error: string | null
  onToggle: () => void
  onQuery: (q: string) => void
  onType: (type: IntentType | null) => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onWipe: () => void
}

// Presentational drawer: a pure function of its props so it can be rendered in tests.
export function LibraryDrawerView(props: LibraryDrawerViewProps) {
  const { open, items, query, type, error, onToggle, onQuery, onType, onOpen, onDelete, onWipe } = props
  const filtering = query.trim() !== '' || type !== null
  return (
    <>
      <button type="button" className="library-open" aria-expanded={open} onClick={onToggle}>
        Library
      </button>
      <aside
        className={open ? 'library-drawer library-drawer-open' : 'library-drawer'}
        aria-hidden={!open}
        aria-label="Intent library"
      >
        <header className="library-header">
          <span>Saved on this device</span>
          <button type="button" className="library-close" onClick={onToggle} aria-label="Close library">
            ×
          </button>
        </header>
        <input
          type="search"
          className="library-search"
          placeholder="Search performers, products, places…"
          aria-label="Search the library"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <div className="library-chips" role="group" aria-label="Filter by type">
          <button type="button" className="library-chip" aria-pressed={type === null} onClick={() => onType(null)}>
            all
          </button>
          {INTENT_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className="library-chip"
              aria-pressed={type === t}
              onClick={() => onType(type === t ? null : t)}
            >
              {t}
            </button>
          ))}
        </div>
        {error && (
          <p className="library-error" role="alert">
            {error}
          </p>
        )}
        {items.length === 0 ? (
          <p className="library-empty">{filtering ? 'No saved intents match.' : 'Nothing saved yet.'}</p>
        ) : (
          <ol className="library-rows">
            {items.map((item) => (
              <li key={item.id} className="library-row">
                <button type="button" className="library-item" onClick={() => onOpen(item.id)}>
                  <span className="library-meta">
                    <span className="library-type">{item.intent_type}</span>
                    <time>{formatSavedAt(item.created_at)}</time>
                    <span>
                      {item.card_count} card{item.card_count === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="library-summary">{item.summary}</span>
                </button>
                <button
                  type="button"
                  className="library-delete"
                  aria-label={`Delete "${item.summary}"`}
                  onClick={() => onDelete(item.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
        )}
        <button type="button" className="library-wipe" onClick={onWipe}>
          Delete everything
        </button>
      </aside>
    </>
  )
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// Container: loads the list while open (and after each finished job), debounces the search box,
// reopens a saved result into the shared job store, and confirms before wiping.
export function LibraryDrawer() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<LibraryItem[]>([])
  const [query, setQuery] = useState('')
  const [type, setType] = useState<IntentType | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const { status, jobId } = useJob()

  useEffect(() => {
    if (!open) return
    let active = true
    const timer = setTimeout(() => {
      listLibrary({ q: query, type: type ?? undefined })
        .then((rows) => {
          if (!active) return
          setItems(rows)
          setError(null)
        })
        .catch((err: unknown) => {
          if (active) setError(message(err))
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [open, query, type, version, status, jobId])

  const refresh = () => setVersion((v) => v + 1)

  const onOpen = (id: string) => {
    getLibraryItem(id)
      .then((result) => {
        openResult(result)
        setOpen(false)
      })
      .catch((err: unknown) => setError(message(err)))
  }

  const onDelete = (id: string) => {
    deleteLibraryItem(id)
      .then(refresh)
      .catch((err: unknown) => setError(message(err)))
  }

  const onWipe = () => {
    if (!window.confirm('Delete every saved intent from this device? This cannot be undone.')) return
    wipeLibrary()
      .then(refresh)
      .catch((err: unknown) => setError(message(err)))
  }

  return (
    <LibraryDrawerView
      open={open}
      items={items}
      query={query}
      type={type}
      error={error}
      onToggle={() => setOpen((v) => !v)}
      onQuery={setQuery}
      onType={setType}
      onOpen={onOpen}
      onDelete={onDelete}
      onWipe={onWipe}
    />
  )
}
