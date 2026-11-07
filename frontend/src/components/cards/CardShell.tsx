import { Cpu, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Card } from '../../types'
import { ActionButton } from './ActionButton'
import { cardActions, isLocalCard } from './cardActions'
import './cards.css'

interface CardShellProps {
  card: Card
  icon: LucideIcon
  kindLabel: string
  /** Price badge text, e.g. 'from $45'. */
  badge?: string | null
  /** Hide the subtitle when the variant body already shows the same facts. */
  hideSubtitle?: boolean
  /** Variant body; defaults to the clamped snippet. */
  children?: ReactNode
}

export function CardShell({ card, icon: Icon, kindLabel, badge, hideSubtitle, children }: CardShellProps) {
  const local = isLocalCard(card)
  const actions = cardActions(card)
  const titleId = `card-${card.id}-title`

  return (
    <article className={`action-card action-card--${card.kind}`} aria-labelledby={titleId} data-kind={card.kind}>
      <header className="card-head">
        <span className="card-kind">
          <Icon size={16} aria-hidden="true" />
          {kindLabel}
        </span>
        {badge && <span className="card-badge">{badge}</span>}
      </header>

      <h3 className="card-title" id={titleId}>
        {card.title}
      </h3>
      {card.subtitle && !hideSubtitle && <p className="card-subtitle">{card.subtitle}</p>}

      <div className="card-body">{children ?? (card.snippet && <p className="card-snippet">{card.snippet}</p>)}</div>

      {actions.length > 0 && (
        <div className="card-actions">
          {actions.map((action, i) => (
            <ActionButton key={`${action.type}-${action.label}`} action={action} card={card} primary={i === 0} />
          ))}
        </div>
      )}

      <footer className="card-source">
        {local ? (
          <span className="card-source--local">
            <Cpu size={12} aria-hidden="true" />
            Built on-device
          </span>
        ) : (
          <span title="Where this information came from">Source: {card.source}</span>
        )}
      </footer>
    </article>
  )
}
