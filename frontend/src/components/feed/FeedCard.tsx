import { Bookmark, Check, ChevronRight, ThumbsUp } from 'lucide-react'
import type { FeedFeedbackAction, FeedItem } from '../../api/feed'
import { placardFaces, type PlacardFace } from './stills'

const KIND_LABELS: Record<FeedItem['kind'], string> = {
  discovery: 'Nearby',
  connection: 'Linked',
  follow_up: 'Open loop',
  pattern: 'Repeat',
}

interface FeedCardProps {
  item: FeedItem
  feedback: FeedFeedbackAction[]
  onOpen: () => void
  onFeedback: (action: FeedFeedbackAction) => void
}

export function PlacardArt({ faces, className = 'feed-art' }: { faces: PlacardFace[]; className?: string }) {
  return (
    <div className={`${className}${faces.length > 1 ? ' is-pair' : ''}`}>
      {faces.map((face, index) => (
        <PlacardFaceView key={`${face.type}-${index}`} face={face} />
      ))}
    </div>
  )
}

function PlacardFaceView({ face }: { face: PlacardFace }) {
  if (face.type === 'photo') {
    return <img src={face.src} alt={face.alt} />
  }
  return (
    <div className={`feed-print feed-print-${face.theme}`} role="img" aria-label={`${face.line}. ${face.sub}`}>
      <span className="feed-print-rule" aria-hidden="true" />
      <p className="feed-print-kicker">{face.kicker}</p>
      <p className="feed-print-line">{face.line}</p>
      {face.sub && <p className="feed-print-sub">{face.sub}</p>}
    </div>
  )
}

export function FeedCard({ item, feedback, onOpen, onFeedback }: FeedCardProps) {
  const saved = feedback.includes('save')
  const useful = feedback.includes('useful')
  const faces = placardFaces(item)

  return (
    <article className={`feed-card feed-card-${item.kind}`} aria-labelledby={`feed-title-${item.id}`}>
      <PlacardArt faces={faces} />
      <div className="feed-card-content">
        <div className="feed-card-meta">
          <span className={`feed-provenance is-${item.provenance}`}>{item.provenance === 'local' ? 'On device' : 'From the web'}</span>
          <span>{KIND_LABELS[item.kind]}</span>
          <time dateTime={new Date(item.created_at * 1000).toISOString()}>
            {new Date(item.created_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </time>
        </div>
        <h2 id={`feed-title-${item.id}`}>{item.title}</h2>
        <p className="feed-teaser">{item.teaser}</p>
        <p className="feed-why">{item.why}</p>
        <div className="feed-card-footer">
          <div className="feed-quick-actions" aria-label={`Feedback for ${item.title}`}>
            <button type="button" className={saved ? 'is-active' : ''} aria-pressed={saved} onClick={() => onFeedback('save')}>
              {saved ? <Check size={15} aria-hidden="true" /> : <Bookmark size={15} aria-hidden="true" />} {saved ? 'Saved' : 'Keep'}
            </button>
            <button type="button" className={useful ? 'is-active' : ''} aria-pressed={useful} onClick={() => onFeedback('useful')}>
              <ThumbsUp size={15} aria-hidden="true" /> Useful
            </button>
          </div>
          <button type="button" className="feed-open" onClick={onOpen}>
            Read more <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </article>
  )
}
