import {
  Component,
  lazy,
  Suspense,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { detectWebGL2, prefersReducedMotion, REDUCED_MOTION_QUERY, shouldUseFallback } from '../three/capabilities'
import type { Card, Stage } from '../types'
import './Dashboard.css'

// three.js and the scene load only when the WebGL path is actually used.
const Scene = lazy(() => import('../three/Scene'))

export interface DashboardProps {
  /** Current pipeline stage; drives the orb. */
  stage: Stage | undefined
  cards: Card[]
  renderCard: (card: Card) => ReactNode
}

const STAGE_TEXT: Partial<Record<Stage, string>> = {
  ingest: 'Reading the screenshot on this device…',
  extract: 'Extracting on this device…',
  scrub: 'Removing private details…',
  query: 'Building public search queries…',
  search: 'Searching the web…',
  cards: 'Building cards…',
  error: 'Something went wrong.',
}

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = globalThis.window?.matchMedia?.(REDUCED_MOTION_QUERY)
  query?.addEventListener('change', onChange)
  return () => query?.removeEventListener('change', onChange)
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, () => prefersReducedMotion(), () => false)
}

/** Container width in CSS px, measured before paint and kept up to date; 0 until measured. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

function FallbackGrid({ stage, cards, renderCard }: DashboardProps) {
  if (cards.length === 0) {
    const text = (stage && STAGE_TEXT[stage]) ?? 'Drop a screenshot to see action cards here.'
    return <p className="dashboard-empty">{text}</p>
  }
  return (
    <ul className="dashboard-grid">
      {cards.map((card, i) => (
        <li key={`${i}:${card.id}`} className="dashboard-grid-item" style={{ '--i': i } as CSSProperties}>
          {renderCard(card)}
        </li>
      ))}
    </ul>
  )
}

/** If the WebGL scene throws (e.g. context creation fails), show the grid instead. */
class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * Ambient results dashboard. With WebGL2, motion allowed and at least 700 px of width it
 * renders the 3D scene (stage-reactive orb, cards blooming onto an arc); otherwise a plain
 * CSS grid of `renderCard(card)` and the Canvas is never mounted.
 */
export function Dashboard({ stage, cards, renderCard }: DashboardProps) {
  const ref = useRef<HTMLElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const [webgl2] = useState(detectWebGL2)
  const reducedMotion = useReducedMotion()
  const width = useWidth(ref)
  // Start in the grid (before measurement) and apply width hysteresis so a container hovering
  // near 700 px doesn't flip modes and remount the scene on every resize. The last committed mode
  // is kept in state (React's "store previous value" pattern) and fed back for the hysteresis.
  const [prevFallback, setPrevFallback] = useState(true)
  const fallback = shouldUseFallback({ webgl2, reducedMotion, width }, prevFallback)
  if (fallback !== prevFallback) setPrevFallback(fallback)
  const grid = <FallbackGrid stage={stage} cards={cards} renderCard={renderCard} />

  return (
    <section
      ref={ref}
      className={fallback ? 'dashboard dashboard--grid' : 'dashboard dashboard--3d'}
      aria-label="Action cards"
      data-mode={fallback ? 'grid' : '3d'}
    >
      {fallback ? (
        grid
      ) : (
        <SceneBoundary fallback={grid}>
          <Suspense fallback={null}>
            <Scene stage={stage} cards={cards} renderCard={renderCard} container={ref} overlay={overlay} />
          </Suspense>
        </SceneBoundary>
      )}
      {/* The 3D cards' DOM goes here: a stable layer above the canvas, mounted before the scene. */}
      {!fallback && <div ref={overlay} className="dashboard-overlay" />}
    </section>
  )
}
