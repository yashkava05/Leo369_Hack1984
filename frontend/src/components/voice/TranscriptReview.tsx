import { useId } from 'react'
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
  onRetry: () => void
  onCancel: () => void
}
export function TranscriptReview(props: Props) {
  const id = useId()
  const locked = props.busy || props.disabled
  return <div className="voice-review">
    <label htmlFor={`${id}-text`}>Review or type your thought</label>
    <textarea id={`${id}-text`} value={props.text} maxLength={1000} disabled={locked} onChange={(event) => props.onText(event.target.value)} placeholder="Type here, or record a short thought…" aria-describedby={`${id}-privacy`} rows={3} />
    <p id={`${id}-privacy`} className="voice-note">Review before choosing an action. Audio and text stay local; only scrubbed public searches may leave.</p>
    <div className="voice-context">
      <button type="button" disabled={locked || props.loading} onClick={props.onLoad}>{props.loading ? 'Loading library…' : 'Choose saved context'}</button>
      {props.items.length > 0 && <><label htmlFor={`${id}-context`}>One saved item for Find related</label>
        <select id={`${id}-context`} value={props.context?.id ?? ''} disabled={locked || props.loading} onChange={(event) => props.onSelect(event.target.value)}>
          <option value="">Select one saved item</option>
          {props.items.map((item) => <option key={item.id} value={item.id}>{item.summary}</option>)}
        </select></>}
      {props.context && <span className="voice-chip">{props.context.summary}<button type="button" disabled={locked} onClick={props.onRemove} aria-label="Remove saved context">×</button></span>}
      {props.libraryError && <p role="status">{props.libraryError}</p>}
    </div>
    <div className="voice-actions">
      <button type="button" disabled={locked || !props.text.trim()} onClick={() => props.onAction('explore')}>Explore</button>
      <button type="button" disabled={locked || !props.text.trim()} onClick={() => props.onAction('save')}>Save locally</button>
      <button type="button" disabled={locked || props.loading || !props.text.trim() || !props.context} onClick={() => props.onAction('related')}>Find related</button>
      <button type="button" disabled={locked} onClick={props.onRetry}>Retry</button>
      <button type="button" onClick={props.onCancel}>Cancel</button>
    </div>
  </div>
}
