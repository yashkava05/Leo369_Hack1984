import type { Card } from '../types'

// Gallery-only samples for the card kinds the contract fixtures do not include yet (shop, book, related).
// They are not pipeline fixtures and are never used outside the /cards dev page.
export const SAMPLE_CARDS: Card[] = [
  {
    id: 'sample_shop',
    kind: 'shop',
    title: 'Lumen Drift — "Afterglow" vinyl LP',
    subtitle: 'Official artist store',
    url: 'https://shop.example.com/lumen-drift-afterglow-lp',
    price: '$32',
    source: 'shop.example.com',
    snippet: '180 g black vinyl with a printed inner sleeve. Ships in 3–5 business days.',
    score: 0.7,
    actions: [
      {
        label: 'View price',
        type: 'open_url',
        url: 'https://shop.example.com/lumen-drift-afterglow-lp',
        ics: null,
        text: null,
      },
    ],
  },
  {
    id: 'sample_book',
    kind: 'book',
    title: 'The Sound of Small Rooms',
    subtitle: 'by A. Example',
    url: 'https://books.example.org/sound-of-small-rooms',
    price: '$18',
    source: 'books.example.org',
    snippet: 'A history of club venues and the bands that came up through them, from the 1970s to today.',
    score: 0.64,
    actions: [
      {
        label: 'Get the book',
        type: 'open_url',
        url: 'https://books.example.org/sound-of-small-rooms',
        ics: null,
        text: null,
      },
    ],
  },
  {
    id: 'sample_related',
    kind: 'related',
    title: 'Other dream-pop shows in Boston this month',
    subtitle: null,
    url: 'https://news.example.net/boston-dream-pop-december',
    price: null,
    source: 'news.example.net',
    snippet: 'A roundup of similar small-venue shows around Boston in December.',
    score: 0.52,
    actions: [
      {
        label: 'Open',
        type: 'open_url',
        url: 'https://news.example.net/boston-dream-pop-december',
        ics: null,
        text: null,
      },
    ],
  },
]
