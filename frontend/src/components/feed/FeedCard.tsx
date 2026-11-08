import { Bookmark, Check, ChevronRight, Sparkles, ThumbsUp } from 'lucide-react'
import type { FeedFeedbackAction, FeedItem } from '../../api/feed'

const KIND_LABELS: Record<FeedItem['kind'], string> = {
  discovery: 'A new discovery',
  connection: 'A connection',
  follow_up: 'Worth returning to',
  pattern: 'A pattern emerging',
}

interface FeedCardProps {
  item: FeedItem
  feedback: FeedFeedbackAction[]
  onOpen: () => void
  onFeedback: (action: FeedFeedbackAction) => void
}

export function FeedCard({ item, feedback, onOpen, onFeedback }: FeedCardProps) {
  const saved = feedback.includes('save')
  const useful = feedback.includes('useful')

  return (
    <article className={`feed-card feed-card-${item.kind}`} aria-labelledby={`feed-title-${item.id}`}>
      <div className="feed-art" role="img" aria-label={item.hero?.alt ?? `Ambient artwork for ${item.title}`}>
        <span /><span /><span />
        <p>{item.kind === 'connection' ? '02' : item.kind === 'pattern' ? '03' : '✦'}</p>
      </div>
      <div className="feed-card-content">
        <div className="feed-card-meta">
          <span className={`feed-provenance is-${item.provenance}`}>{item.provenance === 'local' ? 'LOCAL' : 'WEB'}</span>
          <span>{KIND_LABELS[item.kind]}</span>
          <time dateTime={new Date(item.created_at * 1000).toISOString()}>
            {new Date(item.created_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </time>
        </div>
        <h2 id={`feed-title-${item.id}`}>{item.title}</h2>
        <p className="feed-teaser">{item.teaser}</p>
        <div className="feed-why"><Sparkles size={14} aria-hidden="true" /><span><strong>Why this?</strong> {item.why}</span></div>
        <div className="feed-card-footer">
          <div className="feed-quick-actions" aria-label={`Feedback for ${item.title}`}>
            <button type="button" className={saved ? 'is-active' : ''} aria-pressed={saved} onClick={() => onFeedback('save')}>
              {saved ? <Check size={15} aria-hidden="true" /> : <Bookmark size={15} aria-hidden="true" />} {saved ? 'Saved' : 'Save'}
            </button>
            <button type="button" className={useful ? 'is-active' : ''} aria-pressed={useful} onClick={() => onFeedback('useful')}>
              <ThumbsUp size={15} aria-hidden="true" /> Useful
            </button>
          </div>
          <button type="button" className="feed-open" onClick={onOpen}>
            Open story <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </article>
  )
}
