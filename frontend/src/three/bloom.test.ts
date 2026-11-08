import { describe, expect, it } from 'vitest'
import type { Card } from '../types'
import { nextGeneration, shouldBumpGeneration } from './bloom'

const card = (id: string): Card => ({
  id,
  kind: 'link',
  title: id,
  subtitle: null,
  url: null,
  price: null,
  source: 'example.com',
  snippet: null,
  score: 1,
  actions: [],
})

describe('shouldBumpGeneration', () => {
  it('bumps when cards go from empty to non-empty', () => {
    expect(shouldBumpGeneration([], [card('a')])).toBe(true)
    expect(shouldBumpGeneration(null, [card('a')])).toBe(true)
  })

  it('bumps when a new array arrives even with identical card ids (same fixture twice)', () => {
    const first = [card('a'), card('b')]
    const second = [card('a'), card('b')] // same ids, different array identity
    expect(shouldBumpGeneration(first, second)).toBe(true)
  })

  it('does not bump when the same array reference re-renders', () => {
    const same = [card('a')]
    expect(shouldBumpGeneration(same, same)).toBe(false)
  })

  it('does not bump when clearing to empty', () => {
    expect(shouldBumpGeneration([card('a')], [])).toBe(false)
    expect(shouldBumpGeneration(null, [])).toBe(false)
  })
})

describe('nextGeneration', () => {
  it('increments only when a bump is warranted', () => {
    const a = [card('a')]
    expect(nextGeneration(0, null, a)).toBe(1)
    expect(nextGeneration(1, a, a)).toBe(1) // same reference: no change
    expect(nextGeneration(1, a, [card('a')])).toBe(2) // new result, same id
    expect(nextGeneration(2, a, [])).toBe(2) // cleared: no change
  })
})
