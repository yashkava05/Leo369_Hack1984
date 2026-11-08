import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../api/client', () => ({ MOCK: false, API_URL: '' }))
import { createDemoDriver, DEMO_INBOX } from './demo'
import { EXTENSION_ID, liveDriver, OutlookError, sendToExtension, type OutlookDriver } from './driver'
import { OutlookView } from './OutlookPanel'
import { outlookRecovery } from './recovery'
import { mentionsMail, scopeFromRequest } from './scope'
import { createOutlookSession } from './session'
import { TranscriptReview } from '../components/voice/TranscriptReview'
import type { BrowserJobView } from './types'

const instant = () => Promise.resolve()
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('scope from the reviewed request', () => {
  it('reads count, unread and selected modes and clamps to 20', () => {
    expect(scopeFromRequest('Check my latest ten Outlook emails and tell me what needs my attention')).toEqual({ mode: 'latest', count: 10 })
    expect(scopeFromRequest('Summarize unread emails in this inbox and list any deadlines')).toEqual({ mode: 'unread', count: 10 })
    expect(scopeFromRequest('Open this selected email and tell me what I have been asked to do')).toEqual({ mode: 'selected', count: 1 })
    expect(scopeFromRequest('summarize my last 200 emails').count).toBe(20)
    expect(scopeFromRequest('check 3 new messages').count).toBe(3)
    expect(mentionsMail('anything in my inbox?')).toBe(true)
    expect(mentionsMail('AI events in Boston')).toBe(false)
  })
})

describe('demo session', () => {
  it('runs the labelled fake inbox end to end within the approved scope', async () => {
    const session = createOutlookSession(createDemoDriver(), 'Check my latest 4 emails', { sleep: instant })
    await session.check()
    expect(session.getSnapshot().phase).toBe('review')
    expect(session.getSnapshot().demo).toBe(true)
    await session.confirm()
    const state = session.getSnapshot()
    expect(state.phase).toBe('done')
    expect(state.job?.result?.emails).toHaveLength(4)
    expect(state.job?.coverage?.inspected).toBe(4)
    for (const task of state.job?.result?.tasks ?? []) expect(['m1', 'm2', 'm3', 'm4']).toContain(task.source_id)
    const html = renderToStaticMarkup(<OutlookView state={state} session={session} onClose={() => {}} />)
    expect(html).toContain('DEMO INBOX')
    expect(html).toContain('Inspected 4 of 4')
    expect(html).toContain('not the whole inbox')
    expect(html).toContain('“Please review the Northwind Fabrics contract by Friday.”')
    expect(html).toContain('Email 1 of 4')
    expect(html).toContain('did not act on them')
    expect(html).toContain('requests from PrismLocal to Tavily/Exa: 0')
    expect(html).toContain('demo analysis')
  })

  it('reports partial coverage when the list is shorter than the request', async () => {
    const session = createOutlookSession(createDemoDriver(), 'Summarize unread emails', { sleep: instant })
    await session.check()
    session.setScope({ mode: 'unread', count: 20 })
    await session.confirm()
    const coverage = session.getSnapshot().job?.coverage
    expect(coverage?.partial).toBe(true)
    expect(coverage?.inspected).toBe(DEMO_INBOX.filter((email) => email.unread).length)
    const html = renderToStaticMarkup(<OutlookView state={session.getSnapshot()} session={session} onClose={() => {}} />)
    expect(html).toContain('partial')
  })

  it('air-gap blocks the read before anything starts', async () => {
    const driver = createDemoDriver()
    const start = vi.spyOn(driver, 'start')
    const session = createOutlookSession(driver, 'check my email', { sleep: instant, offline: () => true })
    await session.check()
    await session.confirm()
    expect(start).not.toHaveBeenCalled()
    expect(session.getSnapshot().error).toBe('airgap_on')
    expect(outlookRecovery('airgap_on').title).toContain('Air-gap is on')
  })

  it('caps edits to the scope', async () => {
    const session = createOutlookSession(createDemoDriver(), 'check my email', { sleep: instant })
    await session.check()
    session.setScope({ mode: 'latest', count: 99 })
    expect(session.getSnapshot().scope.count).toBe(20)
    session.setScope({ mode: 'selected', count: 7 })
    expect(session.getSnapshot().scope).toEqual({ mode: 'selected', count: 1 })
  })
})

function fakeDriver(overrides: Partial<OutlookDriver> = {}): OutlookDriver {
  return {
    demo: false,
    hello: async () => ({ ok: true, source: { provider: 'outlook', origin: 'https://outlook.office.com', accountLabel: 'Priya Raman', granted: true } }),
    start: async () => ({ jobId: 'b_1', viewToken: 't' }),
    poll: async () => { throw new Error('unused') },
    cancel: async () => {},
    forget: async () => {},
    ...overrides,
  }
}

