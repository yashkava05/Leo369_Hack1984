import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { FeedItem } from '../../api/feed'
import { FeedCard } from './FeedCard'

vi.mock('../../api/client', () => ({ API_URL: '', MOCK: true }))

const item: FeedItem = {
  id: 'feed-test',
  kind: 'discovery',
  title: 'A useful public discovery',
  teaser: 'A short editorial introduction.',
  hero: null,
  source_job_ids: ['job_fake'],
  why: 'It shares a public topic with a memory you saved.',
  created_at: 1794085200,
  provenance: 'web',
  actions: [],
  feedback: [],
}

describe('For You feed', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('mock feed must not call the network')
    }))
  })

  it('renders provenance, explanation, and accessible controls', () => {
    const html = renderToStaticMarkup(<FeedCard item={item} feedback={[]} onOpen={() => undefined} onFeedback={() => undefined} />)
    expect(html).toContain('From the web')
    expect(html).toContain('It shares a public topic with a memory you saved.')
    expect(html).toContain('Read more')
    expect(html).toContain('aria-pressed="false"')
  })

  it('uses story-matching mock screenshots instead of an unrelated book screenshot', () => {
    const coastal: FeedItem = {
      ...item,
      id: 'feed-connection-trip',
      kind: 'connection',
      title: 'Two saves, one coastal weekend',
      teaser: 'The Harbor Glass exhibition and Northline rail note share a public place.',
      why: 'Both scrubbed memories contain the public city Port Aurora.',
      provenance: 'local',
    }
    const html = renderToStaticMarkup(<FeedCard item={coastal} feedback={[]} onOpen={() => undefined} onFeedback={() => undefined} />)
    expect(html).toContain('/samples/harbor-glass.svg')
    expect(html).toContain('/samples/northline-rail.svg')
    expect(html).toContain('Harbor Glass')
    expect(html).toContain('Northline')
    expect(html).toContain('Port Aurora')
    expect(html).not.toContain('book_goodreads')
    expect(html).not.toContain('Project Hail Mary')
  })

  it('provides deterministic fixtures for every kind and session feedback', async () => {
    const { getFeed, getFeedDetail, sendFeedFeedback } = await import('../../api/feed')
    const response = await getFeed()
    expect(response.items.map((entry) => entry.kind)).toEqual(['discovery', 'connection', 'follow_up', 'pattern'])
    expect(response.next_cursor).toBeNull()
    expect(response.items.every((entry) => entry.hero === null)).toBe(true)

    const detail = await getFeedDetail('feed-discovery-nova')
    expect(detail.sources).toHaveLength(2)
    expect(detail.cards).toHaveLength(1)

    await sendFeedFeedback('feed-follow-up-calendar', 'save')
    await sendFeedFeedback('feed-follow-up-calendar', 'useful')
    const positive = (await getFeed()).items.find((entry) => entry.id === 'feed-follow-up-calendar')
    expect(positive?.feedback).toEqual(['save', 'useful'])

    await sendFeedFeedback('feed-discovery-nova', 'less_like_this')
    const afterSuppression = (await getFeed()).items
    expect(afterSuppression.some((entry) => entry.id === 'feed-discovery-nova')).toBe(false)
    expect(afterSuppression.some((entry) => entry.id === 'feed-connection-trip')).toBe(false)
    await sendFeedFeedback('feed-follow-up-calendar', 'dismiss')
    expect((await getFeed()).items.some((entry) => entry.id === 'feed-follow-up-calendar')).toBe(false)
    await sendFeedFeedback('feed-pattern-ceramics', 'not_useful')
    expect((await getFeed()).items.some((entry) => entry.id === 'feed-pattern-ceramics')).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
})
