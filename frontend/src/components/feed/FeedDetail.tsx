import { Bookmark, Check, ExternalLink, Sparkles, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { FeedFeedbackAction, FeedItemDetail } from '../../api/feed'
import { ActionCard } from '../cards/ActionCard'

interface FeedDetailProps {
  item: FeedItemDetail
  feedback: FeedFeedbackAction[]
  onClose: () => void
  onFeedback: (action: FeedFeedbackAction) => void
}

export function FeedDetail({ item, feedback, onClose, onFeedback }: FeedDetailProps) {
  const closeButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const scrim = dialog.current?.parentElement
    const siblings = scrim?.parentElement
      ? [...scrim.parentElement.children].filter(
          (element): element is HTMLElement => element instanceof HTMLElement && element !== scrim,
        )
      : []
    const sidebar = scrim?.closest('.feed-app')?.querySelector<HTMLElement>('.feed-sidebar')
    const background = sidebar ? [...siblings, sidebar] : siblings
    const inertState = background.map((element) => element.inert)
    const previousOverflow = document.body.style.overflow
    background.forEach((element) => { element.inert = true })
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = dialog.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])')
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      background.forEach((element, index) => { element.inert = inertState[index] })
      document.body.style.overflow = previousOverflow
      previous?.focus()
    }
  }, [onClose])

  const selected = (action: FeedFeedbackAction) => feedback.includes(action)

  return (
    <div className="feed-detail-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialog} className="feed-detail" role="dialog" aria-modal="true" aria-labelledby="feed-detail-title">
        <header>
          <div>
            <span className={`feed-provenance is-${item.provenance}`}>{item.provenance === 'local' ? 'LOCAL' : 'WEB'}</span>
            <p>{item.kind.replace('_', ' ')}</p>
          </div>
          <button ref={closeButton} type="button" className="feed-icon-button" aria-label="Close story" onClick={onClose}><X size={19} /></button>
        </header>
        <div className={`feed-detail-art feed-art-${item.kind}`} role="img" aria-label={item.hero?.alt ?? `Ambient artwork for ${item.title}`}>
          <span /><span /><span />
        </div>
        <div className="feed-detail-copy">
          <h2 id="feed-detail-title">{item.title}</h2>
          <p className="feed-detail-body">{item.body}</p>
          <div className="feed-detail-why">
            <Sparkles size={17} aria-hidden="true" />
            <div><h3>Why this?</h3><p>{item.why}</p></div>
          </div>

          <section className="feed-evidence" aria-labelledby="feed-evidence-title">
            <h3 id="feed-evidence-title">Source evidence</h3>
            <ul>
              {item.sources.map((source, index) => (
                <li key={`${source.title}-${index}`}>
                  <span>{source.job_id ? 'Saved memory' : 'Public source'}</span>
                  {source.url
                    ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}<ExternalLink size={13} aria-hidden="true" /></a>
                    : <strong>{source.title}</strong>}
                </li>
              ))}
            </ul>
          </section>

          {item.cards.length > 0 && (
            <section className="feed-actions" aria-labelledby="feed-actions-title">
              <h3 id="feed-actions-title">Next moves</h3>
              <div>{item.cards.map((card) => <ActionCard key={card.id} card={card} />)}</div>
              <p>Actions happen only when you choose them.</p>
            </section>
          )}

          <section className="feed-feedback" aria-labelledby="feed-feedback-title">
            <h3 id="feed-feedback-title">Tune your feed</h3>
            <div>
              <button type="button" aria-pressed={selected('save')} className={selected('save') ? 'is-active' : ''} onClick={() => onFeedback('save')}>
                {selected('save') ? <Check size={15} /> : <Bookmark size={15} />} {selected('save') ? 'Saved' : 'Save'}
              </button>
              <button type="button" aria-pressed={selected('useful')} className={selected('useful') ? 'is-active' : ''} onClick={() => onFeedback('useful')}><ThumbsUp size={15} /> Useful</button>
              <button type="button" aria-pressed={selected('not_useful')} className={selected('not_useful') ? 'is-active' : ''} onClick={() => onFeedback('not_useful')}><ThumbsDown size={15} /> Not useful</button>
              <button type="button" onClick={() => onFeedback('less_like_this')}>Show less like this</button>
              <button type="button" className="is-danger" onClick={() => onFeedback('dismiss')}>Dismiss</button>
            </div>
          </section>
        </div>
      </section>
    </div>
  )
}
