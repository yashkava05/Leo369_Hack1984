import { Html } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { Group, MeshStandardMaterial } from 'three'
import type { Card } from '../types'
import { CARD_DISTANCE_FACTOR, cardYaw } from './layout'

export const BLOOM_DURATION = 0.6 // s
export const BLOOM_STAGGER = 0.09 // s between consecutive cards

const PX_TO_WORLD = CARD_DISTANCE_FACTOR / 400
/** Keep the glowing plane just inside the DOM card so only its bloom halo shows around the edges. */
const PLANE_INSET = 0.08
const GLOW_BASE = 1.9
const GLOW_SPIKE = 6
const GLOW_COLOR = '#7f8cff'

const clamp01 = (t: number) => Math.min(1, Math.max(0, t))

/** Ease out with a small overshoot, so cards settle into place. */
function easeOutBack(t: number): number {
  const c1 = 1.2
  const c3 = c1 + 1
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
}

/** 0 → 1 quickly, then back to 0 by the end of the bloom. */
function glowSpike(t: number): number {
  const peak = 0.35
  return t < peak ? t / peak : (1 - (t - peak) / (1 - peak)) ** 2
}

interface CardPanelProps {
  card: Card
  index: number
  position: [number, number, number]
  renderCard: (card: Card) => ReactNode
  /** Element the card's DOM is mounted into; must exist before the panel mounts. */
  portal: RefObject<HTMLElement | null>
}

/**
 * One result card: an emissive plane (what the bloom pass makes glow) with the real DOM card
 * on top through drei <Html transform>, so its buttons stay ordinary, focusable DOM.
 * Blooms from the orb at the origin to `position` with a per-index stagger.
 */
export function CardPanel({ card, index, position, renderCard, portal }: CardPanelProps) {
  const invalidate = useThree((s) => s.invalidate)
  const group = useRef<Group>(null)
  const material = useRef<MeshStandardMaterial>(null)
  const start = useRef<number | null>(null)
  const [size, setSize] = useState<[number, number] | null>(null)
  const [x, y, z] = position
  const yaw = cardYaw(position)

  useEffect(() => {
    invalidate()
  }, [invalidate, size, x, y, z])

  // Size the glow plane from the DOM card's layout size (unaffected by CSS transforms).
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const update = () => {
      const { offsetWidth: w, offsetHeight: h } = el
      if (w > 0 && h > 0) setSize([w * PX_TO_WORLD, h * PX_TO_WORLD])
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useFrame((state) => {
    const g = group.current
    if (!g) return
    const now = state.clock.elapsedTime
    start.current ??= now
    const t = clamp01((now - start.current - index * BLOOM_STAGGER) / BLOOM_DURATION)
    const e = t === 1 ? 1 : easeOutBack(t)
    g.position.set(x * e, y * e, z * e)
    g.rotation.y = yaw * e
    g.scale.setScalar(Math.max(1e-3, e))
    if (material.current) material.current.emissiveIntensity = GLOW_BASE + GLOW_SPIKE * glowSpike(t)
    if (t < 1) state.invalidate()
  })

  return (
    <group ref={group} scale={1e-3}>
      <mesh
        position={[0, 0, -0.02]}
        visible={size !== null}
        scale={size ? [size[0] - PLANE_INSET, size[1] - PLANE_INSET, 1] : 1}
      >
        <planeGeometry args={[1, 1]} />
        <meshStandardMaterial
          ref={material}
          color="#000000"
          emissive={GLOW_COLOR}
          emissiveIntensity={GLOW_BASE}
          toneMapped={false}
        />
      </mesh>
      <Html
        transform
        distanceFactor={CARD_DISTANCE_FACTOR}
        zIndexRange={[40, 0]}
        className="dashboard-card-3d"
        portal={portal as RefObject<HTMLElement>}
      >
        <div ref={measure} className="dashboard-card-slot" data-card-id={card.id}>
          {renderCard(card)}
        </div>
      </Html>
    </group>
  )
}