const view = (status: BrowserJobView['status'], extra: Partial<BrowserJobView> = {}): BrowserJobView => ({
  job_id: 'b_1', provider: 'outlook', status, error: null, scope: { mode: 'latest', count: 10 }, origin: 'https://outlook.office.com',
  inspected: 0, coverage: null, steps: [], result: null, demo: false, timings_ms: {}, receipt: { browser_reads: 0, backend_internet_requests: 0, local_model_calls: 0 }, ...extra,
})

describe('cancel and failures', () => {
  it('cancel aborts the job, clears results and drops a late poll result', async () => {
    let release!: (v: BrowserJobView) => void
    const cancel = vi.fn(async () => {})
    const driver = fakeDriver({ poll: () => new Promise<BrowserJobView>((resolve) => { release = resolve }), cancel })
    const session = createOutlookSession(driver, 'check my email', { sleep: instant })
    await session.check()
    const running = session.confirm()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await session.cancel()
    expect(cancel).toHaveBeenCalledWith('b_1', 't')
    release(view('done', { result: { emails: [], tasks: [{ id: 't1', source_id: 'm1', task: 'LATE', quote: 'late quote here', deadline: null }], dropped_claims: 0 } }))
    await running
    expect(session.getSnapshot().phase).toBe('cancelled')
    expect(session.getSnapshot().job).toBeNull()
  })

  it('Stop pressed while the job is still being created cancels that job once it exists', async () => {
    let finishStart!: (v: { jobId: string; viewToken: string }) => void
    const cancel = vi.fn(async () => {})
    const poll = vi.fn(async () => view('reading'))
    const driver = fakeDriver({ start: () => new Promise((resolve) => { finishStart = resolve }), cancel, poll })
    const session = createOutlookSession(driver, 'check my email', { sleep: instant })
    await session.check()
    const running = session.confirm()
    await vi.waitFor(() => expect(finishStart).toBeTypeOf('function'))
    await session.cancel()
    expect(cancel).not.toHaveBeenCalled()
    finishStart({ jobId: 'b_late', viewToken: 'tl' })
    await running
    expect(cancel).toHaveBeenCalledWith('b_late', 'tl')
    expect(poll).not.toHaveBeenCalled()
    expect(session.getSnapshot().phase).toBe('cancelled')
  })

  it('dispose (closing the panel) cancels a running read', async () => {
    const cancel = vi.fn(async () => {})
    const driver = fakeDriver({ poll: async () => view('reading'), cancel })
    const session = createOutlookSession(driver, 'check my email', { sleep: () => new Promise(() => {}) })
    await session.check()
    void session.confirm()
    await vi.waitFor(() => expect(session.getSnapshot().job?.status).toBe('reading'))
    await session.dispose()
    expect(cancel).toHaveBeenCalled()
    expect(session.getSnapshot().job).toBeNull()
  })

  it.each(['permission_denied', 'login_required', 'account_changed', 'unsupported_layout', 'empty_mailbox', 'wrong_origin', 'tab_closed'])('shows recovery for %s and keeps no result', async (code) => {
    const driver = fakeDriver({ poll: async () => view('error', { error: code, result: { emails: [], tasks: [], dropped_claims: 0 } }) })
    const session = createOutlookSession(driver, 'check my email', { sleep: instant })
    await session.check()
    await session.confirm()
    const state = session.getSnapshot()
    expect(state.phase).toBe('error')
    expect(state.error).toBe(code)
    expect(state.job?.result).toBeNull()
    expect(outlookRecovery(code).title).not.toMatch(/Something went wrong/)
  })

  it('missing extension, no shared tab and revoked grant land in setup, not review', async () => {
    let session = createOutlookSession(fakeDriver({ hello: async () => { throw new OutlookError('extension_unavailable') } }), 'x')
    await session.check()
    expect(session.getSnapshot()).toMatchObject({ phase: 'setup', error: 'extension_unavailable' })
    session = createOutlookSession(fakeDriver({ hello: async () => ({ ok: true, source: null }) }), 'x')
    await session.check()
    expect(session.getSnapshot()).toMatchObject({ phase: 'setup', error: 'no_source_selected' })
    session = createOutlookSession(fakeDriver({ hello: async () => ({ ok: true, source: { provider: 'outlook', origin: 'https://outlook.office.com', accountLabel: '', granted: false } }) }), 'x')
    await session.check()
    expect(session.getSnapshot()).toMatchObject({ phase: 'setup', error: 'permission_denied' })
    await session.confirm()
    expect(session.getSnapshot().phase).toBe('setup')
  })
})

