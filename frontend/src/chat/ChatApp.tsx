import { ArrowUp, Bookmark, Check, ChevronRight, ImagePlus, LockKeyhole, MessageCircle, Mic, Plus, ShieldCheck, Sparkles } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import { MOCK } from '../api/client'
import { VoiceCapture } from '../components/voice/VoiceCapture'
import { ActionCard } from '../components/cards/ActionCard'
import { useJob } from '../state/useJob'
import { OutlookPanel } from '../outlook/OutlookPanel'
import { liveDriver } from '../outlook/driver'
import { createDemoDriver } from '../outlook/demo'
import { TeamsPanel } from '../teams/TeamsPanel'
import { liveTeamsDriver } from '../teams/driver'
import { createDemoTeamsDriver } from '../teams/demo'
import type { EgressRecord } from '../types'
import type { ChatMessage } from './messages'
import { beginVoiceJob, chooseAsk, loadOffline, releaseImages, reopenKept, say, sendImage, sendText, setVoiceBusy, syncJob, toggleOffline, useChat } from './store'
import { receiptLabel } from './receipts'
import { ReceiptsDrawer } from './ReceiptsDrawer'
import { WorkSteps } from './WorkSteps'
import './chat.css'

const SAMPLES = [
  { name: 'concert_ig.png', title: 'Try a concert flyer', hint: 'From saved to front row', icon: '♪' },
  { name: 'product_amazon.png', title: 'Try a product page', hint: 'Find your next good thing', icon: '↗' },
  { name: 'book_goodreads.png', title: 'Try a book', hint: 'Make room on your shelf', icon: '▤' },
  { name: 'doc_internal_email.png', title: 'Try a work email', hint: 'Keep the private bits private', icon: '✳' },
]

// Demo mode never touches a browser extension: it uses the labelled fake inbox.
const OUTLOOK_DRIVER = MOCK ? createDemoDriver() : liveDriver
const TEAMS_DRIVER = MOCK ? createDemoTeamsDriver() : liveTeamsDriver

export function Orb({ small = false }: { small?: boolean }) {
  return <span aria-hidden="true" className={`chat-orb${small ? ' is-small' : ''}`}><span /></span>
}

function Cards({ message }: { message: Extract<ChatMessage, { type: 'cards' }> }) {
  // Reposted cards need distinct DOM ids, including across older turns in this same thread.
  return <div className="chat-card-row" role="region" aria-label="Action cards" tabIndex={0}>
    {message.cards.map((card) => <ActionCard key={card.id} card={{ ...card, id: `${message.id}-${card.id}` }} />)}
  </div>
}

