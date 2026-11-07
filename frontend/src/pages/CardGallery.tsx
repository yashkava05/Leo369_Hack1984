import concertFixture from '../api/fixtures/concert_flyer.result.json'
import sensitiveFixture from '../api/fixtures/sensitive_doc.result.json'
import { ActionCard } from '../components/cards/ActionCard'
import type { Card, JobResult } from '../types'
import { SAMPLE_CARDS } from './sampleCards'

const SECTIONS: { title: string; cards: Card[] }[] = [
  { title: 'Fixture: concert_flyer', cards: (concertFixture as JobResult).cards },
  { title: 'Fixture: sensitive_doc', cards: (sensitiveFixture as JobResult).cards },
  { title: 'Samples: kinds not in the fixtures yet', cards: SAMPLE_CARDS },
]

/** Dev page at /cards or ?gallery=1: every card from both fixtures, plus samples for the remaining kinds. */
export function CardGallery() {
  return (
    <main className="card-gallery">
      <h1>Action cards</h1>
      {SECTIONS.map((section) => (
        <section key={section.title} aria-label={section.title}>
          <h2>{section.title}</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'stretch' }}>
            {section.cards.map((card) => (
              <ActionCard key={card.id} card={card} />
            ))}
          </div>
        </section>
      ))}
    </main>
  )
}
