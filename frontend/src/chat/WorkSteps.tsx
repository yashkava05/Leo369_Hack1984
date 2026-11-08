import { Check, ChevronDown, Circle, LoaderCircle, ShieldCheck, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ChatMessage } from './messages'
import { mapSteps } from './format'

export function WorkSteps({ message }: { message: Extract<ChatMessage, { type: 'work-steps' }> }) {
  const [open, setOpen] = useState(true)
  const [clock, setClock] = useState(() => Date.now())
  const finished = message.finishedAt !== undefined
  useEffect(() => {
    if (finished) return
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [finished])
  useEffect(() => {
    if (!finished) return
    const timer = window.setTimeout(() => setOpen(false), 1200)
    return () => window.clearTimeout(timer)
  }, [finished])
  const steps = mapSteps(message.events, message.result)
  const blocked = steps.some((step) => step.state === 'blocked')
  const hasInternet = message.result?.egress.some((r) => !r.blocked)
  const headline = message.failed ? 'Something needs a little attention'
    : !finished ? 'A few steps, all in the open'
    : blocked ? 'Understood on this device, search blocked'
    : hasInternet ? 'Done on this device, plus a short web search' : 'Done on this device'
  const seconds = Math.max(0, ((message.finishedAt ?? clock) - message.startedAt) / 1000).toFixed(1)
  return (
    <div className="chat-work">
      <button type="button" className="chat-work-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ShieldCheck size={17} aria-hidden="true" />
        <span>{headline}</span><span className="chat-work-time">{seconds}s</span>
        <ChevronDown size={15} className={open ? 'is-open' : ''} aria-hidden="true" />
      </button>
      {open && <ol className="chat-steps" aria-label="Work steps">
        {steps.map((step) => {
          const Icon = step.state === 'running' ? LoaderCircle : step.state === 'ok' ? Check
            : step.state === 'error' || step.state === 'blocked' ? X : Circle
          return <li key={step.id} className={`chat-step is-${step.state} ${step.tag === 'Internet' ? 'is-net' : 'is-local'}`}>
            <span className="chat-step-icon"><Icon size={14} aria-hidden="true" /></span>
            <div><div className="chat-step-title"><span>{step.title}</span>
              <span className={`chat-tag ${step.tag === 'Internet' ? 'net' : 'local'}`}>{step.tag}</span></div>
              {step.detail && <p>{step.detail}</p>}
              <span className="visually-hidden">{step.state}</span>
            </div>
          </li>
        })}
      </ol>}
    </div>
  )
}
