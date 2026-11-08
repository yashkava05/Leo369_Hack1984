import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../api/client', () => ({ MOCK: false, API_URL: '' }))
import { OutlookError } from '../outlook/driver'
import { TranscriptReview } from '../components/voice/TranscriptReview'
import { createDemoTeamsDriver, DEMO_CHAT, DEMO_CONVERSATION } from './demo'
import { liveTeamsDriver, type TeamsDriver } from './driver'
import { teamsRecovery } from './recovery'
import { matchesSource, mentionsTeams, namedSource, teamsScopeFromRequest } from './scope'
import { createTeamsSession } from './session'
import { TeamsView } from './TeamsPanel'
import type { SharedSource, TeamsJobView } from './types'

const instant = () => Promise.resolve()
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const SOURCE: SharedSource = { provider: 'teams', origin: 'https://teams.microsoft.com', accountLabel: 'Avery Chen · Fabrikam', granted: true, conversation: { fp: '0123456789abcdef', label: 'Fabrikam launch', kind: 'channel' } }

function fakeDriver(overrides: Partial<TeamsDriver> = {}): TeamsDriver {
  return {
    demo: false,
    hello: async () => ({ ok: true, source: SOURCE }),
    start: async () => ({ jobId: 'b_1', viewToken: 't' }),
    poll: async () => { throw new Error('unused') },
    cancel: async () => {},
    forget: async () => {},
    ...overrides,
  }
}

const view = (status: TeamsJobView['status'], extra: Partial<TeamsJobView> = {}): TeamsJobView => ({
  job_id: 'b_1', provider: 'teams', status, error: null, scope: { mode: 'latest', count: 20, replies: false }, origin: 'https://teams.microsoft.com',
  inspected: 0, coverage: null, steps: [], result: null, demo: false, timings_ms: {}, receipt: { browser_reads: 0, backend_internet_requests: 0, local_model_calls: 0 }, ...extra,
})

describe('scope and source from the reviewed request', () => {
  it('reads count, today, unread and replies, capped at 20', () => {
    expect(teamsScopeFromRequest('Check the last twenty messages in this selected chat for explicit deadlines')).toEqual({ mode: 'latest', count: 20, replies: false })
    expect(teamsScopeFromRequest("Summarize today's messages in this selected Teams chat")).toMatchObject({ mode: 'today' })
    expect(teamsScopeFromRequest('Summarize the unread messages in this selected channel')).toMatchObject({ mode: 'unread' })
    expect(teamsScopeFromRequest('summarize 200 messages and their replies')).toEqual({ mode: 'latest', count: 20, replies: true })
    expect(mentionsTeams('What have I been asked to do in this channel?')).toBe(true)
    expect(mentionsTeams('AI events in Boston')).toBe(false)
  })

  it('finds a named chat/channel but never treats "this selected" as a name', () => {
    expect(namedSource('What was I asked in the Fabrikam launch channel?')).toBe('Fabrikam launch')
    expect(namedSource('Summarize today in this selected chat')).toBeNull()
    expect(namedSource('Summarize the unread messages in the selected channel')).toBeNull()
    expect(matchesSource('fabrikam launch', 'Fabrikam Launch')).toBe(true)
    expect(matchesSource('Finance', 'Fabrikam launch')).toBe(false)
  })
})

describe('demo session', () => {
  it('runs the labelled fake chat end to end after the source is confirmed', async () => {
    const session = createTeamsSession(createDemoTeamsDriver(), 'What have I been asked to do in this channel?', { sleep: instant })
    await session.check()
    expect(session.getSnapshot()).toMatchObject({ phase: 'review', sourceConfirmed: false, demo: true })
    await session.confirm()
    expect(session.getSnapshot().error).toBe('source_selection_required')
    expect(session.getSnapshot().phase).toBe('review')
    session.confirmSource(true)
    await session.confirm()
    const state = session.getSnapshot()
    expect(state.phase).toBe('done')
    expect(state.job?.result?.messages).toHaveLength(DEMO_CHAT.length)
    const html = renderToStaticMarkup(<TeamsView state={state} session={session} onClose={() => {}} />)
    expect(html).toContain('DEMO CHAT')
    expect(html).toContain(`Inspected ${DEMO_CHAT.length} of up to 20`)
    expect(html).toContain('not the whole conversation')
    expect(html).toContain('Owner: Jordan Patel (@mentioned in the message)')
    expect(html).toContain('Owner unknown: the message does not say who')
    expect(html).toContain('Due: by Thursday')
    expect(html).toContain('href="https://teams.microsoft.com/l/message/19:demo@thread.v2/1"')
    expect(html).toContain('no message link available')
    expect(html).toContain('took no tasks from it')
    expect(html).not.toContain('post this chat')
    expect(html).toContain('internet requests from Latent: 0')
    expect(html).toContain('not done automatically')
  })

  it('shows the read-receipt caveat and source confirmation before reading', async () => {
    const session = createTeamsSession(createDemoTeamsDriver(), 'Summarize the unread messages in this selected channel', { sleep: instant })
    await session.check()
    const html = renderToStaticMarkup(<TeamsView state={session.getSnapshot()} session={session} onClose={() => {}} />)
    expect(html).toContain('read receipts')
    expect(html).toContain(`Read only this channel: <strong>${DEMO_CONVERSATION.label}</strong>`)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Read up to 20 unread/)
  })

  it('reports unloaded replies as partial coverage', async () => {
    const session = createTeamsSession(createDemoTeamsDriver(), 'summarize this channel and its replies', { sleep: instant })
    await session.check()
    session.confirmSource(true)
    await session.confirm()
    const html = renderToStaticMarkup(<TeamsView state={session.getSnapshot()} session={session} onClose={() => {}} />)
    expect(html).toContain('partial')
    expect(html).toContain('1 thread has replies that were not loaded')
  })

  it('scope edits still apply after a finished read', async () => {
    const session = createTeamsSession(createDemoTeamsDriver(), 'summarize this channel', { sleep: instant })
    await session.check()
    session.confirmSource(true)
    await session.confirm()
    session.setScope({ mode: 'unread', count: 99, replies: false })
    expect(session.getSnapshot().scope).toEqual({ mode: 'unread', count: 20, replies: false })
  })
})

