import { describe, expect, it } from 'vitest'
import { placardFaces } from './stills'

describe('placardFaces', () => {
  it('pairs Harbor Glass with a rail ticket, not a book screenshot', () => {
    const faces = placardFaces({
      id: 'feed-connection-trip',
      kind: 'connection',
      title: 'Two saves, one coastal weekend',
      teaser: 'The Harbor Glass exhibition and Northline rail note share a public place.',
      why: 'Both scrubbed memories contain the public city Port Aurora.',
      hero: null,
    })
    expect(faces).toEqual([
      { type: 'photo', src: '/samples/harbor-glass.svg', alt: 'Saved screenshot: Harbor Glass exhibition in Port Aurora' },
      { type: 'photo', src: '/samples/northline-rail.svg', alt: 'Saved screenshot: Northline rail note for a coastal weekend' },
    ])
  })

  it('uses the Hail Mary screenshot only when the copy is about that book', () => {
    const faces = placardFaces({
      kind: 'discovery',
      title: 'You might like Project Hail Mary',
      teaser: 'Andy Weir is still on your bookshelf.',
      why: 'A saved Goodreads page.',
      hero: null,
    })
    expect(faces).toEqual([{ type: 'photo', src: '/samples/book_goodreads.png', alt: 'Saved book page for Project Hail Mary' }])
  })
})
