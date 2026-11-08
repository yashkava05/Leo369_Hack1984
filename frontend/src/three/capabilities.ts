// Decides whether the dashboard can run the WebGL scene or must show the plain card grid.

/**
 * Nominal width threshold: the dashboard targets the 3D scene at/above this width and the grid
 * below it. A hysteresis band around it (ENTER_3D_WIDTH / LEAVE_3D_WIDTH) stops a container
 * hovering near the threshold from flipping grid<->3D on every resize and remounting the scene.
 */
export const MIN_3D_WIDTH = 700
/** From the grid, only switch to 3D once comfortably above the threshold. */
export const ENTER_3D_WIDTH = 720
/** From 3D, only drop back to the grid once comfortably below the threshold. */
export const LEAVE_3D_WIDTH = 680

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export interface RenderEnvironment {
  webgl2: boolean
  reducedMotion: boolean
  /** Container width in CSS px; 0 when not measured yet. */
  width: number
}

/**
 * Whether to show the fallback grid instead of the WebGL scene. No WebGL2 or reduced motion
 * always forces the grid. Width uses hysteresis: `previousFallback` is the current mode (start
 * in the grid until measured), so the scene is entered at >= ENTER_3D_WIDTH and left at
 * < LEAVE_3D_WIDTH; in between, the current mode is kept.
 */
export function shouldUseFallback(
  { webgl2, reducedMotion, width }: RenderEnvironment,
  previousFallback = true,
): boolean {
  if (!webgl2 || reducedMotion) return true
  if (previousFallback) return !(width >= ENTER_3D_WIDTH)
  return width < LEAVE_3D_WIDTH
}

type CanvasFactory = Pick<Document, 'createElement'>

/** True when a WebGL2 context can be created. Releases the probe context straight away. */
export function hasWebGL2(doc: CanvasFactory | undefined = globalThis.document): boolean {
  if (!doc) return false
  try {
    const gl = doc.createElement('canvas').getContext('webgl2')
    if (!gl) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

let webgl2Cache: boolean | undefined

/** hasWebGL2() for the real document, probed once per page. */
export function detectWebGL2(): boolean {
  webgl2Cache ??= hasWebGL2()
  return webgl2Cache
}

type MediaQueryHost = Pick<Window, 'matchMedia'>

export function prefersReducedMotion(win: MediaQueryHost | undefined = globalThis.window): boolean {
  try {
    return Boolean(win?.matchMedia?.(REDUCED_MOTION_QUERY).matches)
  } catch {
    return false
  }
}