describe('review follow-ups', () => {
  it('deletes the backend copy as soon as the result is displayed', async () => {
    const cancel = vi.fn(async () => {})
    const result = { emails: [], tasks: [], dropped_claims: 0 }
    const session = createOutlookSession(fakeDriver({ poll: async () => view('done', { result }), cancel }), 'check', { sleep: instant })
    await session.check()
    await session.confirm()
    expect(session.getSnapshot().phase).toBe('done')
    expect(session.getSnapshot().job?.result).toEqual(result) // still shown in the panel
    expect(cancel).toHaveBeenCalledWith('b_1', 't')
  })

  it('a poll error stops the backend job and the extension read', async () => {
    const cancel = vi.fn(async () => {})
    const session = createOutlookSession(fakeDriver({ poll: async () => { throw new OutlookError('backend_error') }, cancel }), 'check', { sleep: instant })
    await session.check()
    await session.confirm()
    expect(session.getSnapshot().phase).toBe('error')
    expect(cancel).toHaveBeenCalledWith('b_1', 't')
  })

  it('turning air-gap on during a read stops it', async () => {
    const cancel = vi.fn(async () => {})
    const session = createOutlookSession(fakeDriver({ poll: async () => view('reading'), cancel }), 'check', { sleep: () => new Promise(() => {}) })
    await session.check()
    void session.confirm()
    await vi.waitFor(() => expect(session.getSnapshot().job?.status).toBe('reading'))
    session.setOffline(true)
    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: 'airgap_on', job: null })
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('b_1', 't'))
  })

  it('scope edits after a finished read apply to "Read again"', async () => {
    const starts: unknown[] = []
    const driver = createDemoDriver()
    const start = driver.start.bind(driver)
    driver.start = async (request, scope) => { starts.push(scope); return start(request, scope) }
    const session = createOutlookSession(driver, 'check my latest 4 emails', { sleep: instant })
    await session.check()
    await session.confirm()
    session.setScope({ mode: 'latest', count: 2 })
    expect(session.getSnapshot().scope.count).toBe(2)
    await session.confirm()
    expect(starts).toEqual([{ mode: 'latest', count: 4 }, { mode: 'latest', count: 2 }])
  })

  it('keeps the Outlook action out of the review button row (fits a 390 px phone)', () => {
    const html = renderToStaticMarkup(<TranscriptReview text="check my email" busy={false} items={[]} context={null} loading={false} libraryError={null}
      onText={() => {}} onSelect={() => {}} onRemove={() => {}} onLoad={() => {}} onAction={() => {}} onRerecord={() => {}} onDiscard={() => {}} onOutlook={() => {}} />)
    const row = html.slice(html.indexOf('voice-actions'), html.indexOf('</div>', html.indexOf('voice-actions')))
    expect(row).not.toContain('Outlook')
    expect(html).toContain('Check Outlook instead')
  })
})

describe('live driver', () => {
  it('fails closed when the browser exposes no extension messaging', async () => {
    vi.stubGlobal('chrome', undefined)
    await expect(sendToExtension({ type: 'latent.hello' })).rejects.toMatchObject({ code: 'extension_unavailable' })
  })

  it('creates a job, hands only id+nonce to the extension, and cancels the job if the extension is missing', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (init?.method === 'POST') return new Response(JSON.stringify({ job_id: 'b_' + 'a'.repeat(32), nonce: 'n'.repeat(43), view_token: 'v' }), { status: 201 })
      return new Response(null, { status: 204 })
    }))
    const sent: unknown[] = []
    vi.stubGlobal('chrome', { runtime: { sendMessage: (id: string, message: unknown, cb: (r: unknown) => void) => { sent.push([id, message]); cb(undefined) } } })
    await expect(liveDriver.start('Check my latest ten Outlook emails', { mode: 'latest', count: 10 })).rejects.toMatchObject({ code: 'extension_unavailable' })
    expect(sent[0]).toEqual([EXTENSION_ID, { type: 'latent.read', jobId: 'b_' + 'a'.repeat(32), nonce: 'n'.repeat(43) }])
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ provider: 'outlook', request: 'Check my latest ten Outlook emails', mode: 'latest', count: 10 })
    const last = calls[calls.length - 1]
    expect(last.init?.method).toBe('DELETE')
    expect(new Headers(last.init?.headers).get('X-Latent-View')).toBe('v')
  })

  it('only surfaces known error codes from the backend', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Priya Raman <priya@northwind.example> said…' }), { status: 422 })))
    await expect(liveDriver.poll('b_1', 't')).rejects.toMatchObject({ code: 'backend_error' })
  })
})

describe('privacy of the panel', () => {
  it('never writes Outlook results to browser storage', async () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { setItem, getItem: () => null, removeItem: setItem })
    vi.stubGlobal('sessionStorage', { setItem, getItem: () => null, removeItem: setItem })
    const session = createOutlookSession(createDemoDriver(), 'Check my latest ten emails', { sleep: instant })
    await session.check()
    await session.confirm()
    expect(setItem).not.toHaveBeenCalled()
  })
})
