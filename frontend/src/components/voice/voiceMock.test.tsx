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
  it('opens as a one-tap capture strip with a typed fallback and demo scenarios, without starting capture', () => {
    const html = renderToStaticMarkup(<VoiceCapture onJob={() => {}} />)
    for (const text of ['Tap to speak', 'Start speaking', 'Type instead', 'Close voice input', 'Audio stays on this device', 'Voice demo scenario']) expect(html).toContain(text)
    expect(html).not.toContain('<audio')
    expect(html).not.toContain('blob:')
  })
  const review = { text: 'Find AI events in Boston', busy: false, items: [], loading: false, libraryError: null, onText: () => {}, onSelect: () => {}, onRemove: () => {}, onLoad: () => {}, onAction: () => {}, onRerecord: () => {}, onDiscard: () => {} }
  it('reviews editable text with Search as the default action and Save, re-record and discard beside it', () => {
    const html = renderToStaticMarkup(<TranscriptReview {...review} context={null} />)
    for (const text of ['<textarea', 'Find AI events in Boston', '>Search</button>', '>Save for later</button>', 'Record again', 'Discard', 'More like a saved item']) expect(html).toContain(text)
    expect(html).toContain('aria-describedby=')
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>(<svg[^]*?<\/svg>)?Search/)
  })
  it('never offers an action for empty text', () => {
    const html = renderToStaticMarkup(<TranscriptReview {...review} text="   " context={null} />)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(<svg[^]*?<\/svg>)?Search/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(<svg[^]*?<\/svg>)?Save for later/)
  })
  it('offers Find related only once exactly one saved item is chosen, as a removable scrubbed chip', () => {
    const none = renderToStaticMarkup(<TranscriptReview {...review} text="Find more like this" context={null} />)
    expect(none).not.toContain('Find related')
    const chosen = renderToStaticMarkup(<TranscriptReview {...review} text="Find more like this" context={{ id: 'one', summary: 'Scrubbed public summary' }} />)
    expect(chosen).toContain('Scrubbed public summary')
    expect(chosen).toContain('Remove saved context')
    expect(chosen).toMatch(/>(<svg[^]*?<\/svg>)?Find related<\/button>/)
    expect(chosen).not.toMatch(/<button[^>]*disabled=""[^>]*>(<svg[^]*?<\/svg>)?Find related/)
  })
  it('keeps a retry action available when loading saved items fails, preserving the review', () => {
    const html = renderToStaticMarkup(<TranscriptReview {...review} context={null} libraryError="Could not open your saved items. Try again." />)
    expect(html).toContain('Retry loading saved items')
    expect(html).toContain(review.text)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Retry loading saved items/)
    const loading = renderToStaticMarkup(<TranscriptReview {...review} context={null} loading libraryError="Could not open your saved items. Try again." />)
    expect(loading).toMatch(/<button[^>]*disabled=""[^>]*>Retry loading saved items/)
  })

})
