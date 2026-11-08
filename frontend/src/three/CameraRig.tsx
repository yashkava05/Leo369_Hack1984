import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, type RefObject } from 'react'
import { MathUtils, type PerspectiveCamera } from 'three'
import { fitDistance, type Extent } from './layout'

/** Max camera offset from the pointer, in world units. */
const PARALLAX = 0.3
const DAMPING = 4
const EPS = 1e-3

interface CameraRigProps {
  /** Element whose pointer position drives the parallax (the dashboard container). */
  container: RefObject<HTMLElement | null>
  extent: Extent
}

/**
 * Frames the layout (moves back on narrow aspect ratios so all cards fit) and adds damped
 * mouse parallax. Requests frames only while the camera is still moving.
 */
export function CameraRig({ container, extent }: CameraRigProps) {
  const invalidate = useThree((s) => s.invalidate)
  const pointer = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const el = container.current
    if (!el) return
    const onMove = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      pointer.current.x = MathUtils.clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1)
      pointer.current.y = MathUtils.clamp(-(((event.clientY - rect.top) / rect.height) * 2 - 1), -1, 1)
      invalidate()
    }
    const onLeave = () => {
      pointer.current.x = 0
      pointer.current.y = 0
      invalidate()
    }
    el.addEventListener('pointermove', onMove, { passive: true })
    el.addEventListener('pointerleave', onLeave)
    return () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
    }
  }, [container, invalidate])

  useEffect(() => {
    invalidate()
  }, [extent, invalidate])

  useFrame((state, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1)
    const camera = state.camera as PerspectiveCamera
    const distance = fitDistance(extent, state.size.width / state.size.height, camera.fov)
    const tx = pointer.current.x * PARALLAX
    const ty = pointer.current.y * PARALLAX
    const p = camera.position
    p.set(
      MathUtils.damp(p.x, tx, DAMPING, delta),
      MathUtils.damp(p.y, ty, DAMPING, delta),
      MathUtils.damp(p.z, distance, DAMPING, delta),
    )
    camera.lookAt(0, 0, 0)
    const moving = Math.abs(p.x - tx) > EPS || Math.abs(p.y - ty) > EPS || Math.abs(p.z - distance) > EPS
    if (moving) state.invalidate()
  })

  return null
}
