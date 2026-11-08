// Card layout for the WebGL dashboard: pure math, no three.js import, so it is cheap to test.

/** The scene shows at most this many cards. */
export const MAX_CARDS = 6

/** World-space width of one card panel. */
export const CARD_WIDTH = 3.2
/** Width of the DOM card in CSS px (ActionCard is 300 px wide). */
export const CARD_CSS_WIDTH = 300
/** drei <Html transform> maps 1 CSS px to distanceFactor / 400 world units. */
export const CARD_DISTANCE_FACTOR = (CARD_WIDTH / CARD_CSS_WIDTH) * 400
/** Rough world-space height of a card, used only to frame the camera before cards are measured. */
export const CARD_HEIGHT_ESTIMATE = 2.9

const CARD_GAP = 0.4
/** Radius of the arc the cards sit on; large = shallow. Its centre is in front of the cards, near the camera. */
export const ARC_RADIUS = 12
/** Half the distance between the two rows when there are more than three cards. */
const ROW_OFFSET_Y = 1.75
const MAX_PER_ROW = 3

function clampCount(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.min(MAX_CARDS, Math.max(0, Math.floor(n)))
}

/**
 * Positions for n cards on a shallow arc, centred on the origin (where the orb sits).
 * Up to three cards share one arc; four to six are split over two stacked arcs so the
 * DOM cards stay close to their natural size. Edge cards curve towards the viewer.
 */
export function layoutCards(n: number): [number, number, number][] {
  const count = clampCount(n)
  if (count === 0) return []
  const rows = count <= MAX_PER_ROW ? [count] : [Math.ceil(count / 2), Math.floor(count / 2)]
  const positions: [number, number, number][] = []
  rows.forEach((inRow, row) => {
    const y = rows.length === 1 ? 0 : row === 0 ? ROW_OFFSET_Y : -ROW_OFFSET_Y
    for (let i = 0; i < inRow; i++) {
      const arcLength = (i - (inRow - 1) / 2) * (CARD_WIDTH + CARD_GAP)
      const theta = arcLength / ARC_RADIUS
      positions.push([ARC_RADIUS * Math.sin(theta), y, ARC_RADIUS * (1 - Math.cos(theta))])
    }
  })
  return positions
}

/** Yaw (rotation about Y) that turns a card at `position` to face the arc's centre. */
export function cardYaw([x, , z]: [number, number, number]): number {
  return Math.atan2(-x, ARC_RADIUS - z)
}

export interface Extent {
  halfWidth: number
  halfHeight: number
  /** Largest z of any card (edge cards come towards the camera). */
  front: number
}

/** Bounding half-extent of the layout for n cards; with no cards, the orb and its ripple. */
export function layoutExtent(n: number): Extent {
  const positions = layoutCards(n)
  if (positions.length === 0) return { halfWidth: 2.6, halfHeight: 2.6, front: 0 }
  let halfWidth = 0
  let halfHeight = 0
  let front = 0
  for (const [x, y, z] of positions) {
    halfWidth = Math.max(halfWidth, Math.abs(x) + CARD_WIDTH / 2)
    halfHeight = Math.max(halfHeight, Math.abs(y) + CARD_HEIGHT_ESTIMATE / 2)
    front = Math.max(front, z)
  }
  return { halfWidth, halfHeight, front }
}

export const MIN_CAMERA_DISTANCE = 8.5
const MAX_CAMERA_DISTANCE = 22
const FRAME_MARGIN = 1.15

/** Camera distance on +z that fits `extent` in a viewport of `aspect` with a vertical `fovDeg`. */
export function fitDistance(extent: Extent, aspect: number, fovDeg: number): number {
  const tanHalf = Math.tan((fovDeg * Math.PI) / 360)
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1
  const needed =
    Math.max(extent.halfHeight / tanHalf, extent.halfWidth / (tanHalf * safeAspect)) * FRAME_MARGIN + extent.front
  return Math.min(MAX_CAMERA_DISTANCE, Math.max(MIN_CAMERA_DISTANCE, needed))
}
