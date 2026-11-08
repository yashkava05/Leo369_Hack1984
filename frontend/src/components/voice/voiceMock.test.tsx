import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../api/client', () => ({ MOCK: true, API_URL: '' }))
import { createVoiceController } from '../../state/useVoice'
import { VoiceCapture } from './VoiceCapture'
import { TranscriptReview } from './TranscriptReview'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
describe('no-device voice demos and accessible review', () => {
  it('simulates capture and stops into editable review without capture, fetch or auto submit', async () => {
    vi.useFakeTimers()
    const forbidden = vi.fn(() => { throw new Error('must not be called') })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: forbidden } })
    vi.stubGlobal('MediaRecorder', forbidden)
    vi.stubGlobal('fetch', forbidden)
    vi.stubGlobal('URL', { createObjectURL: forbidden })
    const onJob = vi.fn()
    const voice = createVoiceController(onJob)
    for (const scenario of ['event', 'save', 'related'] as const) {
      voice.setScenario(scenario)
      await voice.start()
      expect(voice.getSnapshot().phase).toBe('recording')
      voice.stop()
      expect(voice.getSnapshot().phase).toBe('review')
      expect(voice.getSnapshot().text).not.toBe('')
      expect(onJob).not.toHaveBeenCalled()
    }
    voice.setScenario('silence'); await voice.start(); voice.stop()
    expect(voice.getSnapshot().error).toContain('No speech')
    voice.setScenario('permission-denied'); await voice.start()
    expect(voice.getSnapshot().error).toContain('permission denied')
    voice.setText('Typed fallback')
    expect(onJob).not.toHaveBeenCalled()
    await voice.submit('save')
    expect(onJob).toHaveBeenCalledWith(expect.stringMatching(/^j_voice_mock_save_/), 'save')
    expect(voice.getSnapshot().text).toBe('')
    voice.dispose()
    expect(forbidden).not.toHaveBeenCalled()
  })
  it('always renders typed review, labeled controls and demo scenarios without starting capture', () => {
    const html = renderToStaticMarkup(<VoiceCapture onJob={() => {}} />)
    for (const text of ['Review or type', 'Explore', 'Save locally', 'Find related', 'Retry', 'Cancel', 'LOCAL', 'WEB', 'Voice demo scenario']) expect(html).toContain(text)
    expect(html).toContain('aria-describedby=')
    expect(html).not.toContain('<audio')
    expect(html).not.toContain('blob:')
  })
  it('disables related until exactly one context is selected and renders a removable scrubbed chip', () => {
    const props = { text: 'Find more like this', busy: false, items: [], loading: false, libraryError: null, onText: () => {}, onSelect: () => {}, onRemove: () => {}, onLoad: () => {}, onAction: () => {}, onRetry: () => {}, onCancel: () => {} }
    const none = renderToStaticMarkup(<TranscriptReview {...props} context={null} />)
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*>Find related/)
    const chosen = renderToStaticMarkup(<TranscriptReview {...props} context={{ id: 'one', summary: 'Scrubbed public summary' }} />)
    expect(chosen).toContain('Scrubbed public summary')
    expect(chosen).toContain('Remove saved context')
    expect(chosen).not.toMatch(/<button[^>]*disabled=""[^>]*>Find related/)
  })
})
