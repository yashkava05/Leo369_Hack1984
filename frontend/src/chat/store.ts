import { useSyncExternalStore } from 'react'
import { followVoice, reserveVoiceSlot, start } from '../state/useJob'
import type { VoiceAction } from '../api/voice'
import type { JobState } from '../state/useJob'
import { getOffline, setOffline } from '../api/privacy'
import { runAction } from '../components/cards/cardActions'
import type { JobResult } from '../types'
import { askFor, keptLabel, replyFor } from './format'
import { readKept, writeKept } from './kept'
import type { ChatMessage, KeptItem } from './messages'

export const WELCOME = "Hi, I'm Latent. Tap the microphone and tell me what you're looking for. I'll transcribe it on this device, let you review it, then search the live web when you choose Search. You can also attach your own screenshot."
interface ChatState {
  messages: ChatMessage[]
  kept: KeptItem[]
  busy: boolean
  voicePending: boolean
  offline: boolean | null
  toggling: boolean
}
let nextId = 0
const id = () => `chat-${++nextId}`
let state: ChatState = { messages: [{ id: id(), type: 'agent-text', text: WELCOME }], kept: readKept(), busy: false, voicePending: false, offline: null, toggling: false }
let active: { turn: string; file?: File; voiceAction?: VoiceAction; startedAt: number } | null = null
const listeners = new Set<() => void>()
const imageUrls = new Set<string>()
const emit = (next: Partial<ChatState>) => {
  state = { ...state, ...next }
  listeners.forEach((listener) => listener())
}
const append = (...messages: ChatMessage[]) => emit({ messages: [...state.messages, ...messages] })
export const say = (text: string) => append({ id: id(), type: 'agent-text', text })
export const chatSnapshot = () => state
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useChat = () => useSyncExternalStore(subscribe, chatSnapshot, chatSnapshot)

export async function loadOffline(): Promise<void> {
  try { emit({ offline: await getOffline() }) }
  catch { say("I couldn't check air-gap mode. Make sure the backend is running, then try the switch again.") }
}

export async function toggleOffline(offline: boolean): Promise<boolean> {
  if (state.toggling) return false
  emit({ toggling: true })
  try {
    emit({ offline: await setOffline(offline) })
    say(offline
      ? "Air-gap is on. I'll read screenshots on this device and block web searches."
      : "Air-gap is off. Only short searches from public details can leave. Your screenshot stays here.")
    return true
  } catch {
    say("I couldn't change air-gap mode. Check that the backend is running and try again.")
    return false
  } finally { emit({ toggling: false }) }
}

export function sendText(text: string): void {
  if (!text.trim()) return
  append({ id: id(), type: 'user-text', text: text.trim() })
  if (state.busy || state.voicePending) { say("Give me a second, I'm still on the last one."); return }
  say(/privacy|air.?gap|send|receipt|private|leave/i.test(text)
    ? "I read your screenshot on this device. Only short text searches built from public details can leave; your image and private text stay here. Open Receipts to see exactly what was sent, or turn on air-gap to block searches."
    : "I work best with screenshots. Send one of something you meant to come back to: an event, a product, a book, or a work doc.")
}

export async function sendImage(file: File): Promise<void> {
  if (state.busy || state.voicePending) { say("Give me a second, I'm still on the last one."); return }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    say('I can read PNG, JPEG or WebP screenshots. Try one of those.'); return
  }
  if (file.size > 10 * 1024 * 1024) { say('That image is over 10 MB. Try a smaller screenshot.'); return }
  const turn = id()
  const url = URL.createObjectURL(file)
  imageUrls.add(url)
  active = { turn, file, startedAt: Date.now() }
  emit({ busy: true })
  append(
    { id: id(), type: 'user-image', url, name: file.name },
    { id: id(), type: 'typing', turn },
    { id: id(), type: 'work-steps', turn, events: [], startedAt: active.startedAt },
  )
  await start(file)
}

export function setVoiceBusy(busy: boolean): boolean {
  if ((busy && state.busy) || !reserveVoiceSlot(busy)) return false
  emit({ voicePending: busy })
  return true
}

/** Keep the reviewed transcript out of the conversation and persisted chat items. */
export function beginVoiceJob(jobId: string, action: VoiceAction): void {
  if (state.busy || !followVoice(jobId)) return
  const turn = id()
  active = { turn, voiceAction: action, startedAt: Date.now() }
  emit({ busy: true })
  append(
    { id: id(), type: 'agent-text', text: action === 'related' ? 'Finding related options from your selected saved item.' : 'Interpreting your reviewed thought on this device.' },
    { id: id(), type: 'work-steps', turn, source: 'voice', savedLocally: action === 'save', events: [], startedAt: active.startedAt },
  )
}

function jobError(message: string): string {
  if (/key|401|403/i.test(message)) return "Web search couldn't authenticate. Add a valid TAVILY_API_KEY to the root .env file and restart the backend."
  if (/model|ollama|connect|timeout|timed out/i.test(message)) return "The local model isn't responding. Start Ollama, run scripts/setup.sh to check the model, and try your screenshot again."
  if (/fetch|network|upload/i.test(message)) return "I couldn't reach the backend. Start the backend on port 8000, then send the screenshot again."
  return "I couldn't finish reading that screenshot. Check the backend and try a clear PNG, JPEG or WebP screenshot."
}

