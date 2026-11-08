import { useEffect, useState } from 'react'
import { MOCK, getHealth, getMode } from '../api/client'
import type { HealthResponse } from '../types'

export const HEALTH_POLL_MS = 10_000

export interface HealthState {
  /** Latest /api/health body; null until the first answer or while the backend is unreachable. */
  health: HealthResponse | null
  /** True when the backend replays fixtures (LATENT_MOCK=1) and never calls the local model. */
  backendMock: boolean
  /** True once a poll failed to reach the backend; cleared by the next successful poll. */
  unreachable: boolean
}

// With VITE_MOCK=1 there is no backend at all: report a healthy, mock-only state.
const FRONTEND_MOCK: HealthState = { health: null, backendMock: true, unreachable: false }
const INITIAL: HealthState = { health: null, backendMock: false, unreachable: false }

/** Poll GET /api/health (and /api/mode once) every 10 s so the banners track Ollama and the key. */
export function useHealth(pollMs: number = HEALTH_POLL_MS): HealthState {
  const [state, setState] = useState<HealthState>(MOCK ? FRONTEND_MOCK : INITIAL)

  useEffect(() => {
    if (MOCK) return
    let active = true
    let modeKnown = false

    const poll = async () => {
      try {
        // /api/mode is optional (an older backend lacks it): its failure must not read as "backend down".
        const [health, mode] = await Promise.all([getHealth(), modeKnown ? null : getMode().catch(() => null)])
        if (!active) return
        if (mode) modeKnown = true
        setState((prev) => ({ health, backendMock: mode ? mode.mock : prev.backendMock, unreachable: false }))
      } catch {
        if (active) setState((prev) => ({ ...prev, health: null, unreachable: true }))
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), pollMs)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [pollMs])

  return state
}

export interface Banner {
  id: 'backend' | 'ollama' | 'model' | 'tavily'
  level: 'error' | 'warning'
  text: string
}

/** The banners to show for a health state, most severe first. Pure, so it is unit-tested. */
export function healthBanners({ health, backendMock, unreachable }: HealthState): Banner[] {
  if (unreachable) {
    return [{ id: 'backend', level: 'error', text: 'Backend not reachable — start it with scripts/dev.sh' }]
  }
  if (!health) return []
  const banners: Banner[] = []
  // A mock backend replays fixtures and never calls the model or Tavily: no model/key banners.
  if (!backendMock) {
    if (health.ollama === 'down') {
      banners.push({ id: 'ollama', level: 'error', text: 'Local model not running — run scripts/setup.sh' })
    } else if (!health.model) {
      banners.push({ id: 'model', level: 'error', text: 'Vision model not pulled — run scripts/setup.sh' })
    }
    if (!health.tavily_key) {
      banners.push({ id: 'tavily', level: 'warning', text: 'Web search disabled — local cards only' })
    }
  }
  return banners
}

/** Why the drop zone is disabled, or null when a screenshot can be analyzed. */
export function dropDisabledReason(state: HealthState): string | null {
  const blocking = healthBanners(state).find((b) => b.level === 'error')
  return blocking ? blocking.text : null
}
