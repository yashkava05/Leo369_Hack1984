import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { Check, Circle, ExternalLink, ListChecks, LoaderCircle, LockKeyhole, MessagesSquare, RefreshCw, ShieldAlert, Square, UserRound, X } from 'lucide-react'
import type { TeamsDriver } from './driver'
import { createTeamsSession, type TeamsSession, type TeamsState } from './session'
import { clampCount } from './scope'
import { MAX_COUNT, type TeamsMessageSummary, type TeamsMode, type TeamsTask } from './types'
import { teamsRecovery } from './recovery'
import '../outlook/outlook.css'
import './teams.css'

const REASON: Record<string, string> = {
  count_reached: 'reached the number you approved',
  list_end: 'reached the start of the loaded history',
  budget: 'stopped at the scroll limit',
  timeout: 'stopped at the time limit',
  window_end: 'reached the start of today',
  unread_end: 'reached the “New messages” divider',
}

function useSession(session: TeamsSession): TeamsState {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
}

/** Where a message came from: Teams' own permalink if it rendered one, else an honest locator. */
function Locator({ message, label }: { message?: TeamsMessageSummary; label: string }) {
  if (!message) return null
  const where = `${label} · ${message.author || 'author not shown'}${message.time ? ` · ${message.time}` : ''}${message.is_reply ? ' · reply' : ''}`
  return message.link
    ? <a className="teams-locator" href={message.link} target="_blank" rel="noreferrer noopener"><ExternalLink size={11} aria-hidden="true" />{where}</a>
    : <span className="teams-locator">{where} · no message link available</span>
}

function TaskCard({ task, source, label }: { task: TeamsTask; source?: TeamsMessageSummary; label: string }) {
  return <article className="outlook-task">
    <h4><ListChecks size={15} aria-hidden="true" />{task.task}</h4>
    <blockquote>“{task.quote}”</blockquote>
    <p className="outlook-meta">
      <span className={task.owner ? 'teams-owner' : 'teams-owner is-unknown'}><UserRound size={11} aria-hidden="true" />
        {task.owner ? `Owner: ${task.owner} (${task.owner_basis === 'mentioned' ? '@mentioned' : 'named'} in the message)` : 'Owner unknown: the message does not say who'}</span>
      {task.deadline && <span className="outlook-deadline">Due: {task.deadline}</span>}
    </p>
    <p className="outlook-meta"><Locator message={source} label={label} /></p>
  </article>
}

