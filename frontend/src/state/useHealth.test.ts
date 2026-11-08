import { describe, expect, it } from 'vitest'
import type { HealthResponse } from '../types'
import { dropDisabledReason, healthBanners, type HealthState } from './useHealth'

const healthy: HealthResponse = {
  status: 'ok',
  ollama: 'up',
  model: 'qwen2.5vl:3b',
  model_loaded: true,
  tavily_key: true,
}
const state = (health: Partial<HealthResponse> | null, extra: Partial<HealthState> = {}): HealthState => ({
  health: health ? { ...healthy, ...health } : null,
  backendMock: false,
  unreachable: false,
  ...extra,
})
const ids = (s: HealthState) => healthBanners(s).map((b) => b.id)

describe('healthBanners', () => {
  it('shows nothing when everything is up', () => {
    expect(healthBanners(state({}))).toEqual([])
    expect(dropDisabledReason(state({}))).toBeNull()
  })

  it('shows nothing before the first answer', () => {
    expect(healthBanners(state(null))).toEqual([])
  })

  it('tells the user to run setup when Ollama is down and disables the drop zone', () => {
    const s = state({ status: 'degraded', ollama: 'down', model: null, model_loaded: false })
    expect(healthBanners(s)[0].text).toBe('Local model not running — run scripts/setup.sh')
    expect(dropDisabledReason(s)).toBe('Local model not running — run scripts/setup.sh')
  })

  it('flags a model that is not pulled', () => {
    expect(ids(state({ status: 'degraded', model: null }))).toEqual(['model'])
  })

  it('warns without disabling the drop zone when the Tavily key is missing', () => {
    const s = state({ tavily_key: false })
    expect(healthBanners(s)).toEqual([
      { id: 'tavily', level: 'warning', text: 'Web search disabled — local cards only' },
    ])
    expect(dropDisabledReason(s)).toBeNull()
  })

  it('stacks the model and key banners, errors first', () => {
    expect(ids(state({ ollama: 'down', model: null, tavily_key: false }))).toEqual(['ollama', 'tavily'])
  })

  it('reports an unreachable backend', () => {
    expect(ids(state(null, { unreachable: true }))).toEqual(['backend'])
  })

  it('keeps the drop zone open for a mock backend even when Ollama is down', () => {
    const s = state({ ollama: 'down', model: null, tavily_key: false }, { backendMock: true })
    expect(healthBanners(s)).toEqual([])
    expect(dropDisabledReason(s)).toBeNull()
  })
})
