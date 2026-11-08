import { useEffect, useState, useSyncExternalStore } from 'react'
import { MOCK } from '../api/client'
import { analyzeVoice, normalizeVoiceText, transcribeAudio, VoiceError } from '../api/voice'
import type { VoiceAction, VoiceScenario } from '../api/voice'

export type VoiceBusyChange = (busy: boolean) => boolean | void
const noopBusyChange: VoiceBusyChange = () => {}

export type VoicePhase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'review' | 'submitting' | 'error'
export interface VoiceState { phase: VoicePhase; text: string; elapsed: number; error: string | null; scenario: VoiceScenario }
export function voiceRecovery(error: unknown): string {
  const code = error instanceof VoiceError ? error.code : error instanceof Error ? error.name : ''
  const status = error instanceof VoiceError ? error.status : 0
  if (code === 'NotAllowedError' || code === 'SecurityError') return 'Microphone permission denied — allow it in your browser settings.'
  if (code === 'NotFoundError' || code === 'DevicesNotFoundError') return 'No microphone found — connect one and try again.'
  if (code === 'NotSupportedError') return 'Recording is unsupported in this browser.'
  if (code === 'voice_model_unavailable') return 'The local speech model is missing — run scripts/setup_voice.sh.'
  if (code === 'no_speech') return 'No speech detected — try again somewhere quieter.'
  if (code === 'TimeoutError' || code === 'timeout' || status === 504 || status === 408) return 'Local processing timed out — try a shorter thought.'
  if (status === 413) return 'Recording is too large — try a shorter thought.'
  if (status === 415) return 'This browser\'s audio format was rejected — try another browser.'
  if (code === 'audio_too_long') return 'That was over 30 seconds — try a shorter thought.'
  if (status === 422) return 'That couldn\'t be processed — edit the text or record again.'
  if (status === 404) return 'That saved item is unavailable — choose another.'
  return 'Something went wrong on this device — check the backend and try again.'
}

