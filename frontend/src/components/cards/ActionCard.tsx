import { BookOpen, CalendarDays, Lightbulb, Link2, MapPin, ShoppingBag, Sparkles, Ticket } from 'lucide-react'
import type { JSX } from 'react'
import type { Card } from '../../types'
import { formatEventWhen } from './cardActions'
import { CardShell } from './CardShell'

function Snippet({ card }: { card: Card }) {
  return card.snippet ? <p className="card-snippet">{card.snippet}</p> : null
}

function TicketsCard({ card }: { card: Card }) {
  return <CardShell card={card} icon={Ticket} kindLabel="Tickets" badge={card.price && `from ${card.price}`} />
}

function CalendarCard({ card }: { card: Card }) {
  const ics = card.actions.find((a) => a.type === 'download_ics')?.ics
  const when = ics ? formatEventWhen(ics.start) : null
  return (
    <CardShell card={card} icon={CalendarDays} kindLabel="Calendar" hideSubtitle={when !== null}>
      {when && (
        <p className="card-when">
          <span className="card-when-day">{when.day}</span>
          {when.time && <span className="card-when-time">{when.time}</span>}
        </p>
      )}
      {ics?.location && <p className="card-meta">{ics.location}</p>}
      <Snippet card={card} />
    </CardShell>
  )
}

function PlaceCard({ card }: { card: Card }) {
  return <CardShell card={card} icon={MapPin} kindLabel="Place" badge={card.price} />
}

function ShopCard({ card }: { card: Card }) {
  return (
    <CardShell card={card} icon={ShoppingBag} kindLabel="Shop">
      {card.price && <p className="card-price">{card.price}</p>}
      <Snippet card={card} />
    </CardShell>
  )
}

function BookCard({ card }: { card: Card }) {
  return <CardShell card={card} icon={BookOpen} kindLabel="Book" badge={card.price} />
}

function InsightCard({ card }: { card: Card }) {
  return (
    <CardShell card={card} icon={Lightbulb} kindLabel="Insight">
      {card.snippet && (
        <blockquote className="card-quote">
          <p>{card.snippet}</p>
        </blockquote>
      )}
    </CardShell>
  )
}

function LinkCard({ card }: { card: Card }) {
  return <CardShell card={card} icon={Link2} kindLabel="Link" badge={card.price} />
}

function RelatedCard({ card }: { card: Card }) {
  return <CardShell card={card} icon={Sparkles} kindLabel="Related" badge={card.price} />
}

const VARIANTS: Record<Card['kind'], (props: { card: Card }) => JSX.Element> = {
  tickets: TicketsCard,
  calendar: CalendarCard,
  place: PlaceCard,
  shop: ShopCard,
  book: BookCard,
  insight: InsightCard,
  link: LinkCard,
  related: RelatedCard,
}

export function ActionCard(props: { card: Card }): JSX.Element {
  const Variant = VARIANTS[props.card.kind] ?? LinkCard
  return <Variant card={props.card} />
}
