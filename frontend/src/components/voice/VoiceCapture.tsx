import { useCallback, useEffect, useRef, useState } from 'react'
import { Keyboard, LockKeyhole, Mic, Square, X } from 'lucide-react'
import { MOCK } from '../../api/client'
import { getLibraryItem, listLibrary } from '../../api/library'
import type { LibraryItem } from '../../api/library'
import { MOCK_VOICE_CONTEXT_ID, mockVoiceIntent } from '../../api/voice'
import type { VoiceAction, VoiceScenario } from '../../api/voice'
import { useVoice, type VoiceBusyChange } from '../../state/useVoice'
import { TranscriptReview } from './TranscriptReview'
import './voice.css'

export interface VoiceCaptureProps {
  onJob: (jobId: string, action: VoiceAction) => void
  disabled?: boolean
  onBusyChange?: VoiceBusyChange
  /** Start listening as soon as the panel opens (the mic tap that opened it is the explicit click). */
  autoStart?: boolean
  /** Called when the user discards, or after an action has been handed to the pipeline. */
  onClose?: () => void
  /** Optional (#67): open the read-only Outlook agent with the reviewed text. */
  onOutlook?: (text: string) => void
  /** Optional (#68): open the read-only Teams agent with the reviewed text. */
  onTeams?: (text: string) => void
}

const LIMIT_S = 30
const clock = (s: number) => `0:${String(s).padStart(2, '0')}`

