import type { Stage } from '../types'

/**
 * What the orb is doing:
 * - idle: slow breathing (no job yet)
 * - local: on-device work (ingest, scrub, query): steady green pulse
 * - extract: the local vision model is running: faster green pulse
 * - search: the only network stage: amber ripple
 * - gone: cards are arriving, the orb shrinks away
 * - error: dim red, still
 */
export type OrbMode = 'idle' | 'local' | 'extract' | 'search' | 'gone' | 'error'

export function orbMode(stage: Stage | undefined, hasCards: boolean): OrbMode {
  if (hasCards) return 'gone'
  switch (stage) {
    case 'extract':
      return 'extract'
    case 'search':
      return 'search'
    case 'ingest':
    case 'scrub':
    case 'query':
      return 'local'
    case 'cards':
    case 'done':
      return 'gone'
    case 'error':
      return 'error'
    default:
      return 'idle'
  }
}

/** Modes that need a frame every tick; the others render on demand only. */
export function isAnimatedMode(mode: OrbMode): boolean {
  return mode === 'local' || mode === 'extract' || mode === 'search'
}
