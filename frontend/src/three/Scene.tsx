import { Canvas } from '@react-three/fiber'
import { Bloom, EffectComposer } from '@react-three/postprocessing'
import { useMemo, useState, type ReactNode, type RefObject } from 'react'
import type { Card, Stage } from '../types'
import { shouldBumpGeneration } from './bloom'
import { CameraRig } from './CameraRig'
import { CardPanel } from './CardPanel'
import { layoutCards, layoutExtent, MAX_CARDS, MIN_CAMERA_DISTANCE } from './layout'
import { Orb } from './Orb'
import { orbMode } from './orbMode'
import { Particles } from './Particles'

const FOV = 45
const BACKGROUND = '#06070c'

export interface SceneProps {
  stage: Stage | undefined
  cards: Card[]
  renderCard: (card: Card) => ReactNode
  container: RefObject<HTMLElement | null>
  /** Layer above the canvas that holds the cards' DOM. */
  overlay: RefObject<HTMLElement | null>
}

/**
 * The WebGL dashboard. Loaded lazily by Dashboard, and only when WebGL2 is available, motion
 * is allowed and the container is wide enough. Renders on demand: components call
 * invalidate() only while something is moving, so a settled scene draws no frames.
 * Everything is generated in code; nothing is fetched (no HDRs, textures or fonts).
 */
export default function Scene({ stage, cards, renderCard, container, overlay }: SceneProps) {
  const shown = cards.slice(0, MAX_CARDS)
  const count = shown.length
  const positions = useMemo(() => layoutCards(count), [count])
  const extent = useMemo(() => layoutExtent(count), [count])

  // Per-result bloom identity: bumps whenever a new (non-empty) cards array arrives, even if the
  // card ids repeat (mock fixture twice). Including it in the key remounts each CardPanel, so its
  // bloom start state resets and the cards bloom again. Tracked with React's "store previous
  // value" pattern so the generation survives re-renders.
  const [generation, setGeneration] = useState(0)
  const [prevCards, setPrevCards] = useState<Card[] | null>(null)
  if (shouldBumpGeneration(prevCards, cards)) {
    setPrevCards(cards)
    setGeneration((g) => g + 1)
  }

  return (
    <Canvas
      className="dashboard-canvas"
      dpr={[1, 2]}
      frameloop="demand"
      camera={{ position: [0, 0, MIN_CAMERA_DISTANCE], fov: FOV, near: 0.1, far: 80 }}
      gl={{ antialias: false, powerPreference: 'high-performance' }}
    >
      <color attach="background" args={[BACKGROUND]} />
      <Particles />
      <Orb mode={orbMode(stage, count > 0)} />
      {shown.map((card, i) => (
        <CardPanel
          key={`${generation}:${i}:${card.id}`}
          card={card}
          index={i}
          position={positions[i]}
          renderCard={renderCard}
          portal={overlay}
        />
      ))}
      <CameraRig container={container} extent={extent} />
      <EffectComposer multisampling={0} enableNormalPass={false}>
        <Bloom mipmapBlur luminanceThreshold={0.5} luminanceSmoothing={0.25} intensity={0.9} radius={0.7} />
      </EffectComposer>
    </Canvas>
  )
}
