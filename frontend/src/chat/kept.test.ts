import { afterEach, expect, it, vi } from 'vitest'
import concert from '../api/fixtures/concert_flyer.result.json'
import { readKept, writeKept } from './kept'
import type { KeptItem } from './messages'

afterEach(() => vi.unstubAllGlobals())
it('saves only public card data and rehydrates it newest first after reload', () => {
  let saved = ''
  vi.stubGlobal('localStorage', { setItem: (_k: string, v: string) => { saved = v }, getItem: () => saved })
  const item = { label: 'Lumen Drift', intent_type: 'event', savedAt: 1, cards: concert.cards } as KeptItem
  writeKept([{ ...item, file: 'private pixels', url: 'blob:test' } as KeptItem, { ...item, savedAt: 2 }])
  expect(saved).not.toMatch(/private pixels|blob:test/)
  expect(readKept().map((v) => v.savedAt)).toEqual([2, 1])
})
it('ignores corrupt storage and malformed action cards', () => {
  vi.stubGlobal('localStorage', { getItem: () => '{bad json' })
  expect(readKept()).toEqual([])
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([{ label: 'Bad', intent_type: 'event', savedAt: 1, cards: [{ kind: 'calendar' }] }]) })
  expect(readKept()).toEqual([])
})
