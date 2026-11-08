import { Mic } from 'lucide-react'
import { useState } from 'react'
import { VoiceCapture } from './components/voice/VoiceCapture'
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
import { reserveVoiceSlot, useJob } from './state/useJob'
import { ChatApp } from './chat/ChatApp'
import { ForYouPage } from './components/feed/MuseFeed'
import { PrismDashboard } from './components/PrismDashboard'
import './App.css'

// The integrated dashboard remains available at ?view=classic.
function ClassicApp() {
  const health = useHealth()
  const job = useJob()
  const [voicePending, setVoicePending] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false)

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title"><img className="app-logo" src="/brand/icon-128.png" alt="" /><span>Prism<span>Local</span></span></h1>
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
          <DropZone disabledReason={voicePending ? 'Finish or cancel voice capture first.' : dropDisabledReason(health)} />
          <button type="button" className="voice-trigger" aria-label={voiceOpen ? 'Close voice input' : 'Speak a thought'} aria-expanded={voiceOpen} aria-controls="classic-voice-controls" title={voiceOpen ? 'Close voice input' : 'Speak a thought'} onClick={() => setVoiceOpen(!voiceOpen)}><Mic size={22} aria-hidden="true" /></button>
          <div id="classic-voice-controls" hidden={!voiceOpen}>
          {voiceOpen && <VoiceCapture disabled={job.status === 'uploading' || job.status === 'running'} onBusyChange={(busy) => { if (!reserveVoiceSlot(busy)) return false; setVoicePending(busy); return true }} onJob={(jobId) => { job.followVoice(jobId) }} autoStart onClose={() => setVoiceOpen(false)} />}
          </div>
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
                ? 'No action cards: saved locally or no public details to look up.'
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
  const view = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('view') : null
  if (view === 'classic') return <ClassicApp />
  if (view === 'chat') return <ChatApp />
  if (view === 'for-you' || view === 'feed') return <ForYouPage />
  return <PrismDashboard />
}
