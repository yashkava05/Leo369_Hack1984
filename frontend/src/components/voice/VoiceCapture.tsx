import { useEffect, useRef, useState } from 'react'
import { MOCK } from '../../api/client'
import { getLibraryItem, listLibrary } from '../../api/library'
import type { LibraryItem } from '../../api/library'
import { MOCK_VOICE_CONTEXT_ID, mockVoiceIntent } from '../../api/voice'
import type { VoiceAction, VoiceScenario } from '../../api/voice'
import { useVoice, type VoiceBusyChange } from '../../state/useVoice'
import { TranscriptReview } from './TranscriptReview'
import './voice.css'

export interface VoiceCaptureProps { onJob: (jobId: string, action: VoiceAction) => void; disabled?: boolean; onBusyChange?: VoiceBusyChange }
export function VoiceCapture({ onJob, disabled = false, onBusyChange }: VoiceCaptureProps) {
  const voice = useVoice(onJob, onBusyChange)
  const [items, setItems] = useState<LibraryItem[]>([])
  const [context, setContext] = useState<{ id: string; summary: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const selection = useRef(0)
  useEffect(() => () => { selection.current++ }, [])
  const busy = ['requesting', 'recording', 'transcribing', 'submitting'].includes(voice.phase)
  const load = async () => {
    const gen = ++selection.current
    setLoading(true); setLibraryError(null); setContext(null)
    try {
      let found = await listLibrary()
      if (MOCK && !found.length) found = [{ id: MOCK_VOICE_CONTEXT_ID, created_at: 0, intent_type: 'event', summary: `Demo context (local only): ${mockVoiceIntent.summary}`, card_count: 0 }]
      if (gen === selection.current) { setItems(found); if (!found.length) setLibraryError('No saved items yet. Save an interest locally first.') }
    } catch { if (gen === selection.current) setLibraryError('Could not load the local library. Try again.') }
    finally { if (gen === selection.current) setLoading(false) }
  }
  const select = async (id: string) => {
    const gen = ++selection.current
    setContext(null); setLibraryError(null); setLoading(false)
    if (!id || !items.some((item) => item.id === id)) return
    setLoading(true)
    try {
      const intent = MOCK && id === MOCK_VOICE_CONTEXT_ID ? mockVoiceIntent : (await getLibraryItem(id)).intent
      if (gen === selection.current) {
        if (!intent || !intent.public_entities.length) setLibraryError('This item has no public details for a related search.')
        else setContext({ id, summary: `${id === MOCK_VOICE_CONTEXT_ID ? 'Demo context (local only): ' : ''}${intent.summary}` })
      }
    } catch { if (gen === selection.current) setLibraryError('That saved item is unavailable. Choose another item.') }
    finally { if (gen === selection.current) setLoading(false) }
  }
  const clearContext = () => { selection.current++; setContext(null); setLoading(false) }
  const cancel = () => { voice.cancel(); clearContext() }
  return <section className="voice-capture" aria-label="Voice or typed thought">
    <div className="voice-heading"><strong>Speak a thought</strong><span className="voice-provenance">LOCAL</span></div>
    <p className="voice-note">Up to 30 seconds · English · no audio saved. Explore and Find related may use <span className="voice-provenance">WEB</span> after review.</p>
    {MOCK && <label className="voice-demo">Demo scenario
      <select aria-label="Voice demo scenario" value={voice.scenario} disabled={busy || disabled} onChange={(event) => { clearContext(); voice.setScenario(event.target.value as VoiceScenario) }}>
        <option value="event">Event discovery</option><option value="save">Save only</option><option value="related">Related to a saved item</option><option value="silence">Silence</option><option value="permission-denied">Permission denied</option>
      </select><span>No microphone, model, or network used.</span>
    </label>}
    <div className="voice-record-controls">
      <button type="button" disabled={disabled || busy} onClick={() => { void voice.start() }}>{MOCK ? 'Simulate recording' : 'Record thought'}</button>
      {voice.phase === 'recording' && <button type="button" onClick={voice.stop}>Stop · {voice.elapsed}s / 30s</button>}
      {busy && <button type="button" onClick={cancel}>Cancel</button>}
    </div>
    <p role="status" aria-live="polite">{voice.phase === 'requesting' ? 'Waiting for microphone permission…' : voice.phase === 'recording' ? 'Recording on this device…' : voice.phase === 'transcribing' ? 'Transcribing on this device…' : voice.phase === 'submitting' ? 'Starting local interpretation…' : voice.phase === 'review' ? 'Review your text, then choose an action.' : ''}</p>
    {voice.error && <p role="alert" className="voice-error">{voice.error}</p>}
    <TranscriptReview text={voice.text} busy={busy} disabled={disabled} items={items} context={context} loading={loading} libraryError={libraryError}
      onText={voice.setText} onLoad={() => { void load() }} onSelect={(id) => { void select(id) }} onRemove={clearContext}
      onAction={(action) => { void voice.submit(action, action === 'related' ? context?.id ?? null : null) }} onRetry={() => { clearContext(); void voice.start() }} onCancel={cancel} />
  </section>
}
export default VoiceCapture
