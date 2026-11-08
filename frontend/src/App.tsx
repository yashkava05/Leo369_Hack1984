import { useEffect, useState } from 'react'
import { API_URL, getHealth } from './api/client'
import { AirGapToggle } from './components/AirGapToggle'
import { AuditDrawer } from './components/AuditDrawer'
import { DropZone } from './components/DropZone'
import { LeftDeviceSummary } from './components/LeftDeviceSummary'
import { StageStrip } from './components/StageStrip'
import { Terminal } from './components/Terminal'
import type { HealthResponse } from './types'

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  return (
    <main>
      <h1>Latent</h1>
      <AirGapToggle />
      <AuditDrawer />
      <DropZone />
      <StageStrip />
      <LeftDeviceSummary />
      <Terminal />
      <p>
        Backend health from <code>{API_URL}/api/health</code>:
      </p>
      {error && <pre role="alert">Error: {error}</pre>}
      {!error && <pre data-testid="health">{health ? JSON.stringify(health, null, 2) : 'Loading…'}</pre>}
    </main>
  )
}

export default App
