import { describe, expect, it } from 'vitest'
import { cardYaw, fitDistance, layoutCards, layoutExtent, MAX_CARDS, MIN_CAMERA_DISTANCE } from './layout'

describe('layoutCards', () => {
  it('returns [] for 0, negative and NaN counts', () => {
    expect(layoutCards(0)).toEqual([])
    expect(layoutCards(-3)).toEqual([])
    expect(layoutCards(Number.NEGATIVE_INFINITY)).toEqual([])
    expect(layoutCards(Number.NaN)).toEqual([])
  })

  it.each([1, 2, 3, 4, 5, 6])('returns exactly %i positions', (n) => {
    expect(layoutCards(n)).toHaveLength(n)
  })

  it('clamps to at most 6 cards', () => {
    expect(MAX_CARDS).toBe(6)
    expect(layoutCards(7)).toHaveLength(6)
    expect(layoutCards(50)).toHaveLength(6)
    expect(layoutCards(Number.POSITIVE_INFINITY)).toHaveLength(6)
  })

  it.each([1, 2, 3, 4, 5, 6])('gives %i distinct, finite positions', (n) => {
    const positions = layoutCards(n)
    for (const p of positions) for (const v of p) expect(Number.isFinite(v)).toBe(true)
    const keys = new Set(positions.map((p) => p.map((v) => v.toFixed(3)).join(',')))
    expect(keys.size).toBe(n)
    // Cards must not overlap: centres in the same row are at least a card width apart.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const [a, b] = [positions[i], positions[j]]
        if (Math.abs(a[1] - b[1]) < 1e-9) expect(Math.abs(a[0] - b[0])).toBeGreaterThan(3)
      }
    }
  })

  it.each([1, 2, 3, 4, 5, 6])('is symmetric about x = 0 for %i cards', (n) => {
    const positions = layoutCards(n)
    for (const [x, y, z] of positions) {
      const mirror = positions.find(([mx, my]) => Math.abs(mx + x) < 1e-9 && Math.abs(my - y) < 1e-9)
      expect(mirror, `mirror of ${x},${y}`).toBeDefined()
      expect(mirror![2]).toBeCloseTo(z, 9)
    }
  })

  it('puts a single card at the centre', () => {
    const [[x, y, z]] = layoutCards(1)
    expect(x).toBeCloseTo(0)
    expect(y).toBeCloseTo(0)
    expect(z).toBeCloseTo(0)
  })

  it('curves into a shallow arc: outer cards come forward, but only a little', () => {
    const [left, middle, right] = layoutCards(3)
    expect(middle[2]).toBeCloseTo(0)
    expect(left[2]).toBeGreaterThan(0)
    expect(left[2]).toBeCloseTo(right[2])
    expect(left[2]).toBeLessThan(1) // shallow
    expect(Math.abs(left[0])).toBeGreaterThan(Math.abs(left[2]) * 4)
  })

  it('uses one row up to 3 cards and two rows for 4 to 6', () => {
    const rows = (n: number) => new Set(layoutCards(n).map(([, y]) => y.toFixed(3))).size
    expect([1, 2, 3].map(rows)).toEqual([1, 1, 1])
    expect([4, 5, 6].map(rows)).toEqual([2, 2, 2])
  })

  it('keeps every card inside the reported extent', () => {
    for (let n = 1; n <= 6; n++) {
      const extent = layoutExtent(n)
      for (const [x, y, z] of layoutCards(n)) {
        expect(Math.abs(x)).toBeLessThan(extent.halfWidth)
        expect(Math.abs(y)).toBeLessThan(extent.halfHeight)
        expect(z).toBeLessThanOrEqual(extent.front + 1e-9)
      }
    }
  })
})

describe('cardYaw', () => {
  it('turns mirrored cards by opposite angles, the centre card not at all', () => {
    const [left, middle, right] = layoutCards(3)
    expect(cardYaw(middle)).toBeCloseTo(0)
    expect(cardYaw(left)).toBeCloseTo(-cardYaw(right))
    expect(cardYaw(left)).toBeGreaterThan(0) // left card turns to face right, towards the viewer
  })
})

describe('fitDistance', () => {
  it('moves the camera back on narrower viewports and never closer than the minimum', () => {
    const extent = layoutExtent(6)
    const wide = fitDistance(extent, 16 / 9, 45)
    const narrow = fitDistance(extent, 1.2, 45)
    expect(narrow).toBeGreaterThan(wide)
    expect(fitDistance(layoutExtent(0), 2, 45)).toBe(MIN_CAMERA_DISTANCE)
    expect(Number.isFinite(fitDistance(extent, 0, 45))).toBe(true)
  })
})