export function ChatApp() {
  const chat = useChat()
  const job = useJob()
  const { status: jobStatus, events: jobEvents, result: jobResult, error: jobError } = job
  const [text, setText] = useState('')
  const [dragging, setDragging] = useState(false)
  const [sampleLoading, setSampleLoading] = useState<string | null>(null)
  const [drawer, setDrawer] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [selectedReceipt, setSelectedReceipt] = useState<EgressRecord[] | null>(null)
  // Private Outlook results live only inside the panel (#67), never in the chat store.
  const [outlook, setOutlook] = useState<{ key: number; request: string } | null>(null)
  // Same for Teams (#68). One browser read at a time: opening one panel closes the other.
  const [teams, setTeams] = useState<{ key: number; request: string } | null>(null)
  const attach = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const dragDepth = useRef(0)
  const loadingSample = useRef(false)
  const composer = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    document.body.classList.add('chat-mode')
    return () => document.body.classList.remove('chat-mode')
  }, [])
  useEffect(() => { void loadOffline() }, [])
  useEffect(() => { syncJob({ status: jobStatus, events: jobEvents, result: jobResult, error: jobError }) }, [jobStatus, jobEvents, jobResult, jobError])
  useEffect(() => {
    const onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) releaseImages() }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [])
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = event.clipboardData?.files[0]
      if (!file) return
      event.preventDefault()
      void sendImage(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])
  useLayoutEffect(() => {
    if (following.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [chat.messages])

  async function sample(name: string) {
    if (chat.busy || chat.voicePending || loadingSample.current) { say("Give me a second, I'm still on the last one."); return }
    loadingSample.current = true
    setSampleLoading(name)
    try {
      const response = await fetch(`/samples/${name}`)
      if (!response.ok) throw new Error('sample unavailable')
      const file = new File([await response.blob()], name, { type: 'image/png' })
      following.current = true
      await sendImage(file)
    } catch { say("I couldn't open that sample. Try attaching your own screenshot with the + button.") }
    finally { loadingSample.current = false; setSampleLoading(null) }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    following.current = true
    sendText(text)
    setText('')
    composer.current?.focus()
  }

  function drop(event: DragEvent) {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file) { following.current = true; void sendImage(file) }
  }

  const receipts = chat.messages.flatMap((m) => m.type === 'receipt' ? m.records : [])
  const openReceipt = (records: EgressRecord[] | null) => { setSelectedReceipt(records); setDrawer(true) }
  const status = chat.offline ? 'Air-gap on: nothing leaves this device' : chat.busy ? 'Working on this device…' : 'Works on this device'
  const welcomeOnly = chat.messages.length === 1

  function messageView(message: ChatMessage) {
    switch (message.type) {
      case 'user-image': return <div className="chat-user-image"><img src={message.url} alt={`Your screenshot: ${message.name}`} /><span><LockKeyhole size={11} aria-hidden="true" /> Stays on this device</span></div>
      case 'user-text': return <div className="chat-bubble chat-user-bubble">{message.text}</div>
      case 'agent-text': return <div className="chat-agent-message"><Orb small /><div className="chat-bubble chat-agent-bubble">{message.text}</div></div>
      case 'typing': return <div className="chat-agent-message"><Orb small /><div className="chat-typing" role="status" aria-label="Latent is reading your screenshot"><i /><i /><i /></div></div>
      case 'work-steps': return <div className="chat-agent-content"><WorkSteps message={message} /></div>
      case 'cards': return <div className="chat-agent-content"><Cards message={message} /></div>
      case 'receipt': return <div className="chat-agent-content"><button type="button" className="chat-receipt-pill" onClick={() => openReceipt(message.records)}>{receiptLabel(message.records, message.source)}<ChevronRight size={13} aria-hidden="true" /></button></div>
      case 'ask': return <div className="chat-agent-message"><Orb small /><div className="chat-bubble chat-agent-bubble chat-ask"><p>{message.question}</p><div>
        <button className="chat-primary" type="button" disabled={!!message.choice || (message.kind === 'resume' && (chat.busy || chat.voicePending))} onClick={() => { void chooseAsk(message.id, true) }}>{message.choice === message.primary && <Check size={14} aria-hidden="true" />}{message.primary}</button>
        <button className="chat-secondary" type="button" disabled={!!message.choice} onClick={() => { void chooseAsk(message.id, false) }}>Not now</button>
      </div></div></div>
    }
  }

  return (
    <div className={`chat-app${chat.busy ? ' is-busy' : ''}${dragging ? ' is-dragging' : ''}`}
      onDragEnter={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDragging(true) } }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false) }}
      onDrop={drop}>
      <aside className="chat-sidebar" aria-label="Your chats and saved items" inert={drawer}>
        <div className="chat-brand"><Orb /><span>Latent<span className="chat-brand-dot">.</span></span></div>
        <div className="chat-sidebar-section"><h2>Chats</h2>
          <button className="chat-nav-item is-selected" type="button" aria-current="page" onClick={() => composer.current?.focus()}><MessageCircle size={17} aria-hidden="true" /><span>Latent</span><span className="chat-online-dot" /></button>
        </div>
        <div className="chat-sidebar-section chat-kept"><h2><Bookmark size={13} aria-hidden="true" /> Kept for later <span>{chat.kept.length || ''}</span></h2>
          {chat.kept.length ? <ul>{chat.kept.map((item, index) => <li key={`${item.savedAt}-${index}`}><button type="button" onClick={() => { following.current = true; reopenKept(item) }}><span className="chat-kept-icon"><Bookmark size={14} aria-hidden="true" /></span><span>{item.label}<small>{new Date(item.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small></span></button></li>)}</ul>
            : <div className="chat-kept-empty"><Bookmark size={23} strokeWidth={1.3} aria-hidden="true" /><p>Good finds deserve<br />a place to come back to.</p><span>Things you keep will live here.</span></div>}
        </div>
        <div className="chat-sidebar-footer"><ShieldCheck size={17} aria-hidden="true" /><div>A little more private.<span>A lot more useful.</span></div></div>
      </aside>
      <div className="chat-main" inert={drawer}>
        <header className="chat-header"><div className="chat-header-identity"><Orb /><div><h1>Latent</h1><p><span className={`chat-status-dot${chat.offline ? ' is-offline' : ''}`} />{status}</p></div></div>
          <div className="chat-header-controls"><label className="chat-airgap"><span>Air-gap</span><button type="button" role="switch" aria-label="Air-gap mode" aria-checked={chat.offline === true} disabled={chat.toggling}
            onClick={() => { void toggleOffline(!chat.offline) }}><span /></button></label>
            <span className="chat-header-divider" /><button type="button" className="chat-receipts-button" onClick={() => openReceipt(null)}><ShieldCheck size={16} aria-hidden="true" /><span>Receipts</span></button></div>
        </header>
        <div className="chat-scroll" ref={scroller} onScroll={() => { const el = scroller.current; if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100 }}>
          <main className="chat-thread" aria-label="Conversation with Latent">
            <div className="chat-day"><span />Today<span /></div>
            {welcomeOnly && <div className="chat-intro"><span className="chat-intro-mark"><Sparkles size={18} strokeWidth={1.5} aria-hidden="true" /></span><h2>What are you looking for?</h2><p>Speak a request. Review it. Get live results.</p></div>}
            <div className="chat-messages" role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions">
              {chat.messages.map((message, index) => <div key={message.id} className={`chat-message type-${message.type}`}>{messageView(message)}
                {MOCK && index === 0 && <div className="chat-samples"><p>A little inspiration to get started</p><div>{SAMPLES.map((item) => <button key={item.name} type="button" onClick={() => { void sample(item.name) }} aria-busy={sampleLoading === item.name}>
                  <span className="chat-sample-art"><img src={`/samples/${item.name}`} alt="" /><span>{item.icon}</span></span><span className="chat-sample-label">{item.title}<small>{sampleLoading === item.name ? 'Opening sample…' : item.hint}</small></span><Plus size={14} aria-hidden="true" /></button>)}</div></div>}
              </div>)}
            </div>
            {outlook && <div className="chat-agent-content"><OutlookPanel key={outlook.key} request={outlook.request} driver={OUTLOOK_DRIVER} offline={chat.offline === true} onClose={() => setOutlook(null)} /></div>}
            {teams && <div className="chat-agent-content"><TeamsPanel key={teams.key} request={teams.request} driver={TEAMS_DRIVER} offline={chat.offline === true} onClose={() => setTeams(null)} /></div>}
          </main>
        </div>
        <div className="chat-composer-area">
          {MOCK && <p className="chat-demo-note"><span /> Demo mode · Sample results, no web searches sent</p>}
          <div id="chat-voice-controls" className="chat-voice-panel" hidden={!voiceOpen}>
            {voiceOpen && <VoiceCapture autoStart disabled={chat.busy} onBusyChange={setVoiceBusy} onJob={beginVoiceJob} onClose={() => setVoiceOpen(false)}
              onOutlook={(request) => { following.current = true; setTeams(null); setOutlook({ key: Date.now(), request }) }}
              onTeams={(request) => { following.current = true; setOutlook(null); setTeams({ key: Date.now(), request }) }} />}
          </div>
          <form className="chat-composer" onSubmit={submit} aria-label="Message composer">
            <button type="button" className="chat-attach" aria-label="Attach a screenshot" onClick={() => attach.current?.click()}><Plus size={21} aria-hidden="true" /></button>
            <button type="button" className={`chat-attach chat-mic${voiceOpen ? ' is-active' : ''}`} aria-label={voiceOpen ? 'Close voice input' : 'Speak a thought'} aria-expanded={voiceOpen} aria-controls="chat-voice-controls" title={voiceOpen ? 'Close voice input' : 'Speak a thought'} disabled={chat.busy && !voiceOpen} onClick={() => setVoiceOpen(!voiceOpen)}><Mic size={18} aria-hidden="true" /></button>
            <input type="file" ref={attach} accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) { following.current = true; void sendImage(file) } }} />
            <input ref={composer} value={text} onChange={(event) => setText(event.target.value)} aria-label="Message Latent" placeholder="Message Latent, or speak with the microphone" />
            <button type="submit" className="chat-send" aria-label="Send message" disabled={!text.trim()}><ArrowUp size={18} aria-hidden="true" /><span>Send</span></button>
          </form>
          <p className="chat-composer-hint"><LockKeyhole size={11} aria-hidden="true" /> Your audio and screenshots stay on this device.</p>
        </div>
      </div>
      <ReceiptsDrawer open={drawer} onClose={() => setDrawer(false)} mockRecords={receipts} selectedRecords={selectedReceipt} />
      {dragging && <div className="chat-drop-overlay"><ImagePlus size={42} strokeWidth={1.3} aria-hidden="true" /><h2>Drop it here. I'll take a look.</h2><p>Your screenshot stays on this device.</p></div>}
    </div>
  )
}
