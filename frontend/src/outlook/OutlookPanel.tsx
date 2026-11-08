import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { Check, Circle, Inbox, ListChecks, LoaderCircle, LockKeyhole, Mail, RefreshCw, ShieldAlert, Square, X } from 'lucide-react'
import type { OutlookDriver } from './driver'
import { createOutlookSession, type OutlookSession, type OutlookState } from './session'
import { MAX_COUNT, type ReadMode, type TaskSuggestion } from './types'
import { outlookRecovery } from './recovery'
import './outlook.css'

const REASON: Record<string, string> = {
  count_reached: 'reached the number you approved',
  list_end: 'reached the end of the loaded list',
  budget: 'stopped at the scroll limit',
  timeout: 'stopped at the time limit',
  selected_message: 'read the open message',
}

function useSession(session: OutlookSession): OutlookState {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
}

function TaskCard({ task, source, total }: { task: TaskSuggestion; source?: { position: number; sender: string; time: string; subject: string }; total: number }) {
  return <article className="outlook-task">
    <h4><ListChecks size={15} aria-hidden="true" />{task.task}</h4>
    <blockquote>“{task.quote}”</blockquote>
    <p className="outlook-meta">
      {task.deadline && <span className="outlook-deadline">Due: {task.deadline}</span>}
      {source && <span>Email {source.position} of {total} · {source.sender}{source.time ? ` · ${source.time}` : ''}{source.subject ? ` · “${source.subject}”` : ''}</span>}
    </p>
  </article>
}