export function TeamsView({ state, session, onClose }: { state: TeamsState; session: TeamsSession; onClose: () => void }) {
  const id = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const recovery = state.error ? teamsRecovery(state.error) : null
  const result = state.phase === 'done' ? state.job?.result ?? null : null
  const coverage = state.phase === 'done' ? state.job?.coverage ?? null : null
  const conversation = state.source?.conversation ?? null
  const label = conversation?.label ?? 'Teams'
  const sources = new Map(result?.messages.map((message) => [message.source_id, message]) ?? [])
  const editable = ['review', 'error', 'cancelled', 'done'].includes(state.phase) && !!conversation
  const [countDraft, setCountDraft] = useState<string | null>(null)
  const { mode, count, replies } = state.scope
  const action = mode === 'unread' ? `Read up to ${count} unread` : mode === 'today' ? `Read today’s (up to ${count})` : `Read the last ${count}`
  const receipt = state.job?.receipt

  useEffect(() => {
    heading.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    heading.current?.focus({ preventScroll: true })
  }, [])

  return <section className="outlook-panel teams-panel" aria-labelledby={`${id}-title`}>
    {state.demo && <p className="outlook-demo" role="note"><ShieldAlert size={14} aria-hidden="true" />DEMO CHAT · fake people and companies · not your Teams</p>}
    <header>
      <span className="outlook-icon"><MessagesSquare size={17} aria-hidden="true" /></span>
      <div><h3 id={`${id}-title`} ref={heading} tabIndex={-1}>Teams · read-only</h3>
        <p className="outlook-source">{state.source && state.source.provider === 'teams'
          ? <><span className="outlook-dot" />Teams web: {state.source.origin.replace('https://', '')}{state.source.accountLabel ? ` · ${state.source.accountLabel}` : ''}</>
          : 'No Teams chat shared'}</p></div>
      <button type="button" className="voice-icon" onClick={onClose} aria-label="Close Teams request and clear results"><X size={16} aria-hidden="true" /></button>
    </header>

    <p className="outlook-request"><span>You asked</span>{state.request}</p>

    {state.phase === 'checking' && <p role="status" className="outlook-hint"><LoaderCircle size={14} className="outlook-spin" aria-hidden="true" />Looking for the PrismLocal extension and your shared Teams chat…</p>}

    {editable && conversation && <fieldset className="outlook-scope teams-scope">
      <legend>What PrismLocal will read</legend>
      <div className="teams-source">
        {state.mismatch && state.named && <p className="teams-mismatch" role="alert">You mentioned “{state.named}”, but the shared {conversation.kind} is “{conversation.label}”. PrismLocal will not search for another conversation: confirm this one, or open the right one in Teams, share it from the extension icon and check again.</p>}
        <label className="teams-confirm">
          <input type="checkbox" checked={state.sourceConfirmed} onChange={(event) => session.confirmSource(event.target.checked)} />
          <span>Read only this {conversation.kind}: <strong>{conversation.label}</strong></span>
        </label>
      </div>
      <label htmlFor={`${id}-mode`}>Messages</label>
      <select id={`${id}-mode`} value={mode} onChange={(event) => session.setScope({ mode: event.target.value as TeamsMode, count, replies })}>
        <option value="latest">Most recent</option>
        <option value="today">Today only</option>
        <option value="unread">Unread only</option>
      </select>
      <label htmlFor={`${id}-count`}>At most (max {MAX_COUNT})</label>
      <input id={`${id}-count`} type="number" inputMode="numeric" min={1} max={MAX_COUNT} value={countDraft ?? String(count)}
        onChange={(event) => setCountDraft(event.target.value)}
        onBlur={() => { if (countDraft !== null) session.setScope({ mode, count: clampCount(Number(countDraft)), replies }); setCountDraft(null) }} />
      {conversation.kind === 'channel' && <label className="teams-replies"><input type="checkbox" checked={replies} onChange={(event) => session.setScope({ mode, count, replies: event.target.checked })} />Include thread replies that are already expanded (they count toward the limit)</label>}
      <p className="outlook-hint">Reads the author, time and text shown in this {conversation.kind}, newest first, and scrolls back when done. PrismLocal never posts, replies, reacts, expands threads, opens links or files, or switches chats.</p>
      <p className="outlook-hint teams-caveat"><ShieldAlert size={11} aria-hidden="true" /> Teams may mark messages read or send read receipts while a conversation is open or scrolled, depending on your settings. PrismLocal cannot promise a silent read.</p>
      <p className="outlook-hint"><LockKeyhole size={11} aria-hidden="true" /> Analysis runs on this device. Chat text is never saved, logged or web-searched.</p>
    </fieldset>}

    <div aria-live="polite">
      {(state.phase === 'running' || state.job) && <ol className="outlook-steps" aria-label="Teams work steps">
        {(state.job?.steps ?? [{ key: 'source', label: 'Selecting your authorized tab', boundary: 'local', state: 'active' }]).map((step) => {
          const Icon = step.state === 'active' ? LoaderCircle : step.state === 'done' ? Check : step.state === 'error' ? X : Circle
          return <li key={step.key} className={`is-${step.state}`}>
            <Icon size={14} aria-hidden="true" className={step.state === 'active' ? 'outlook-spin' : ''} />
            <span>{step.label}</span>
            <span className={`chat-tag ${step.boundary === 'browser' ? 'net' : 'local'}`}>{step.boundary === 'browser' ? 'INTERNET · BROWSER' : 'LOCAL'}</span>
          </li>
        })}
      </ol>}
    </div>

    {recovery && <div className="outlook-error" role="alert"><p>{recovery.title}</p>
      {recovery.action === 'setup' && <button type="button" className="voice-secondary" onClick={() => { void session.check() }}><RefreshCw size={14} aria-hidden="true" />Check again</button>}
    </div>}
    {state.phase === 'cancelled' && !state.error && <p className="outlook-hint" role="status">Stopped. Anything read for this request was cleared.</p>}

    {result && <div className="outlook-results">
      {coverage && <p className="outlook-coverage" role="status">
        Inspected {coverage.inspected} of up to {coverage.requested} in “{label}” · {REASON[coverage.reason] ?? coverage.reason}
        {coverage.partial && <strong> · partial: not everything in scope was read</strong>}
        {coverage.replies === 'incomplete' && <strong> · {coverage.collapsed_threads} thread{coverage.collapsed_threads === 1 ? ' has' : 's have'} replies that were not loaded</strong>}
        {coverage.skipped_undated > 0 && <strong> · {coverage.skipped_undated} message{coverage.skipped_undated === 1 ? '' : 's'} without a date skipped</strong>}
        {' '}· this is not the whole conversation
      </p>}
      {result.points.length > 0 && <div role="region" aria-label="Summary"><h4 className="teams-h">Summary</h4>
        <ul className="teams-points">{result.points.map((point, index) => <li key={index}>{point.text} <span className="outlook-meta">{point.source_ids.map((sid) => `#${sources.get(sid)?.position ?? '?'}`).join(', ')}</span></li>)}</ul></div>}
      {result.tasks.length > 0 && <div className="outlook-tasks" role="region" aria-label="Suggested tasks"><h4 className="teams-h">Suggested tasks · not done automatically</h4>
        {result.tasks.map((task) => <TaskCard key={task.id} task={task} source={sources.get(task.source_id)} label={label} />)}
      </div>}
      {result.tasks.length === 0 && <p className="outlook-hint">No explicit requests or deadlines were found in what was read.</p>}
      <details className="outlook-emails" open={result.tasks.length === 0}>
        <summary>{result.messages.length} message{result.messages.length === 1 ? '' : 's'} read</summary>
        <ul>{result.messages.map((message) => <li key={message.source_id} className={message.flagged_instructions ? 'is-flagged' : ''}>
          <span className="outlook-meta">#{message.position} · {message.author || 'author not shown'}{message.time ? ` · ${message.time}` : ''}{message.is_reply ? ' · reply' : ''}{message.unread ? ' · unread' : ''}{message.needs_response ? ' · may need a response' : ''}</span>
          {!message.flagged_instructions && <span>{message.excerpt}</span>}
          {message.flagged_instructions && <span className="outlook-flag"><ShieldAlert size={12} aria-hidden="true" />This message contains instructions aimed at an assistant. PrismLocal treated it as text, did not act on it and took no tasks from it.</span>}
          <Locator message={message} label={label} />
        </li>)}</ul>
      </details>
      {result.dropped_claims > 0 && <p className="outlook-hint">{result.dropped_claims} unsupported claim{result.dropped_claims === 1 ? ' was' : 's were'} dropped because the messages did not support them.</p>}
      {receipt && <p className="outlook-receipt"><LockKeyhole size={11} aria-hidden="true" /> Receipt: browser read {receipt.browser_reads} message{receipt.browser_reads === 1 ? '' : 's'} from your shared tab · local model calls: {receipt.local_model_calls} · internet requests from PrismLocal: {receipt.backend_internet_requests} · saved: nothing.</p>}
    </div>}

    <div className="voice-actions outlook-actions teams-actions">
      {state.phase === 'running'
        ? <button type="button" className="voice-secondary" onClick={() => { void session.cancel() }}><Square size={13} fill="currentColor" aria-hidden="true" />Stop</button>
        : editable && <button type="button" className="voice-primary" disabled={!state.sourceConfirmed} onClick={() => { void session.confirm() }}><MessagesSquare size={15} aria-hidden="true" />{state.phase === 'done' ? 'Read again' : action}</button>}
      {state.source && !state.demo && state.phase !== 'running' && <button type="button" className="voice-link" onClick={() => { void session.forget() }}>Stop sharing tab</button>}
      <span className="voice-spacer" />
      <button type="button" className="voice-link" onClick={onClose}>{result ? 'Clear and close' : 'Cancel'}</button>
    </div>
  </section>
}

export interface TeamsPanelProps { request: string; driver: TeamsDriver; offline: boolean; onClose: () => void }

export function TeamsPanel({ request, driver, offline, onClose }: TeamsPanelProps) {
  const [session] = useState(() => createTeamsSession(driver, request))
  useEffect(() => { session.setOffline(offline) }, [session, offline])
  const state = useSession(session)
  useEffect(() => {
    void session.check()
    return () => { void session.dispose() }
  }, [session])
  return <TeamsView state={state} session={session} onClose={onClose} />
}
export default TeamsPanel
