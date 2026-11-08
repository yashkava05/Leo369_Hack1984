// Decides whether the dashboard can run the WebGL scene or must show the plain card grid.

/** Below this container width the dashboard uses the grid. */
export const MIN_3D_WIDTH = 700

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export interface RenderEnvironment {
  webgl2: boolean
  reducedMotion: boolean
  /** Container width in CSS px; 0 when not measured yet. */
  width: number
}

export function shouldUseFallback({ webgl2, reducedMotion, width }: RenderEnvironment): boolean {
  return !webgl2 || reducedMotion || !(width >= MIN_3D_WIDTH)
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
