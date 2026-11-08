import type { FeedHero, FeedItemKind } from '../../types'

export type PrintTheme = 'harbor' | 'rail' | 'festival' | 'studio' | 'lecture' | 'city' | 'paper'

export type PlacardFace =
  | { type: 'photo'; src: string; alt: string }
  | { type: 'print'; theme: PrintTheme; kicker: string; line: string; sub: string }

const PHOTO = {
  concert: { type: 'photo', src: '/samples/concert_ig.png', alt: 'Saved concert flyer for Tame Impala at TD Garden' } as const,
  book: { type: 'photo', src: '/samples/book_goodreads.png', alt: 'Saved book page for Project Hail Mary' } as const,
  product: { type: 'photo', src: '/samples/product_amazon.png', alt: 'Saved product page for Sony headphones' } as const,
  email: { type: 'photo', src: '/samples/doc_internal_email.png', alt: 'Saved work email screenshot' } as const,
  harbor: { type: 'photo', src: '/samples/harbor-glass.svg', alt: 'Saved screenshot: Harbor Glass exhibition in Port Aurora' } as const,
  northline: { type: 'photo', src: '/samples/northline-rail.svg', alt: 'Saved screenshot: Northline rail note for a coastal weekend' } as const,
  nova: { type: 'photo', src: '/samples/nova-fields.svg', alt: 'Saved screenshot: Nova Fields festival in Port Aurora' } as const,
  moonlit: { type: 'photo', src: '/samples/moonlit-sound.svg', alt: 'Saved screenshot: Moonlit Sound listing in Port Aurora' } as const,
  lumen: { type: 'photo', src: '/samples/lumen-archive.svg', alt: 'Saved screenshot: Lumen Archive talk on your calendar' } as const,
  ceramics: { type: 'photo', src: '/samples/ceramics-studio.svg', alt: 'Saved screenshot: independent ceramics at Ember Clay, Mora Studio, and Rill Forms' } as const,
}

function haystack(item: { id?: string; kind?: string; title: string; teaser?: string; why?: string }) {
  return [item.id, item.kind, item.title, item.teaser, item.why].filter(Boolean).join(' ').toLowerCase()
}

function has(text: string, keys: string[]) {
  return keys.some((key) => text.includes(key))
}

function print(theme: PrintTheme, kicker: string, line: string, sub: string): PlacardFace {
  return { type: 'print', theme, kicker, line, sub }
}

function localHero(hero: FeedHero | null): PlacardFace | null {
  const url = hero?.url
  if (!url || !url.startsWith('/') || url.startsWith('//')) return null
  return { type: 'photo', src: url, alt: hero?.alt || 'Saved screenshot' }
}

function namedShots(text: string): PlacardFace[] {
  const faces: PlacardFace[] = []
  if (has(text, ['harbor glass'])) faces.push(PHOTO.harbor)
  if (has(text, ['northline'])) faces.push(PHOTO.northline)
  if (has(text, ['nova fields'])) faces.push(PHOTO.nova)
  if (has(text, ['moonlit'])) faces.push(PHOTO.moonlit)
  if (has(text, ['lumen archive', 'lumen'])) faces.push(PHOTO.lumen)
  if (has(text, ['ember clay', 'mora studio', 'rill forms', 'ceramic'])) faces.push(PHOTO.ceramics)
  return faces
}

/** Choose header faces from the item's own copy so a book screenshot never sits on a coastal story. */
export function placardFaces(item: {
  id?: string
  kind: FeedItemKind
  title: string
  teaser?: string
  why?: string
  hero: FeedHero | null
}): PlacardFace[] {
  const fromHero = localHero(item.hero)
  if (fromHero) return [fromHero]

  const text = haystack(item)

  if (has(text, ['hail mary', 'andy weir', 'bookshelf', 'goodreads'])) return [PHOTO.book]
  if (has(text, ['tame impala', 'td garden', 'snapfeed'])) return [PHOTO.concert]
  if (has(text, ['sony', 'headphone', 'shopwise', 'wh-1000'])) return [PHOTO.product]
  if (has(text, ['internal email', 'work email', 'doc_internal'])) return [PHOTO.email]

  const named = namedShots(text)
  if (named.length) return named.slice(0, 2)

  if (has(text, ['festival', 'concert', 'live music', 'tickets'])) {
    return [print('festival', 'Live', item.title, item.teaser?.split('.')[0] ?? 'From a saved flyer')]
  }
  if (has(text, ['book', 'author', 'novel', 'read'])) return [PHOTO.book]
  if (has(text, ['product', 'headphones', 'shop', 'amazon'])) return [PHOTO.product]
  if (has(text, ['coast', 'harbor', 'port aurora', 'rail', 'weekend', 'exhibition', 'place'])) {
    return [PHOTO.harbor]
  }
  if (has(text, ['ceramic', 'clay', 'studio', 'pottery'])) return [PHOTO.ceramics]

  const theme: PrintTheme =
    item.kind === 'discovery' ? 'festival' : item.kind === 'follow_up' ? 'lecture' : item.kind === 'pattern' ? 'studio' : 'city'
  const kicker = item.kind === 'connection' ? 'Two saves' : item.kind.replace('_', ' ')
  return [print(theme, kicker, item.title, item.teaser?.split('.')[0] ?? '')]
}

/** @deprecated use placardFaces — kept for older imports */
export function placardStill(item: { kind: FeedItemKind; hero: FeedHero | null; title: string; teaser?: string; why?: string }) {
  const face = placardFaces(item)[0]
  if (face.type === 'photo') return { src: face.src, alt: face.alt }
  return { src: '', alt: `${face.line}. ${face.sub}` }
}
