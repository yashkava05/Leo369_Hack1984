import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useJob } from '../state/useJob'
import { STAGE_WIDTH, TAG_WIDTH, formatCounters, terminalModel, lineToText, typingMs, type EgressCounters, type TerminalLine } from './Terminal.format'
import './terminal.css'

const IMAGE_TOOLTIP = 'Enforced: requests over 4 KB or containing base64 blobs are blocked'
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
// How close to the bottom (px) still counts as "following" the log.
const STICK_PX = 12

function subscribeMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mq = window.matchMedia(REDUCED_MOTION)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

function getReducedMotion(): boolean {
  return typeof window === 'undefined' || !window.matchMedia ? true : window.matchMedia(REDUCED_MOTION).matches
}

function usePrefersReducedMotion(): boolean {
  // Without a browser (tests, server render) lines render instantly.
  return useSyncExternalStore(subscribeMotion, getReducedMotion, () => true)
}

interface Reveal {
  jobKey: string | undefined
  done: number // lines fully revealed
  chars: number // characters of line `done` revealed so far
}

/** Reveals one line at a time, ≈ 8 ms/char and at most 400 ms per line. */
function useTypewriter(lines: TerminalLine[], instant: boolean): Reveal {
  const jobKey = lines[0]?.key
  const [reveal, setReveal] = useState<Reveal>({ jobKey, done: 0, chars: 0 })
  let current = reveal
  if (reveal.jobKey !== jobKey || reveal.done > lines.length) {
    // A new job (or a reset): start the reveal over.
    current = { jobKey, done: 0, chars: 0 }
    setReveal(current)
  }

  const typing = instant || current.done >= lines.length ? null : lines[current.done]
  const typingKey = typing?.key
  const typingText = typing?.text
  useEffect(() => {
    if (typingText === undefined) return
    const length = typingText.length
    const duration = typingMs(typingText)
    const start = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const progress = duration === 0 ? 1 : (now - start) / duration
      if (progress >= 1) {
        setReveal((r) => (r.jobKey === jobKey ? { ...r, done: r.done + 1, chars: 0 } : r))
      } else {
        setReveal((r) => (r.jobKey === jobKey ? { ...r, chars: Math.ceil(progress * length) } : r))
        frame = requestAnimationFrame(tick)
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [typingKey, typingText, jobKey])

  return instant ? { jobKey, done: lines.length, chars: 0 } : current
}

interface TerminalViewProps {
  lines: TerminalLine[]
  // null for a result reopened from the library: it keeps no egress records, so zeros would be false.
  counters: EgressCounters | null
  instant: boolean
}

export const AUDIT_UNAVAILABLE = 'Network audit not kept for saved results'

function Counters({ counters: c }: { counters: EgressCounters | null }) {
  if (c === null) {
    return (
      <p className="terminal-counters" data-testid="terminal-counters">
        {AUDIT_UNAVAILABLE}
      </p>
    )
  }
  return (
    <p className="terminal-counters" data-testid="terminal-counters" aria-label={formatCounters(c)}>
      <span>
        Outbound requests: <b>{c.requests}</b>
      </span>
      <span aria-hidden="true"> · </span>
      <span>
        Bytes sent: <b>{c.bytes}</b>
      </span>
      <span aria-hidden="true"> · </span>
      <span className="terminal-image-bytes" title={IMAGE_TOOLTIP} tabIndex={0}>
        Image bytes sent: <b>{c.imageBytes}</b>
      </span>
      <span aria-hidden="true"> · </span>
      <span className={c.blocked > 0 ? 'terminal-blocked-count' : undefined}>
        Blocked: <b>{c.blocked}</b>
      </span>
    </p>
  )
}

export function TerminalView({ lines, counters, instant }: TerminalViewProps) {
  const { done, chars } = useTypewriter(lines, instant)
  const scroller = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)

  const visible = lines.slice(0, Math.min(lines.length, done + 1))

  useLayoutEffect(() => {
    const el = scroller.current
    if (following && el) el.scrollTop = el.scrollHeight
  }, [following, visible.length, chars])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX)
  }

  const jumpToLatest = () => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
    setFollowing(true)
  }

  return (
    <section className="terminal" aria-label="Pipeline terminal">
      <header className="terminal-header">
        <span className="terminal-title">latent · live</span>
        <Counters counters={counters} />
      </header>
      <div className="terminal-body" ref={scroller} onScroll={onScroll} tabIndex={0}>
        <ol className="terminal-lines" role="log" aria-live="polite">
          {visible.map((line, i) => {
            const typingThis = i === done
            const text = typingThis ? line.text.slice(0, chars) : line.text
            return (
              <li key={line.key} className={`terminal-line tone-${line.tone}`} data-testid="terminal-line">
                <span className="visually-hidden">{lineToText(line)}</span>
                <span aria-hidden="true">
                  <span className="terminal-time">[{line.time}] </span>
                  <span className="terminal-tag">{line.tag.padEnd(TAG_WIDTH)}</span>
                  <span className="terminal-stage">{line.stage.padEnd(STAGE_WIDTH)}</span>
                  <span className="terminal-text">{text}</span>
                  {typingThis && <span className="terminal-caret" />}
                </span>
              </li>
            )
          })}
        </ol>
      </div>
      {!following && (
        <button type="button" className="terminal-jump" onClick={jumpToLatest}>
          Jump to latest ↓
        </button>
      )}
    </section>
  )
}

export function Terminal() {
  const { status, events, result, reopened } = useJob()
  const instant = usePrefersReducedMotion()
  if (status === 'idle') return null
  const model = terminalModel(events, result)
  return <TerminalView lines={model.lines} counters={reopened ? null : model.counters} instant={instant} />
}