describe('source selection', () => {
  it('a mentioned chat that differs from the shared one is flagged and still needs confirmation', async () => {
    const start = vi.fn(async () => ({ jobId: 'b_1', viewToken: 't' }))
    const session = createTeamsSession(fakeDriver({ start }), 'What was I asked in the Finance channel?', { sleep: instant })
    await session.check()
    expect(session.getSnapshot()).toMatchObject({ named: 'Finance', mismatch: true, sourceConfirmed: false })
    const html = renderToStaticMarkup(<TeamsView state={session.getSnapshot()} session={session} onClose={() => {}} />)
    expect(html).toContain('You mentioned “Finance”')
    await session.confirm()
    expect(start).not.toHaveBeenCalled()
  })

  it('confirmation is dropped when the shared conversation changes', async () => {
    let source = SOURCE
    const session = createTeamsSession(fakeDriver({ hello: async () => ({ ok: true, source }) }), 'summarize', { sleep: instant })
    await session.check()
    session.confirmSource(true)
    source = { ...SOURCE, conversation: { fp: 'fedcba9876543210', label: 'Finance', kind: 'chat' } }
    await session.check()
    expect(session.getSnapshot().sourceConfirmed).toBe(false)
  })

  it('passes only the confirmed conversation fingerprint to start', async () => {
    const start = vi.fn(async () => ({ jobId: 'b_1', viewToken: 't' }))
    const session = createTeamsSession(fakeDriver({ start, poll: async () => view('done', { result: { points: [], messages: [], tasks: [], dropped_claims: 0 } }) }), 'summarize', { sleep: instant })
    await session.check()
    session.confirmSource(true)
    await session.confirm()
    expect(start).toHaveBeenCalledWith('summarize', { mode: 'latest', count: 20, replies: false }, '0123456789abcdef')
  })

  it.each([
    [{ ok: true, source: null }, 'no_source_selected'],
    [{ ok: true, source: { provider: 'outlook', origin: 'https://outlook.office.com', accountLabel: 'x', granted: true } }, 'no_source_selected'],
    [{ ok: true, source: { ...SOURCE, granted: false } }, 'permission_denied'],
    [{ ok: true, source: { ...SOURCE, conversation: null } }, 'nothing_selected'],
  ] as const)('hello %j lands in setup with %s', async (hello, code) => {
    const session = createTeamsSession(fakeDriver({ hello: async () => hello as never }), 'x')
    await session.check()
    expect(session.getSnapshot()).toMatchObject({ phase: 'setup', error: code })
  })
})