/** Instance-local controller also makes capture races testable without a DOM or extra dependency. */
export function createVoiceController(onJob: (jobId: string, action: VoiceAction) => void, onBusyChange: VoiceBusyChange = noopBusyChange) {
  let notifyJob = onJob
  let notifyBusy = onBusyChange
  let reserved = false
  const reserve = () => {
    if (notifyBusy(true) === false) return false
    reserved = true
    return true
  }
  const releaseBusy = () => {
    if (!reserved) return
    reserved = false
    notifyBusy(false)
  }
  let state: VoiceState = { phase: 'idle', text: '', elapsed: 0, error: null, scenario: 'event' }
  const listeners = new Set<() => void>()
  let generation = 0
  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let chunks: Blob[] = []
  let bytes = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let requestTimer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | null = null
  const update = (next: Partial<VoiceState>) => {
    state = { ...state, ...next }
    if (next.phase === 'review' || next.phase === 'error' || next.phase === 'idle') releaseBusy()
    listeners.forEach((listener) => listener())
  }
  const stopTracks = () => { stream?.getTracks().forEach((track) => track.stop()); stream = null }
  const clearTimers = () => { clearInterval(timer); clearTimeout(requestTimer); timer = undefined; requestTimer = undefined }
  const release = () => {
    clearTimers(); controller?.abort(); controller = null
    if (recorder) {
      recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null
      if (recorder.state !== 'inactive') { try { recorder.stop() } catch { /* tracks still released below */ } }
      recorder = null
    }
    stopTracks(); chunks = []; bytes = 0
  }
  const fail = (error: unknown) => { release(); update({ phase: 'error', error: voiceRecovery(error) }) }
  const beginRequest = () => {
    controller = new AbortController()
    requestTimer = setTimeout(() => { generation++; fail(new DOMException('timeout', 'TimeoutError')) }, 60_000)
    return controller.signal
  }
  const cancel = () => { generation++; release(); update({ phase: 'idle', text: '', elapsed: 0, error: null }) }
  const transcribe = async (mime: string, gen: number) => {
    if (gen !== generation) return
    clearTimers(); stopTracks(); recorder = null
    update({ phase: 'transcribing' })
    let blob: Blob | null = new Blob(chunks, { type: mime })
    chunks = []
    try {
      const signal = beginRequest()
      const result = await transcribeAudio(blob, `thought.${mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm'}`, signal)
      if (gen === generation) { clearTimers(); controller = null; update({ phase: 'review', text: normalizeVoiceText(result.transcript), error: null }) }
    } catch (error) { if (gen === generation) fail(error) }
    finally { blob = null }
  }
  const stop = () => {
    if (state.phase !== 'recording') return
    clearTimers()
    if (MOCK) {
      if (state.scenario === 'silence') { fail(new VoiceError('no_speech', 422)); return }
      update({ phase: 'review', text: state.scenario === 'save' ? 'I am interested in AI Fest in Boston' : state.scenario === 'related' ? 'Find more like this' : 'Find AI events in Boston on November 14 2026' })
      return
    }
    update({ phase: 'transcribing' })
    try { recorder?.stop(); stopTracks() } catch (error) { fail(error) }
  }
  const start = async () => {
    if (['requesting', 'recording', 'transcribing', 'submitting'].includes(state.phase)) return
    if (!reserve()) return
    generation++; release()
    const gen = generation
    update({ phase: 'requesting', text: '', elapsed: 0, error: null })
    try {
      if (MOCK) {
        if (state.scenario === 'permission-denied') throw new DOMException('denied', 'NotAllowedError')
      } else {
        const mime = typeof MediaRecorder === 'undefined' ? undefined : ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type))
        if (!mime || !navigator.mediaDevices?.getUserMedia) throw new DOMException('unsupported', 'NotSupportedError')
        const acquired = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (gen !== generation) { acquired.getTracks().forEach((track) => track.stop()); return }
        stream = acquired
        recorder = new MediaRecorder(stream, { mimeType: mime })
        recorder.ondataavailable = (event) => {
          if (gen !== generation || !event.data.size) return
          bytes += event.data.size
          if (bytes > 8 * 1024 * 1024) { generation++; fail(new VoiceError('audio_too_large', 413)); return }
          chunks.push(event.data)
        }
        recorder.onstop = () => { void transcribe(mime, gen) }
        recorder.onerror = () => { if (gen === generation) { generation++; fail(new Error('recording')) } }
        recorder.start(1000)
      }
      update({ phase: 'recording', elapsed: 0 })
      const started = Date.now()
      timer = setInterval(() => {
        const elapsed = Math.min(30, Math.floor((Date.now() - started) / 1000))
        update({ elapsed })
        if (elapsed >= 30) stop()
      }, 200)
    } catch (error) { if (gen === generation) fail(error) }
  }
  const submit = async (action: VoiceAction, contextId: string | null = null) => {
    if (!['review', 'error'].includes(state.phase) || !normalizeVoiceText(state.text)) return
    if (!reserve()) return
    const gen = ++generation
    update({ phase: 'submitting', error: null })
    try {
      const result = await analyzeVoice(state.text, action, contextId, beginRequest())
      if (gen !== generation) return
      release(); update({ phase: 'idle', text: '', elapsed: 0 }); notifyJob(result.job_id, action)
    } catch (error) { if (gen === generation) fail(error) }
  }
  return {
    setOnBusyChange: (callback: VoiceBusyChange) => { notifyBusy = callback },
    setOnJob: (callback: (jobId: string, action: VoiceAction) => void) => { notifyJob = callback },
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    start, stop, cancel, submit,
    setText: (text: string) => {
      if (['requesting', 'recording', 'transcribing', 'submitting'].includes(state.phase)) return
      update({ text: text.slice(0, 1000), phase: 'review', error: null })
    },
    setScenario: (scenario: VoiceScenario) => { cancel(); update({ scenario }) },
    dispose: () => { generation++; release(); state = { ...state, phase: 'idle', text: '' }; releaseBusy() },
  }
}

export function useVoice(onJob: (jobId: string, action: VoiceAction) => void, onBusyChange: VoiceBusyChange = noopBusyChange) {
  const [voice] = useState(() => createVoiceController(onJob, onBusyChange))
  useEffect(() => { voice.setOnBusyChange(onBusyChange) }, [voice, onBusyChange])
  useEffect(() => { voice.setOnJob(onJob) }, [voice, onJob])
  const state = useSyncExternalStore(voice.subscribe, voice.getSnapshot, voice.getSnapshot)
  useEffect(() => () => voice.dispose(), [voice])
  return { ...state, ...voice }
}
