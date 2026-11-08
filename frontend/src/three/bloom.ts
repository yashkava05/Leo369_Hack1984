// Per-result bloom identity: pure decision so each new job's cards re-bloom even when the
// backend returns the same card ids (e.g. the mock fixture run twice), and so it is testable.

import type { Card } from '../types'

/**
 * Whether a new cards array should start a fresh bloom. True when cards go from empty to
 * non-empty, or when a non-empty cards array is replaced by a different array identity (a new
 * job). Re-renders with the same array reference, or clearing to empty, do not bump.
 */
export function shouldBumpGeneration(prevCards: Card[] | null, cards: Card[]): boolean {
  return cards.length > 0 && cards !== prevCards
}

/** Next generation given the previous one and whether the cards identity changed. */
export function nextGeneration(generation: number, prevCards: Card[] | null, cards: Card[]): number {
  return shouldBumpGeneration(prevCards, cards) ? generation + 1 : generation
}
