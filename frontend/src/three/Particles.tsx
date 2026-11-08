import { PointMaterial, Points } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import type { Points as ThreePoints } from 'three'

const COUNT = 1500

/** Small deterministic PRNG (mulberry32) so the field is the same on every load. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeField(count: number): Float32Array {
  const random = mulberry32(1984)
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (random() - 0.5) * 36
    positions[i * 3 + 1] = (random() - 0.5) * 22
    positions[i * 3 + 2] = -random() * 24 + 2
  }
  return positions
}

/**
 * Slow, low-contrast dust field behind the cards. It only moves on frames that are rendered
 * anyway (it never requests frames itself), so it costs nothing while the scene is settled.
 */
export function Particles() {
  const positions = useMemo(() => makeField(COUNT), [])
  const ref = useRef<ThreePoints>(null)

  useFrame((_, delta) => {
    const points = ref.current
    if (!points) return
    const dt = Math.min(delta, 0.1)
    points.rotation.y += dt * 0.015
    points.rotation.x += dt * 0.004
  })

  return (
    <Points ref={ref} positions={positions} stride={3} frustumCulled={false}>
      <PointMaterial transparent color="#8a96c8" opacity={0.4} size={0.045} sizeAttenuation depthWrite={false} />
    </Points>
  )
}
