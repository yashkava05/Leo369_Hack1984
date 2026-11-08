import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { Color, MathUtils, type Group, type Mesh, type MeshStandardMaterial } from 'three'
import { idleTickInterval, shouldIdleTick } from './idle'
import { isAnimatedMode, type OrbMode } from './orbMode'

interface ModeStyle {
  color: string
  /** Pulse angular speed, rad/s. */
  speed: number
  /** Pulse amplitude as a fraction of the radius. */
  amplitude: number
  /** Emissive intensity; above ~1 the bloom pass picks it up. */
  intensity: number
}

const STYLES: Record<OrbMode, ModeStyle> = {
  idle: { color: '#6f7dff', speed: (2 * Math.PI) / 4.5, amplitude: 0.035, intensity: 1.8 },
  local: { color: '#2ee88a', speed: (2 * Math.PI) / 1.6, amplitude: 0.05, intensity: 2 },
  extract: { color: '#2ee88a', speed: (2 * Math.PI) / 0.7, amplitude: 0.08, intensity: 2.4 },
  search: { color: '#ffb020', speed: (2 * Math.PI) / 1.2, amplitude: 0.04, intensity: 2.4 },
  gone: { color: '#6f7dff', speed: 0, amplitude: 0, intensity: 0 },
  error: { color: '#ff4d5e', speed: 0, amplitude: 0, intensity: 1.2 },
}

const RADIUS = 0.9
const RING_COUNT = 2
const RING_PERIOD = 1.4 // s for one ripple to travel outwards
const RING_REACH = 1.7 // extra radii a ripple travels
const EPS = 1e-3

export function Orb({ mode }: { mode: OrbMode }) {
  const invalidate = useThree((s) => s.invalidate)
  const sphere = useRef<Mesh>(null)
  const sphereMaterial = useRef<MeshStandardMaterial>(null)
  const rings = useRef<Group>(null)
  const ringMaterials = useRef<(MeshStandardMaterial | null)[]>([])
  const phase = useRef(0)
  const presence = useRef(mode === 'gone' ? 0 : 1)
  const ripple = useRef(0)
  const targetColor = useMemo(() => new Color(), [])
  const style = STYLES[mode]

  // New stage: render at least one frame so the change starts.
  useEffect(() => {
    invalidate()
  }, [mode, invalidate])

  // Idle breathing is the only motion with nothing happening, so keep its cost near zero: tick
  // at a low rate, never while the tab is hidden, and pause entirely after ~10 s (one final frame
  // to settle). A pointer move or becoming visible again restarts the breathing window.
  useEffect(() => {
    if (mode !== 'idle') return
    const doc = globalThis.document
    let start = performance.now()
    let settled = false
    const restart = () => {
      start = performance.now()
      settled = false
      invalidate()
    }
    const tick = () => {
      const hidden = Boolean(doc?.hidden)
      const elapsed = (performance.now() - start) / 1000
      if (shouldIdleTick(hidden, elapsed)) {
        invalidate()
      } else if (!settled && !hidden) {
        settled = true // idle timed out: draw one last frame so breathing settles at rest
        invalidate()
      }
    }
    const id = window.setInterval(tick, idleTickInterval())
    doc?.addEventListener('visibilitychange', restart)
    window.addEventListener('pointermove', restart, { passive: true })
    return () => {
      window.clearInterval(id)
      doc?.removeEventListener('visibilitychange', restart)
      window.removeEventListener('pointermove', restart)
    }
  }, [mode, invalidate])

  useFrame((state, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1)
    const mesh = sphere.current
    const material = sphereMaterial.current
    if (!mesh || !material) return

    phase.current += delta * style.speed
    presence.current = MathUtils.damp(presence.current, mode === 'gone' ? 0 : 1, 6, delta)
    ripple.current = MathUtils.damp(ripple.current, mode === 'search' ? 1 : 0, 5, delta)

    const pulse = Math.sin(phase.current)
    mesh.scale.setScalar(Math.max(EPS, presence.current * (1 + style.amplitude * pulse)))
    mesh.visible = presence.current > EPS

    targetColor.set(style.color)
    const colorStep = 1 - Math.exp(-5 * delta)
    material.emissive.lerp(targetColor, colorStep)
    const intensity = style.intensity * (1 + 2 * style.amplitude * pulse)
    material.emissiveIntensity = MathUtils.damp(material.emissiveIntensity, intensity, 8, delta)

    const ringGroup = rings.current
    if (ringGroup) {
      ringGroup.visible = ripple.current > EPS && presence.current > EPS
      const cycle = (state.clock.elapsedTime / RING_PERIOD) % 1
      ringGroup.children.forEach((ring, i) => {
        const r = (cycle + i / RING_COUNT) % 1
        ring.scale.setScalar(1 + r * RING_REACH)
        const ringMaterial = ringMaterials.current[i]
        if (ringMaterial) {
          ringMaterial.opacity = (1 - r) * ripple.current
          ringMaterial.emissiveIntensity = 3 * (1 - r)
        }
      })
    }

    const settling =
      Math.abs(presence.current - (mode === 'gone' ? 0 : 1)) > EPS ||
      Math.abs(ripple.current - (mode === 'search' ? 1 : 0)) > EPS ||
      Math.abs(material.emissive.r - targetColor.r) +
        Math.abs(material.emissive.g - targetColor.g) +
        Math.abs(material.emissive.b - targetColor.b) >
        EPS
    if (isAnimatedMode(mode) || settling) state.invalidate()
  })

  return (
    <group>
      <mesh ref={sphere}>
        <sphereGeometry args={[RADIUS, 48, 32]} />
        <meshStandardMaterial
          ref={sphereMaterial}
          color="#000000"
          emissive={STYLES.idle.color}
          emissiveIntensity={STYLES.idle.intensity}
          toneMapped={false}
        />
      </mesh>
      <group ref={rings} visible={false}>
        {Array.from({ length: RING_COUNT }, (_, i) => (
          <mesh key={i}>
            <torusGeometry args={[RADIUS * 1.02, 0.018, 8, 96]} />
            <meshStandardMaterial
              ref={(m) => {
                ringMaterials.current[i] = m
              }}
              color="#000000"
              emissive={STYLES.search.color}
              emissiveIntensity={3}
              transparent
              opacity={0}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>
    </group>
  )
}
