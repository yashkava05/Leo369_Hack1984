import { useEffect, useState } from 'react'
import { API_URL, getHealth } from './api/client'
import { ActionCard } from './components/cards/ActionCard'
import { Dashboard } from './components/Dashboard'
import { DropZone } from './components/DropZone'
import { StageStrip } from './components/StageStrip'
import { Terminal } from './components/Terminal'
import type { HealthResponse } from './types'
import { useJob } from './state/useJob'

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const job = useJob()

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  return (
    <main>
      <h1>Latent</h1>
      <DropZone />
      <StageStrip />
      <Terminal />
      <p>
        Backend health from <code>{API_URL}/api/health</code>:
      </p>
      {error && <pre role="alert">Error: {error}</pre>}
      {!error && <pre data-testid="health">{health ? JSON.stringify(health, null, 2) : 'Loading…'}</pre>}
      <Dashboard
        stage={job.currentStage}
        cards={job.result?.cards ?? []}
        renderCard={(card) => <ActionCard card={card} />}
      />
    </main>
  )
}

export default App
