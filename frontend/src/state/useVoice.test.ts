import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ transcribeAudio: vi.fn(), analyzeVoice: vi.fn() }))
vi.mock('../api/client', () => ({ MOCK: false }))
vi.mock('../api/voice', async (original) => ({ ...await original<typeof import('../api/voice')>(), ...api }))
import { createVoiceController, voiceRecovery } from './useVoice'
import { VoiceError } from '../api/voice'

class Recorder {
  static isTypeSupported = vi.fn((type: string) => type === 'audio/webm;codecs=opus')
  static last: Recorder
  state = 'inactive'
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  options: { mimeType: string }
  constructor(_stream: unknown, options: { mimeType: string }) { this.options = options; Recorder.last = this }
  start() { this.state = 'recording' }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['audio']) }); this.onstop?.() }
}
const drain = async () => { await Promise.resolve(); await Promise.resolve() }
describe('voice capture lifecycle', () => {
  let voice: ReturnType<typeof createVoiceController>
  let tracks: { stop: ReturnType<typeof vi.fn> }[]
  let media: ReturnType<typeof vi.fn>
  let onJob: ReturnType<typeof vi.fn<(jobId: string, action: import('../api/voice').VoiceAction) => void>>
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks()
    Recorder.isTypeSupported.mockImplementation((type: string) => type === 'audio/webm;codecs=opus')
    tracks = [{ stop: vi.fn() }, { stop: vi.fn() }]
    media = vi.fn().mockResolvedValue({ getTracks: () => tracks })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: media } })
    vi.stubGlobal('MediaRecorder', Recorder)
    api.transcribeAudio.mockResolvedValue({ transcript: 'Reviewed thought', language: 'en', duration_ms: 1000 })
    api.analyzeVoice.mockResolvedValue({ job_id: 'j_voice' })
    onJob = vi.fn(); voice = createVoiceController(onJob)
  })
  afterEach(() => { voice.dispose(); vi.unstubAllGlobals(); vi.useRealTimers() })
  it('does not capture until start, stops every track, reviews before analysis and clears on success', async () => {
    expect(media).not.toHaveBeenCalled()
    await voice.start()
    expect(media).toHaveBeenCalledWith({ audio: true })
    expect(Recorder.last.options.mimeType).toBe('audio/webm;codecs=opus')
    voice.stop(); await drain()
    tracks.forEach((track) => expect(track.stop).toHaveBeenCalled())
    expect(voice.getSnapshot().phase).toBe('review')
    expect(api.analyzeVoice).not.toHaveBeenCalled()
    voice.setText('  edited text  ')
    await voice.submit('save')
    expect(api.analyzeVoice).toHaveBeenCalledWith('  edited text  ', 'save', null, expect.any(AbortSignal))
    expect(onJob).toHaveBeenCalledWith('j_voice', 'save')
    expect(voice.getSnapshot().text).toBe('')
  })
  it('cancels capture without uploading and stops every track', async () => {
    await voice.start(); voice.cancel()
    expect(api.transcribeAudio).not.toHaveBeenCalled()
    tracks.forEach((track) => expect(track.stop).toHaveBeenCalled())
  })
  it('aborts transcription and ignores its late response', async () => {
    let resolve!: (value: { transcript: string }) => void
    api.transcribeAudio.mockImplementation(() => new Promise((done) => { resolve = done }))
    await voice.start(); voice.stop()
    const signal = api.transcribeAudio.mock.calls[0][2] as AbortSignal
    voice.cancel(); expect(signal.aborted).toBe(true)
    resolve({ transcript: 'late private text' }); await drain()
    expect(voice.getSnapshot()).toMatchObject({ phase: 'idle', text: '' })
  })
  it('releases a microphone granted after cancellation', async () => {
    let resolve!: (stream: unknown) => void
    media.mockImplementation(() => new Promise((done) => { resolve = done }))
    const pending = voice.start(); voice.cancel()
    resolve({ getTracks: () => tracks }); await pending
    tracks.forEach((track) => expect(track.stop).toHaveBeenCalled())
    expect(api.transcribeAudio).not.toHaveBeenCalled()
  })
  it('auto stops at 30 seconds and releases capture on error/unmount', async () => {
    await voice.start(); await vi.advanceTimersByTimeAsync(30_000)
    expect(voice.getSnapshot().phase).toBe('review')
    tracks.forEach((track) => expect(track.stop).toHaveBeenCalled())
    await voice.start(); Recorder.last.onerror?.()
    expect(voice.getSnapshot().phase).toBe('error')
    await voice.start(); voice.dispose()
    tracks.forEach((track) => expect(track.stop).toHaveBeenCalledTimes(3))
  })
  it('ignores analysis after cancellation and retains text on errors', async () => {
    let resolve!: (value: { job_id: string }) => void
    api.analyzeVoice.mockImplementation(() => new Promise((done) => { resolve = done }))
    voice.setText('typed review'); const pending = voice.submit('explore'); voice.cancel()
    resolve({ job_id: 'late' }); await pending
    expect(onJob).not.toHaveBeenCalled()
    api.analyzeVoice.mockRejectedValue(new VoiceError('backend_error', 422))
    voice.setText('retry this'); await voice.submit('explore')
    expect(voice.getSnapshot()).toMatchObject({ phase: 'error', text: 'retry this' })
  })
  it('uses MP4 then Ogg fallback in preference order and fails closed without recorder support', async () => {
    Recorder.isTypeSupported.mockImplementation((type: string) => type === 'audio/mp4' || type === 'audio/ogg;codecs=opus')
    await voice.start()
    expect(Recorder.last.options.mimeType).toBe('audio/mp4')
    voice.cancel()
    Recorder.isTypeSupported.mockImplementation((type: string) => type === 'audio/ogg;codecs=opus')
    await voice.start()
    expect(Recorder.last.options.mimeType).toBe('audio/ogg;codecs=opus')
    voice.cancel()
    Recorder.isTypeSupported.mockReturnValue(false)
    await voice.start()
    expect(voice.getSnapshot().error).toContain('unsupported')
    voice.setText('typed fallback')
    await voice.submit('explore')
    expect(onJob).toHaveBeenCalledWith('j_voice', 'explore')
    expect(media).toHaveBeenCalledTimes(2)
  })
  it('releases tracks and discards oversized audio without upload', async () => {
    await voice.start()
    Recorder.last.ondataavailable?.({ data: new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]) })
    expect(voice.getSnapshot().error).toContain('too large')
    tracks.forEach((track) => expect(track.stop).toHaveBeenCalled())
    expect(api.transcribeAudio).not.toHaveBeenCalled()
  })
  it('denies capture and analysis synchronously without changing the review or releasing another reservation', async () => {
    const busy = vi.fn(() => false)
    voice = createVoiceController(onJob, busy)
    voice.setText('keep this review')
    const capture = voice.start()
    expect(busy).toHaveBeenCalledExactlyOnceWith(true)
    expect(media).not.toHaveBeenCalled()
    expect(voice.getSnapshot()).toMatchObject({ phase: 'review', text: 'keep this review' })
    await capture
    const analysis = voice.submit('explore')
    expect(busy.mock.calls).toEqual([[true], [true]])
    expect(api.analyzeVoice).not.toHaveBeenCalled()
    await analysis
    voice.cancel(); voice.dispose()
    expect(busy.mock.calls).toEqual([[true], [true]])
  })
  it('reserves before requesting permission and releases immediately on cancel before permission settles', async () => {
    const busy = vi.fn<(busy: boolean) => boolean | void>(() => true)
    voice = createVoiceController(onJob, busy)
    let resolve!: (stream: unknown) => void
    media.mockImplementation(() => {
      expect(busy.mock.calls).toEqual([[true]])
      return new Promise((done) => { resolve = done })
    })
    const capture = voice.start()
    expect(voice.getSnapshot().phase).toBe('requesting')
    voice.cancel()
    expect(busy.mock.calls).toEqual([[true], [false]])
    resolve({ getTracks: () => tracks }); await capture
    tracks.forEach((track) => expect(track.stop).toHaveBeenCalled())
    expect(busy.mock.calls).toEqual([[true], [false]])
  })
  it('holds capture reservation through transcription, releases for review, and reserves again before analysis', async () => {
    const busy = vi.fn<(busy: boolean) => boolean | void>(() => true)
    voice = createVoiceController(onJob, busy)
    let resolve!: (value: { transcript: string }) => void
    api.transcribeAudio.mockImplementation(() => new Promise((done) => { resolve = done }))
    await voice.start(); voice.stop()
    expect(busy.mock.calls).toEqual([[true]])
    resolve({ transcript: 'review me' }); await drain()
    expect(busy.mock.calls).toEqual([[true], [false]])
    api.analyzeVoice.mockImplementation(async () => {
      expect(busy.mock.calls).toEqual([[true], [false], [true]])
      return { job_id: 'j_reserved' }
    })
    onJob.mockImplementation(() => {
      expect(voice.getSnapshot().text).toBe('')
      expect(busy.mock.calls).toEqual([[true], [false], [true], [false]])
    })
    await voice.submit('save')
    expect(onJob).toHaveBeenCalledWith('j_reserved', 'save')
  })
  it('releases an in-flight analysis synchronously on cancel and ignores late completion', async () => {
    const busy = vi.fn<(busy: boolean) => boolean | void>(() => true)
    voice = createVoiceController(onJob, busy)
    let resolve!: (value: { job_id: string }) => void
    api.analyzeVoice.mockImplementation(() => new Promise((done) => { resolve = done }))
    voice.setText('review me'); const analysis = voice.submit('explore')
    expect(busy.mock.calls).toEqual([[true]])
    voice.cancel()
    expect(busy.mock.calls).toEqual([[true], [false]])
    expect((api.analyzeVoice.mock.calls[0][3] as AbortSignal).aborted).toBe(true)
    resolve({ job_id: 'abandoned' }); await analysis
    expect(onJob).not.toHaveBeenCalled()
    expect(busy.mock.calls).toEqual([[true], [false]])
  })
  it('releases on errors and disposal, and uses updated callbacks', async () => {
    const busy = vi.fn<(busy: boolean) => boolean | void>(() => true)
    voice = createVoiceController(onJob, busy)
    media.mockRejectedValueOnce(new DOMException('', 'NotAllowedError'))
    await voice.start()
    expect(busy.mock.calls).toEqual([[true], [false]])
    await voice.start()
    const updated = vi.fn<(busy: boolean) => boolean | void>(() => true)
    voice.setOnBusyChange(updated)
    voice.dispose()
    expect(updated).toHaveBeenCalledExactlyOnceWith(false)
    tracks.forEach((track) => expect(track.stop).toHaveBeenCalled())
    voice.setText('typed')
    const jobCallback = vi.fn()
    voice.setOnJob(jobCallback)
    api.analyzeVoice.mockRejectedValueOnce(new VoiceError('backend_error', 422))
    await voice.submit('save')
    expect(updated.mock.calls).toEqual([[false], [true], [false]])
    await voice.submit('save')
    expect(jobCallback).toHaveBeenCalledWith('j_voice', 'save')
    expect(onJob).not.toHaveBeenCalled()
  })
  it('times out local requests and reports distinct recoveries', async () => {
    api.transcribeAudio.mockImplementation(() => new Promise(() => {}))
    await voice.start(); voice.stop(); await vi.advanceTimersByTimeAsync(60_000)
    expect(voice.getSnapshot().error).toContain('timed out')
    const errors = [new DOMException('', 'NotAllowedError'), new DOMException('', 'NotFoundError'), new DOMException('', 'NotSupportedError'), ...['voice_model_unavailable', 'no_speech', 'timeout'].map((code) => new VoiceError(code)), ...[413, 415, 422].map((status) => new VoiceError('backend_error', status))]
    expect(new Set(errors.map(voiceRecovery)).size).toBe(errors.length)
  })
})