/** Count field that clamps on blur, so typing "5" after clearing "10" is not read as "15". */
function CountInput({ id, value, onCommit }: { id: string; value: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => { if (draft !== null) { onCommit(Number(draft) || value); setDraft(null) } }
  return <input id={id} type="number" min={1} max={MAX_COUNT} inputMode="numeric" value={draft ?? String(value)}
    onChange={(event) => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={(event) => { if (event.key === 'Enter') commit() }} />
}

function announce(state: OutlookState): string {
  if (state.phase === 'checking') return 'Looking for your shared Outlook tab'
  if (state.phase === 'running') return state.job?.steps.find((step) => step.state === 'active')?.label ?? 'Starting the Outlook read'
  if (state.phase === 'done') return `Outlook read finished: ${state.job?.result?.tasks.length ?? 0} suggested tasks`
  if (state.phase === 'cancelled') return 'Outlook read stopped'
  if (state.phase === 'error') return 'Outlook read needs attention'
  return ''
}

export function OutlookView({ state, session, onClose }: { state: OutlookState; session: OutlookSession; onClose: () => void }) {
  const id = useId()
  const root = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    // The panel opens below the conversation: bring it into view and move focus to it.
    root.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    heading.current?.focus({ preventScroll: true })
  }, [])
  const recovery = state.error ? outlookRecovery(state.error) : null
  const result = state.phase === 'done' ? state.job?.result ?? null : null
  const coverage = state.job?.coverage ?? null
  const sources = new Map(result?.emails.map((email) => [email.source_id, email]) ?? [])
  const editable = ['review', 'error', 'cancelled', 'done'].includes(state.phase) && !!state.source
  const mode = state.scope.mode
  const label = mode === 'selected' ? 'Read the open email' : `Read ${state.scope.count} ${mode === 'unread' ? 'unread ' : ''}email${state.scope.count === 1 ? '' : 's'}`

  return <section ref={root} className="outlook-panel" aria-labelledby={`${id}-title`}>
    {state.demo && <p className="outlook-demo" role="note"><ShieldAlert size={14} aria-hidden="true" />DEMO INBOX · fake people and companies · not your Outlook</p>}
    <header>
      <span className="outlook-icon"><Mail size={17} aria-hidden="true" /></span>
      <div><h3 id={`${id}-title`} ref={heading} tabIndex={-1}>Outlook · read-only</h3>
        <p className="outlook-source">{state.source
          ? <><span className="outlook-dot" />Shared tab: {state.source.origin.replace('https://', '')}{state.source.accountLabel ? ` · ${state.source.accountLabel}` : ''}</>
          : 'No Outlook tab shared'}</p></div>
      <button type="button" className="voice-icon" onClick={onClose} aria-label="Close Outlook request and clear results"><X size={16} aria-hidden="true" /></button>
    </header>

    <p className="outlook-request"><span>You asked</span>{state.request}</p>

    {state.phase === 'checking' && <p role="status" className="outlook-hint"><LoaderCircle size={14} className="outlook-spin" aria-hidden="true" />Looking for the Latent extension and your shared tab…</p>}

    {editable && <fieldset className="outlook-scope" disabled={!editable}>
      <legend>What Latent will read</legend>
      <label htmlFor={`${id}-mode`}>Messages</label>
      <select id={`${id}-mode`} value={mode} onChange={(event) => session.setScope({ mode: event.target.value as ReadMode, count: state.scope.count })}>
        <option value="latest">Latest in the list</option>
        <option value="unread">Unread only</option>
        <option value="selected">Only the email I have open</option>
      </select>
      {mode !== 'selected' && <><label htmlFor={`${id}-count`}>How many (max {MAX_COUNT})</label>
        <CountInput id={`${id}-count`} value={state.scope.count} onCommit={(count) => session.setScope({ mode, count })} /></>}
      <p className="outlook-hint">{mode === 'selected'
        ? 'Reads only the message already open in your reading pane. Opening it in Outlook may already have marked it read.'
        : 'Reads the sender, time, subject and preview shown in the list. Latent does not open messages, so it does not mark them read. Scrolling may make Outlook load more mail from Microsoft.'}</p>
      <p className="outlook-hint"><LockKeyhole size={11} aria-hidden="true" /> Analysis runs on this device. Email text is never saved, logged or web-searched. No sending, replying, deleting or link opening.</p>
    </fieldset>}

    {(state.phase === 'running' || state.job) && <ol className="outlook-steps" aria-label="Outlook work steps">
      {(state.job?.steps ?? [{ key: 'source', label: 'Selecting your authorized tab', boundary: 'local', state: 'active' }]).map((step) => {
        const Icon = step.state === 'active' ? LoaderCircle : step.state === 'done' ? Check : step.state === 'error' ? X : Circle
        return <li key={step.key} className={`is-${step.state}`}>
          <Icon size={14} aria-hidden="true" className={step.state === 'active' ? 'outlook-spin' : ''} />
          <span>{step.label}</span>
          <span className={`chat-tag ${step.boundary === 'browser' ? 'net' : 'local'}`}>{step.boundary === 'browser' ? 'INTERNET · BROWSER' : 'LOCAL'}</span>
        </li>
      })}
    </ol>}

    {recovery && <div className="outlook-error" role="alert"><p>{recovery.title}</p>
      {recovery.action === 'setup' && <button type="button" className="voice-secondary" onClick={() => { void session.check() }}><RefreshCw size={14} aria-hidden="true" />Check again</button>}
    </div>}
    {state.phase === 'cancelled' && !state.error && <p className="outlook-hint" role="status">Stopped. Anything read for this request was cleared.</p>}

    {result && <div className="outlook-results">
      {coverage && <p className="outlook-coverage" role="status">
        <Inbox size={14} aria-hidden="true" />Inspected {coverage.inspected} of {coverage.requested} requested
        {coverage.examined !== undefined && coverage.examined !== coverage.inspected && <> ({coverage.examined} list rows examined)</>}
        {' '}· {REASON[coverage.reason] ?? coverage.reason}
        {coverage.partial && <strong> · partial: not every requested message was read</strong>}
        {' '}· this is not the whole inbox
      </p>}
      {result.tasks.length > 0 && <div className="outlook-tasks" role="region" aria-label="Suggested tasks">
        {result.tasks.map((task) => <TaskCard key={task.id} task={task} source={sources.get(task.source_id)} total={result.emails.length} />)}
      </div>}
      {result.tasks.length === 0 && <p className="outlook-hint">No explicit requests or deadlines were found in what was read.</p>}
      <details className="outlook-emails" open={result.tasks.length === 0}>
        <summary>{result.emails.length} email summar{result.emails.length === 1 ? 'y' : 'ies'}</summary>
        <ul>{result.emails.map((email) => <li key={email.source_id} className={email.flagged_instructions ? 'is-flagged' : ''}>
          <span className="outlook-meta">{email.position}. {email.sender}{email.time ? ` · ${email.time}` : ''}{email.unread ? ' · unread' : ''}</span>
          <strong>{email.subject || '(no subject)'}</strong>
          <span>{email.summary}</span>
          {email.flagged_instructions && <span className="outlook-flag"><ShieldAlert size={12} aria-hidden="true" />This message contains instructions aimed at an assistant. Latent treated them as text and did not act on them.</span>}
        </li>)}</ul>
      </details>
      {result.dropped_claims > 0 && <p className="outlook-hint">{result.dropped_claims} unsupported claim{result.dropped_claims === 1 ? ' was' : 's were'} dropped because no matching quote was found.</p>}
      {state.job && <p className="outlook-receipt"><LockKeyhole size={11} aria-hidden="true" /> Receipt: browser read {state.job.receipt.browser_reads} message{state.job.receipt.browser_reads === 1 ? '' : 's'} from your shared tab · {state.job.receipt.local_model_calls ? 'analyzed by the local model' : state.demo ? 'demo analysis' : 'analyzed on this device'} · requests from Latent to Tavily/Exa: {state.job.receipt.backend_internet_requests} · saved: nothing.</p>}
    </div>}

    <span className="visually-hidden" role="status" aria-live="polite">{announce(state)}</span>
    <div className="voice-actions outlook-actions">
      {state.phase === 'running'
        ? <button type="button" className="voice-secondary" onClick={() => { void session.cancel() }}><Square size={13} fill="currentColor" aria-hidden="true" />Stop</button>
        : editable && <button type="button" className="voice-primary" onClick={() => { void session.confirm() }}><Mail size={15} aria-hidden="true" />{state.phase === 'done' ? `Read again · ${label.toLowerCase()}` : label}</button>}
      {state.source && !state.demo && state.phase !== 'running' && <button type="button" className="voice-link" onClick={() => { void session.forget() }}>Stop sharing tab</button>}
      <span className="voice-spacer" />
      <button type="button" className="voice-link" onClick={onClose}>{result ? 'Clear and close' : 'Cancel'}</button>
    </div>
  </section>
}

export interface OutlookPanelProps { request: string; driver: OutlookDriver; offline: boolean; onClose: () => void }

export function OutlookPanel({ request, driver, offline, onClose }: OutlookPanelProps) {
  const [session] = useState(() => createOutlookSession(driver, request))
  useEffect(() => { session.setOffline(offline) }, [session, offline])
  const state = useSession(session)
  useEffect(() => {
    void session.check()
    return () => { void session.dispose() }
  }, [session])
  return <OutlookView state={state} session={session} onClose={onClose} />
}
export default OutlookPanel