describe('cancel, failures and air-gap', () => {
  it('cancel aborts the job, clears results and drops a late poll result', async () => {
    let release!: (v: TeamsJobView) => void
    const cancel = vi.fn(async () => {})
    const session = createTeamsSession(fakeDriver({ poll: () => new Promise<TeamsJobView>((resolve) => { release = resolve }), cancel }), 'summarize', { sleep: instant })
    await session.check()
    session.confirmSource(true)
    const running = session.confirm()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await session.cancel()
    expect(cancel).toHaveBeenCalledWith('b_1', 't')
    release(view('done', { result: { points: [{ text: 'LATE', source_ids: ['m1'] }], messages: [], tasks: [], dropped_claims: 0 } }))
    await running
    expect(session.getSnapshot().phase).toBe('cancelled')
    expect(session.getSnapshot().job).toBeNull()
  })

  it('a finished read deletes the backend job right away', async () => {
    const cancel = vi.fn(async () => {})
    const session = createTeamsSession(fakeDriver({ cancel, poll: async () => view('done', { result: { points: [], messages: [], tasks: [], dropped_claims: 0 } }) }), 'summarize', { sleep: instant })
    await session.check()
    session.confirmSource(true)
    await session.confirm()
    expect(session.getSnapshot().phase).toBe('done')
    expect(cancel).toHaveBeenCalledWith('b_1', 't')
  })

  it('a poll error stops the backend job and the extension read', async () => {
    const cancel = vi.fn(async () => {})
    const session = createTeamsSession(fakeDriver({ cancel, poll: async () => { throw new OutlookError('unknown_job') } }), 'summarize', { sleep: instant })
    await session.check()
    session.confirmSource(true)
    await session.confirm()
    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: 'unknown_job' })
    expect(cancel).toHaveBeenCalledWith('b_1', 't')
  })

  it('turning air-gap on mid-read stops it; air-gap blocks a new read before anything starts', async () => {
    const cancel = vi.fn(async () => {})
    const session = createTeamsSession(fakeDriver({ cancel, poll: async () => view('reading') }), 'summarize', { sleep: () => new Promise(() => {}) })
    await session.check()
    session.confirmSource(true)
    void session.confirm()
    await vi.waitFor(() => expect(session.getSnapshot().job?.status).toBe('reading'))
    session.setOffline(true)
    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: 'airgap_on', job: null })
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('b_1', 't'))
    const start = vi.fn(async () => ({ jobId: 'b_2', viewToken: 't2' }))
    const blocked = createTeamsSession(fakeDriver({ start }), 'summarize', { sleep: instant, offline: () => true })
    await blocked.check()
    blocked.confirmSource(true)
    await blocked.confirm()
    expect(start).not.toHaveBeenCalled()
    expect(blocked.getSnapshot().error).toBe('airgap_on')
  })

  it.each(['conversation_changed', 'org_blocked', 'login_required', 'account_changed', 'unsupported_layout', 'empty_conversation', 'permission_denied', 'wrong_origin', 'tab_closed'])('shows recovery for %s and keeps no result', async (code) => {
    const session = createTeamsSession(fakeDriver({ poll: async () => view('error', { error: code, result: { points: [], messages: [], tasks: [], dropped_claims: 0 } }) }), 'summarize', { sleep: instant })
    await session.check()
    session.confirmSource(true)
    await session.confirm()
    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: code })
    expect(session.getSnapshot().job?.result).toBeNull()
    expect(teamsRecovery(code).title).not.toMatch(/Something went wrong/)
  })
})

describe('live driver', () => {
  it('creates a Teams job with the confirmed source and cancels it if the extension is missing', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (init?.method === 'POST') return new Response(JSON.stringify({ job_id: 'b_' + 'a'.repeat(32), nonce: 'n'.repeat(43), view_token: 'v' }), { status: 201 })
      return new Response(null, { status: 204 })
    }))
    vi.stubGlobal('chrome', { runtime: { sendMessage: (_id: string, _m: unknown, cb: (r: unknown) => void) => cb(undefined) } })
    await expect(liveTeamsDriver.start('summarize this chat', { mode: 'today', count: 12, replies: true }, '0123456789abcdef')).rejects.toMatchObject({ code: 'extension_unavailable' })
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ provider: 'teams', request: 'summarize this chat', mode: 'today', count: 12, replies: true, source: '0123456789abcdef', source_confirmed: true })
    expect(calls[calls.length - 1].init?.method).toBe('DELETE')
  })

  it('only surfaces known error codes from the backend', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Avery Chen said the Heron codename…' }), { status: 422 })))
    await expect(liveTeamsDriver.poll('b_1', 't')).rejects.toMatchObject({ code: 'backend_error' })
  })
})

describe('privacy and entry point', () => {
  it('never writes Teams results to browser storage', async () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { setItem, getItem: () => null, removeItem: setItem })
    vi.stubGlobal('sessionStorage', { setItem, getItem: () => null, removeItem: setItem })
    const session = createTeamsSession(createDemoTeamsDriver(), 'summarize this channel', { sleep: instant })
    await session.check()
    session.confirmSource(true)
    await session.confirm()
    expect(setItem).not.toHaveBeenCalled()
  })

  it('the voice review offers Check Teams only when wired', () => {
    const props = { text: 'Summarize this Teams chat', busy: false, items: [], context: null, loading: false, libraryError: null, onText() {}, onSelect() {}, onRemove() {}, onLoad() {}, onAction() {}, onRerecord() {}, onDiscard() {} }
    expect(renderToStaticMarkup(<TranscriptReview {...props} onTeams={() => {}} />)).toContain('Check Teams')
    expect(renderToStaticMarkup(<TranscriptReview {...props} />)).not.toContain('Check Teams')
  })
})