export function syncJob(job: JobState): void {
  if (!active || (job.status !== 'running' && job.status !== 'done' && job.status !== 'error')) return
  const current = active
  const finished = job.status === 'done' || job.status === 'error'
  const extracted = finished || job.events.some((event) => event.stage === 'extract')
  const messages = state.messages.filter((m) => !(extracted && m.type === 'typing' && m.turn === current.turn))
    .map((m): ChatMessage => m.type === 'work-steps' && m.turn === current.turn
      ? { ...m, events: job.events, result: job.result, failed: job.status === 'error', finishedAt: finished ? Date.now() : undefined }
      : m)
  emit({ messages })
  if (!finished) return
  active = null
  emit({ busy: false })
  if (job.status === 'error' || !job.result) { say(current.voiceAction ? /local_save_unavailable/.test(job.error ?? '') ? 'Local saving failed. Check local storage permissions and free disk space, then submit your reviewed thought again.' : 'Local interpretation failed. Check Ollama, then review and submit your thought again.' : jobError(job.error ?? 'model error')); return }
  finishResult(job.result, current.file, job.events.find((e) => e.stage === 'search' && e.status === 'error')?.message, current.voiceAction)
}

function finishResult(result: JobResult, file?: File, searchError?: string, voiceAction?: VoiceAction): void {
  if (voiceAction === 'save') {
    say('Your scrubbed interest is saved in the local library. Nothing left this device.')
    append({ id: id(), type: 'receipt', source: 'voice', records: result.egress })
    return
  }
  if (voiceAction && !result.queries.length && !result.cards.length && !result.egress.length && !result.error && !searchError) {
    say(voiceAction === 'related'
      ? "That saved item doesn't have enough public details for a related search. Choose another saved item."
      : 'I need more public details to build a search. For events, name a topic or event and a city, such as “Find AI events in Boston this weekend.” For products, include a brand and model. Review your thought and try again.')
    append({ id: id(), type: 'receipt', source: 'voice', records: result.egress })
    return
  }
  const blockedOffline = result.egress.some((record) => record.blocked && /offline|air.?gap/i.test(record.reason ?? ''))
  const entities = result.intent?.public_entities.map((entity) => entity.value).join(', ') || 'the public details'
  say(blockedOffline
    ? `I read it on this device: ${entities}. Air-gap is on, so I didn't search the web.`
    : voiceAction && !result.cards.length
      ? 'The search finished without usable cards. Try a more specific topic, location, or date.'
      : replyFor(result.intent))
  if (result.cards.length) append({ id: id(), type: 'cards', cards: result.cards })
  append({ id: id(), type: 'receipt', source: voiceAction ? 'voice' : undefined, records: result.egress })
  if (blockedOffline) {
    if (voiceAction) { say('Turn air-gap off and submit your reviewed thought again to search the web.'); return }
    append({ id: id(), type: 'ask', kind: 'resume', question: 'Turn air-gap off and finish?', primary: 'Turn off and finish', result, file })
    return
  }
  const networkErrors = result.egress.filter((r) => r.blocked)
  if (result.error || networkErrors.length || searchError) {
    say(/key|401|403/i.test(searchError ?? result.error ?? '')
      ? jobError(searchError ?? result.error!)
      : "Some web searches couldn't finish. Check the API key and connection in your backend, then try again. The options built on this device are still here.")
  }
  const ask = askFor(result)
  if (ask) append({ id: id(), type: 'ask', ...ask, result })
}

export async function chooseAsk(messageId: string, yes: boolean): Promise<void> {
  const ask = state.messages.find((m) => m.id === messageId)
  if (!ask || ask.type !== 'ask' || ask.choice) return
  if (ask.kind === 'resume' && (state.busy || state.voicePending || state.toggling)) { say("Give me a second, I'm still on the last one."); return }
  const choice = yes ? ask.primary : 'Not now'
  emit({ messages: state.messages.map((m) => m.id === messageId ? { ...ask, choice } : m) })
  append({ id: id(), type: 'user-text', text: choice })
  if (!yes) { say("No problem. It's here whenever you want it."); return }
  if (ask.kind === 'resume') {
    // Reserve the turn across the network await so another upload cannot displace this File.
    emit({ busy: true })
    if (ask.file && await toggleOffline(false)) {
      emit({ busy: false })
      await sendImage(ask.file)
    } else {
      emit({ busy: false })
      append({ ...ask, id: id(), choice: undefined })
    }
    return
  }
  if (ask.kind === 'calendar') {
    const card = ask.result.cards.find((c) => c.kind === 'calendar' && c.actions.some((a) => a.type === 'download_ics'))
    const action = card?.actions.find((a) => a.type === 'download_ics')
    try {
      if (!card || !action) throw new Error('missing calendar')
      await runAction(action, card)
    } catch {
      say("I couldn't create the calendar file. Try again or use the calendar card's download button.")
      append({ ...ask, id: id(), choice: undefined })
      return
    }
  }
  const item: KeptItem = { label: keptLabel(ask.result.intent), intent_type: ask.result.intent?.intent_type ?? 'other', savedAt: Date.now(), cards: ask.result.cards }
  try {
    const kept = [item, ...state.kept]
    writeKept(kept)
    emit({ kept })
    say(ask.kind === 'calendar' ? 'Done. Your calendar file is ready.' : 'Saved to Kept for later. Come back to it whenever you like.')
  } catch {
    say(ask.kind === 'calendar' ? "Your calendar file is ready, but I couldn't save it for later. Allow local storage in this browser and try again." : "I couldn't save that here. Allow local storage in this browser and try again.")
    append({ ...ask, id: id(), kind: 'save', question: 'Try saving this for later?', primary: 'Save', choice: undefined })
  }
}

export function reopenKept(item: KeptItem): void {
  say(`Here's what you kept: ${item.label}.`)
  append({ id: id(), type: 'cards', cards: item.cards })
}

export function releaseImages(): void {
  imageUrls.forEach((url) => URL.revokeObjectURL(url))
  imageUrls.clear()
}
