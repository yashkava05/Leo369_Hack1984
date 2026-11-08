import { useId, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Bookmark, Mic, Search, Sparkles, X } from 'lucide-react'
import type { VoiceAction } from '../../api/voice'
import type { LibraryItem } from '../../api/library'

interface Props {
  text: string
  busy: boolean
  disabled?: boolean
  items: LibraryItem[]
  context: { id: string; summary: string } | null
  loading: boolean
  libraryError: string | null
  onText: (text: string) => void
  onSelect: (id: string) => void
  onRemove: () => void
  onLoad: () => void
  onAction: (action: VoiceAction) => void
  onRerecord: () => void
  onDiscard: () => void
}

/**
 * The one review step: the user sees (and can fix) exactly what will be interpreted, then picks
 * an action with a button. Search is the obvious default; "related" only appears on request.
 */
export function TranscriptReview(props: Props) {
  const id = useId()
  const [pickRelated, setPickRelated] = useState(false)
  const locked = props.busy || !!props.disabled
  const empty = !props.text.trim()
  const primary: VoiceAction = props.context ? 'related' : 'explore'
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !locked && !empty) {
      event.preventDefault()
      props.onAction(primary)
    }
  }
  const showPicker = pickRelated || !!props.context || props.items.length > 0 || !!props.libraryError

  return <div className="voice-review">
    <label htmlFor={`${id}-text`} className="visually-hidden">Your thought (edit before searching)</label>
    <textarea id={`${id}-text`} value={props.text} maxLength={1000} disabled={locked} rows={2}
      onChange={(event) => props.onText(event.target.value)} onKeyDown={onKeyDown}
      placeholder="Type or fix your thought…" aria-describedby={`${id}-hint`} />
    <p id={`${id}-hint`} className="voice-hint">Check the text, then choose what to do.<span className="voice-shortcut"> <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd> to {props.context ? 'find related' : 'search'}.</span></p>

    {props.context && <div className="voice-chip">
      <Sparkles size={14} aria-hidden="true" /><span>Like: {props.context.summary}</span>
      <button type="button" className="voice-icon" disabled={locked} onClick={() => { props.onRemove(); setPickRelated(false) }} aria-label="Remove saved context"><X size={14} aria-hidden="true" /></button>
    </div>}

    <div className="voice-actions">
      {props.context
        ? <button type="button" className="voice-primary" disabled={locked || props.loading || empty} onClick={() => props.onAction('related')}><Sparkles size={16} aria-hidden="true" />Find related</button>
        : <button type="button" className="voice-primary" disabled={locked || empty} onClick={() => props.onAction('explore')}><Search size={16} aria-hidden="true" />Search</button>}
      <button type="button" className="voice-secondary" disabled={locked || empty} onClick={() => props.onAction('save')}><Bookmark size={16} aria-hidden="true" />Save for later</button>
      <span className="voice-spacer" />
      <button type="button" className="voice-icon" disabled={locked} onClick={props.onRerecord} aria-label="Record again" title="Record again"><Mic size={16} aria-hidden="true" /></button>
      <button type="button" className="voice-icon" onClick={props.onDiscard} aria-label="Discard" title="Discard"><X size={16} aria-hidden="true" /></button>
    </div>

    {!props.context && !showPicker && <button type="button" className="voice-link" disabled={locked} onClick={() => { setPickRelated(true); props.onLoad() }}>More like a saved item…</button>}
    {!props.context && showPicker && <div className="voice-related">
      {props.loading && <p role="status" className="voice-hint">Loading your saved items…</p>}
      {props.items.length > 0 && <>
        <label htmlFor={`${id}-context`} className="voice-hint">Find things like one saved item</label>
        <select id={`${id}-context`} value="" disabled={locked || props.loading} onChange={(event) => props.onSelect(event.target.value)}>
          <option value="">Choose a saved item…</option>
          {props.items.map((item) => <option key={item.id} value={item.id}>{item.summary}</option>)}
        </select>
      </>}
      {props.libraryError && <>
        <p role="status" className="voice-hint">{props.libraryError}</p>
        <button type="button" className="voice-link" disabled={locked || props.loading} onClick={props.onLoad}>Retry loading saved items</button>
      </>}
    </div>}
  </div>
}
