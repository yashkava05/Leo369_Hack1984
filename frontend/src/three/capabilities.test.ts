import { describe, expect, it, vi } from 'vitest'
import { hasWebGL2, MIN_3D_WIDTH, prefersReducedMotion, REDUCED_MOTION_QUERY, shouldUseFallback } from './capabilities'
import { isAnimatedMode, orbMode } from './orbMode'

const OK = { webgl2: true, reducedMotion: false, width: 1200 }

describe('shouldUseFallback', () => {
  it('uses the 3D scene only with WebGL2, motion allowed and >= 700 px', () => {
    expect(shouldUseFallback(OK)).toBe(false)
    expect(shouldUseFallback({ ...OK, width: MIN_3D_WIDTH })).toBe(false)
  })

  it('falls back without WebGL2', () => {
    expect(shouldUseFallback({ ...OK, webgl2: false })).toBe(true)
  })

  it('falls back with prefers-reduced-motion', () => {
    expect(shouldUseFallback({ ...OK, reducedMotion: true })).toBe(true)
  })

  it('falls back below 700 px and before the container is measured', () => {
    expect(MIN_3D_WIDTH).toBe(700)
    expect(shouldUseFallback({ ...OK, width: 699 })).toBe(true)
    expect(shouldUseFallback({ ...OK, width: 0 })).toBe(true)
    expect(shouldUseFallback({ ...OK, width: Number.NaN })).toBe(true)
  })
})

function fakeDocument(getContext: () => unknown) {
  return { createElement: () => ({ getContext }) } as unknown as Document
}

describe('hasWebGL2', () => {
  it('is false when there is no document (e.g. tests, SSR)', () => {
    expect(hasWebGL2(undefined)).toBe(false)
  })

  it('is false when the browser returns no webgl2 context', () => {
    expect(hasWebGL2(fakeDocument(() => null))).toBe(false)
  })

  it('is false when context creation throws', () => {
    expect(
      hasWebGL2(
        fakeDocument(() => {
          throw new Error('blocked')
        }),
      ),
    ).toBe(false)
  })

  it('is true with a context, and releases the probe context', () => {
    const loseContext = vi.fn()
    const getContext = vi.fn(() => ({ getExtension: () => ({ loseContext }) }))
    expect(hasWebGL2(fakeDocument(getContext))).toBe(true)
    expect(getContext).toHaveBeenCalledWith('webgl2')
    expect(loseContext).toHaveBeenCalled()
  })
})

describe('prefersReducedMotion', () => {
  it('reads the reduced-motion media query', () => {
    const matchMedia = vi.fn((q: string) => ({ matches: q === REDUCED_MOTION_QUERY }) as MediaQueryList)
    expect(prefersReducedMotion({ matchMedia })).toBe(true)
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    expect(prefersReducedMotion({ matchMedia: () => ({ matches: false }) as MediaQueryList })).toBe(false)
  })

  it('is false without window or matchMedia', () => {
    expect(prefersReducedMotion(undefined)).toBe(false)
    expect(prefersReducedMotion({} as Window)).toBe(false)
  })
})

describe('orbMode', () => {
  it('maps pipeline stages to orb behaviour', () => {
    expect(orbMode(undefined, false)).toBe('idle')
    expect(orbMode('ingest', false)).toBe('local')
    expect(orbMode('extract', false)).toBe('extract')
    expect(orbMode('scrub', false)).toBe('local')
    expect(orbMode('query', false)).toBe('local')
    expect(orbMode('search', false)).toBe('search')
    expect(orbMode('cards', false)).toBe('gone')
    expect(orbMode('done', false)).toBe('gone')
    expect(orbMode('error', false)).toBe('error')
  })

  it('shrinks away whenever cards are present', () => {
    expect(orbMode('search', true)).toBe('gone')
    expect(orbMode(undefined, true)).toBe('gone')
  })

  it('animates continuously only during active stages', () => {
    expect(['idle', 'local', 'extract', 'search', 'gone', 'error'].filter((m) => isAnimatedMode(m as never))).toEqual([
      'local',
      'extract',
      'search',
    ])
  })
})
