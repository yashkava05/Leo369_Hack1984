import { AirGapToggle } from './components/AirGapToggle'
import { AuditDrawer } from './components/AuditDrawer'
import { ActionCard } from './components/cards/ActionCard'
import { Dashboard } from './components/Dashboard'
import { DropZone } from './components/DropZone'
import { HealthBanner } from './components/HealthBanner'
import { LeftDeviceSummary } from './components/LeftDeviceSummary'
import { LibraryDrawer } from './components/LibraryDrawer'
import { StageStrip } from './components/StageStrip'
import { Terminal } from './components/Terminal'
import { WatchPill } from './components/WatchPill'
import { dropDisabledReason, healthBanners, useHealth } from './state/useHealth'
import { useJob } from './state/useJob'
import { ChatApp } from './chat/ChatApp'
import './App.css'

// The integrated dashboard remains available at ?view=classic.
function ClassicApp() {
  const health = useHealth()
  const job = useJob()

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Latent</h1>
        <div className="app-header-tools">
          <AirGapToggle />
          <WatchPill />
          <AuditDrawer />
          <LibraryDrawer />
        </div>
      </header>
      <HealthBanner banners={healthBanners(health)} />
      <main className="app-main">
        <section className="app-left" aria-label="Input and live log">
          <DropZone disabledReason={dropDisabledReason(health)} />
          <StageStrip />
          <Terminal />
          <LeftDeviceSummary />
        </section>
        <section className="app-right" aria-label="Results">
          <Dashboard
            stage={job.currentStage}
            cards={job.result?.cards ?? []}
            renderCard={(card) => <ActionCard card={card} />}
          />
          {job.status === 'done' && job.result && job.result.cards.length === 0 && (
            <p className="app-results-note" role="status">
              {job.result.queries.length === 0
                ? 'No action cards: nothing public to look up in this screenshot.'
                : job.result.egress.length > 0 && job.result.egress.every((r) => r.blocked)
                  ? 'No action cards: every web search was blocked, so nothing left this device.'
                  : 'No action cards: the web search returned nothing usable.'}
            </p>
          )}
        </section>
      </main>
    </div>
  )
}

export default function App() {
  const classic = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('view') === 'classic'
  return classic ? <ClassicApp /> : <ChatApp />
}