export function VoiceCapture({ onJob, disabled = false, onBusyChange, autoStart = false, onClose, onOutlook, onTeams }: VoiceCaptureProps) {
  const voice = useVoice(onJob, onBusyChange)
  const [items, setItems] = useState<LibraryItem[]>([])
  const [context, setContext] = useState<{ id: string; summary: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const selection = useRef(0)
  const startOnOpen = useRef({ autoStart, disabled })
  useEffect(() => () => { selection.current++ }, [])
  // Once per mount: the mic tap that opened the panel starts listening. Runs again after a
  // StrictMode remount (whose cleanup disposed the controller), but never on later prop changes.
  // `voice` is a fresh object every render; `voice.start` is the controller's stable method.
  const start = voice.start
  useEffect(() => {
    if (startOnOpen.current.autoStart && !startOnOpen.current.disabled) void start()
  }, [start])

  const busy = ['requesting', 'recording', 'transcribing', 'submitting'].includes(voice.phase)
  const reviewing = voice.phase === 'review' || (voice.phase === 'error' && !!voice.text) || voice.phase === 'submitting'

  const load = async () => {
    const gen = ++selection.current
    setLoading(true); setLibraryError(null); setContext(null)
    try {
      let found = await listLibrary()
      if (MOCK && !found.length) found = [{ id: MOCK_VOICE_CONTEXT_ID, created_at: 0, intent_type: 'event', summary: `Demo: ${mockVoiceIntent.summary}`, card_count: 0 }]
      if (gen === selection.current) { setItems(found); if (!found.length) setLibraryError('Nothing saved yet — use “Save for later” first.') }
    } catch { if (gen === selection.current) setLibraryError('Could not open your saved items. Try again.') }
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
        if (!intent || !intent.public_entities.length) setLibraryError('That item has nothing public to search with.')
        else setContext({ id, summary: intent.summary })
      }
    } catch { if (gen === selection.current) setLibraryError('That saved item is unavailable. Choose another.') }
    finally { if (gen === selection.current) setLoading(false) }
  }
  const clearContext = useCallback(() => { selection.current++; setContext(null); setLoading(false) }, [])
  const cancel = voice.cancel
  const discard = useCallback(() => { cancel(); clearContext(); onClose?.() }, [cancel, clearContext, onClose])
  const record = () => { clearContext(); void voice.start() }
  const act = async (action: VoiceAction) => {
    await voice.submit(action, action === 'related' ? context?.id ?? null : null)
    const after = voice.getSnapshot()
    if (after.phase === 'idle' && !after.error) { clearContext(); onClose?.() }
  }
  // setText moves the controller into review, which is the typed-input path (same text-to-intent route).
  const typeInstead = () => { voice.setText(voice.text) }
  useEffect(() => {
    // Opening the panel leaves focus on its trigger, outside the section.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      discard()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [discard])

  return <section className={`voice-capture is-${voice.phase}`} aria-label="Speak a thought">
    {voice.phase === 'idle' && !voice.error && <div className="voice-bar">
      <button type="button" className="voice-mic" disabled={disabled} onClick={record} aria-label="Start speaking"><Mic size={20} aria-hidden="true" /></button>
      <div className="voice-bar-text"><strong>Tap to speak</strong><span>Up to {LIMIT_S} seconds, in English</span></div>
      <button type="button" className="voice-link" disabled={disabled} onClick={typeInstead}><Keyboard size={14} aria-hidden="true" />Type instead</button>
      <button type="button" className="voice-icon" onClick={discard} aria-label="Close voice input"><X size={16} aria-hidden="true" /></button>
    </div>}

    {voice.phase === 'requesting' && <div className="voice-bar">
      <span className="voice-dot is-waiting" aria-hidden="true" />
      <div className="voice-bar-text"><strong>Allow microphone access</strong><span>Your browser will ask once.</span></div>
      <button type="button" className="voice-icon" onClick={discard} aria-label="Cancel"><X size={16} aria-hidden="true" /></button>
    </div>}

    {voice.phase === 'recording' && <div className="voice-bar">
      <span className="voice-dot" aria-hidden="true" />
      <div className="voice-bar-text">
        <strong>Listening… <span className="voice-time">{clock(voice.elapsed)}</span></strong>
        <span className="voice-progress" aria-hidden="true"><i style={{ width: `${(voice.elapsed / LIMIT_S) * 100}%` }} /></span>
      </div>
      <button type="button" className="voice-icon" onClick={discard} aria-label="Cancel recording"><X size={16} aria-hidden="true" /></button>
      <button type="button" className="voice-primary" onClick={voice.stop}><Square size={13} aria-hidden="true" fill="currentColor" />Done</button>
    </div>}

    {voice.phase === 'transcribing' && <div className="voice-bar">
      <span className="voice-spinner" aria-hidden="true" />
      <div className="voice-bar-text"><strong>Writing down what you said…</strong><span>On this device</span></div>
      <button type="button" className="voice-icon" onClick={discard} aria-label="Cancel"><X size={16} aria-hidden="true" /></button>
    </div>}

    {voice.phase === 'error' && !voice.text && <div className="voice-bar is-error">
      <div className="voice-bar-text"><strong role="alert">{voice.error}</strong></div>
      <button type="button" className="voice-secondary" disabled={disabled} onClick={record}><Mic size={14} aria-hidden="true" />Try again</button>
      <button type="button" className="voice-link" onClick={typeInstead}><Keyboard size={14} aria-hidden="true" />Type instead</button>
      <button type="button" className="voice-icon" onClick={discard} aria-label="Close voice input"><X size={16} aria-hidden="true" /></button>
    </div>}

    {reviewing && <>
      {voice.phase === 'error' && voice.error && <p role="alert" className="voice-error">{voice.error}</p>}
      <TranscriptReview text={voice.text} busy={busy} disabled={disabled} items={items} context={context} loading={loading} libraryError={libraryError}
        onText={voice.setText} onLoad={() => { void load() }} onSelect={(id) => { void select(id) }} onRemove={clearContext}
        onAction={(action) => { void act(action) }} onRerecord={record} onDiscard={discard}
        onOutlook={onOutlook ? () => { const text = voice.text.trim(); if (!text) return; cancel(); clearContext(); onOutlook(text); onClose?.() } : undefined}
        onTeams={onTeams ? () => { const text = voice.text.trim(); if (!text) return; cancel(); clearContext(); onTeams(text); onClose?.() } : undefined} />
      {voice.phase === 'submitting' && <p role="status" className="voice-hint">Starting…</p>}
    </>}

    <p className="voice-privacy"><LockKeyhole size={11} aria-hidden="true" />Audio stays on this device · only scrubbed keywords are searched</p>
    {MOCK && <label className="voice-demo">Demo
      <select aria-label="Voice demo scenario" value={voice.scenario} disabled={busy || disabled} onChange={(event) => { clearContext(); voice.setScenario(event.target.value as VoiceScenario) }}>
        <option value="event">Event discovery</option><option value="save">Save only</option><option value="related">Related to a saved item</option><option value="silence">Silence</option><option value="permission-denied">Permission denied</option>
      </select>
    </label>}
    <span className="visually-hidden" role="status" aria-live="polite">{voice.phase === 'recording' ? 'Listening' : voice.phase === 'transcribing' ? 'Transcribing on this device' : voice.phase === 'review' ? 'Review your text, then choose Search or Save' : ''}</span>
  </section>
}
export default VoiceCapture
