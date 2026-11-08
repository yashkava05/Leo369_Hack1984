import { describe, expect, it } from 'vitest'
import { idleTickInterval, IDLE_FPS, IDLE_PAUSE_AFTER_S, shouldIdleTick } from './idle'

describe('idleTickInterval', () => {
  it('converts a frame rate to a ms interval and keeps the idle rate low (<= 10 fps)', () => {
    expect(idleTickInterval(10)).toBe(100)
    expect(IDLE_FPS).toBeLessThanOrEqual(10)
    expect(idleTickInterval()).toBeCloseTo(1000 / IDLE_FPS)
  })
})

describe('shouldIdleTick', () => {
  it('never ticks while the tab is hidden', () => {
    expect(shouldIdleTick(true, 0)).toBe(false)
    expect(shouldIdleTick(true, 3)).toBe(false)
  })

  it('ticks while visible within the idle window', () => {
    expect(shouldIdleTick(false, 0)).toBe(true)
    expect(shouldIdleTick(false, IDLE_PAUSE_AFTER_S - 0.1)).toBe(true)
  })

  it('pauses breathing after the idle timeout (~10 s with no stage change)', () => {
    expect(IDLE_PAUSE_AFTER_S).toBe(10)
    expect(shouldIdleTick(false, IDLE_PAUSE_AFTER_S)).toBe(false)
    expect(shouldIdleTick(false, 60)).toBe(false)
  })

  it('honours a custom pause threshold', () => {
    expect(shouldIdleTick(false, 1, 2)).toBe(true)
    expect(shouldIdleTick(false, 2, 2)).toBe(false)
  })
})
