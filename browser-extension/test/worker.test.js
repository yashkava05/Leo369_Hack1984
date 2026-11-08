// Run with: node --test browser-extension/test
// The service worker in a sandbox with a fake `chrome` (#68): separate grants, the confirmed
// Teams chat/channel, fail-closed checks and cancel. Fake people and fake companies only.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const EXT_ID = 'kemjkilbmidnkohlldbohmgjaljbkdcc'
const JOB = 'b_' + 'c'.repeat(32)
const NONCE = 'N'.repeat(43)
const CONV = { fp: '0123456789abcdef', label: 'Fabrikam launch', kind: 'channel' }
const TEAMS_URL = 'https://teams.microsoft.com/v2/'
const OUTLOOK_URL = 'https://outlook.office.com/mail/'

function fakeTab(url, overrides = {}) {
  const origin = new URL(url).origin
  const calls = { read: [], abort: 0 }
  const adapter = {
    probe: () => ({ origin, account: 'Avery Chen · Fabrikam', signedOut: false, blocked: false, conversation: CONV, ...overrides.probe }),
    read: (scope, jobId) => {
      calls.read.push({ scope, jobId })
      if (overrides.read) return overrides.read(scope)
      return {
        origin, account: 'Avery Chen · Fabrikam', conversation: CONV.fp, error: null,
        result: { items: [{ id: 't_1', author: 'Sam Rivera', time: '9:00 AM', timestamp: null, text: 'Hi', reply_to: null, mentions: [], link: null, unread: false }],
          coverage: { requested: scope.count, inspected: 1, scrolls: 0, partial: true, reason: 'list_end', elapsed_ms: 5, replies: 'not_requested', collapsed_threads: 0, skipped_undated: 0 } },
      }
    },
    abort: () => { calls.abort++ },
  }
  return { url, adapter, calls }
}

function sandbox({ tabs, granted, claim }) {
  const session = {}
  const fetches = []
  const badges = []
  const listeners = {}
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn } })
  const ctx = {
    console, URL, setTimeout, clearTimeout, Promise, Object, JSON, Math, Date, Array, String, Number,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      fetches.push({ path: url.replace(/^.*\/api\/browser\/jobs\/[^/]+/, ''), body, headers: init.headers })
      if (url.endsWith('/claim')) {
        const reply = claim ? claim(body) : { status: 200, data: { provider: 'teams', mode: 'latest', count: 10, replies: false, source: CONV.fp } }
        return { status: reply.status, ok: reply.status < 300, json: async () => reply.data }
      }
      return { status: url.endsWith('/content') ? 202 : 204, ok: true, json: async () => ({}) }
    },
    chrome: {
      runtime: { id: EXT_ID, getManifest: () => ({ version: '0.1.0' }), onMessage: on('message'), onMessageExternal: on('external'), sendMessage: () => {} },
      storage: { session: {
        get: async (key) => (key in session ? { [key]: session[key] } : {}),
        set: async (obj) => { Object.assign(session, obj) },
        remove: async (key) => { delete session[key] },
      } },
      permissions: {
        contains: async ({ origins }) => origins.every((o) => granted.includes(o)),
        onAdded: on('permAdded'), onRemoved: on('permRemoved'),
      },
      tabs: {
        get: async (id) => { if (!tabs[id]) throw new Error('no tab'); return { id, url: tabs[id].url } },
        onRemoved: on('tabRemoved'),
        onUpdated: on('tabUpdated'),
      },
      action: { setBadgeText: async (o) => { badges.push(o.text) }, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
      scripting: {
        executeScript: async ({ target, func, args, files }) => {
          const tab = tabs[target.tabId]
          if (!tab) throw new Error('no tab')
          const g = /teams/.test(tab.url) ? '__latentTeams' : '__latentOutlook'
          if (files) { ctx[g] = tab.adapter; return [] }
          ctx[g] = tab.adapter
          return [{ result: await func.apply(null, args) }]
        },
      },
    },
  }
  ctx.globalThis = ctx
  ctx.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx)
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), ctx)
  const ask = (name, message, sender) => new Promise((resolve) => {
    const async = listeners[name](message, sender, resolve)
    if (!async) setImmediate(() => resolve(undefined))
  })
  return {
    session, fetches, badges,
    popup: (message) => ask('message', message, { id: EXT_ID }),
    page: (message) => ask('external', message, { origin: 'http://localhost:5173' }),
    settle: async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)) },
  }
}

const read = (sb) => sb.page({ type: 'latent.read', jobId: JOB, nonce: NONCE })
const failCode = (sb) => sb.fetches.filter((f) => f.path === '/fail').map((f) => f.body.code)

test('an Outlook grant does not authorize sharing a Teams tab', async () => {
  const sb = sandbox({ tabs: { 7: fakeTab(TEAMS_URL) }, granted: ['https://outlook.office.com/*'] })
  const res = await sb.popup({ type: 'latent.select', tabId: 7 })
  assert.deepEqual({ ok: res.ok, error: res.error }, { ok: false, error: 'permission_denied' })
  assert.equal(sb.session.source, undefined)
})

test('sharing a Teams tab records only the open chat/channel and hello exposes it to Latent', async () => {
  const sb = sandbox({ tabs: { 7: fakeTab(TEAMS_URL) }, granted: ['https://teams.microsoft.com/*'] })
  const res = await sb.popup({ type: 'latent.select', tabId: 7 })
  assert.equal(res.ok, true)
  assert.deepEqual({ ...sb.session.source.conversation }, CONV)
  const hello = await sb.page({ type: 'latent.hello' })
  assert.equal(hello.source.provider, 'teams')
  assert.deepEqual({ ...hello.source.conversation }, CONV)
})

test('sharing fails closed without an open conversation or when the organization blocks it', async () => {
  let sb = sandbox({ tabs: { 7: fakeTab(TEAMS_URL, { probe: { conversation: null } }) }, granted: ['https://teams.microsoft.com/*'] })
  assert.equal((await sb.popup({ type: 'latent.select', tabId: 7 })).error, 'nothing_selected')
  sb = sandbox({ tabs: { 7: fakeTab(TEAMS_URL, { probe: { blocked: true } }) }, granted: ['https://teams.microsoft.com/*'] })
  assert.equal((await sb.popup({ type: 'latent.select', tabId: 7 })).error, 'org_blocked')
  assert.equal(sb.session.source, undefined)
})

async function shared(opts = {}) {
  const tab = fakeTab(TEAMS_URL, opts.tab)
  const sb = sandbox({ tabs: { 7: tab }, granted: ['https://teams.microsoft.com/*'], claim: opts.claim })
  await sb.popup({ type: 'latent.select', tabId: 7 })
  return { sb, tab }
}

test('a confirmed read passes the backend scope (source, replies) and posts the confirmed source', async () => {
  const { sb, tab } = await shared()
  await read(sb)
  await sb.settle()
  assert.deepEqual({ ...tab.calls.read[0].scope }, { mode: 'latest', count: 10, replies: false, source: CONV.fp })
  const content = sb.fetches.find((f) => f.path === '/content')
  assert.equal(content.body.provider, 'teams')
  assert.equal(content.body.source, CONV.fp)
  assert.equal(content.headers['X-Latent-Nonce'], NONCE)
  assert.deepEqual(failCode(sb), [])
  assert.deepEqual([sb.badges[0], sb.badges[sb.badges.length - 1]], ['READ', ''])  // visible in Chrome while reading
})

test('a request confirmed for another chat/channel is refused before reading', async () => {
  const { sb, tab } = await shared({ claim: () => ({ status: 200, data: { provider: 'teams', mode: 'latest', count: 10, replies: false, source: 'fedcba9876543210' } }) })
  await read(sb)
  await sb.settle()
  assert.deepEqual(failCode(sb), ['conversation_changed'])
  assert.equal(tab.calls.read.length, 0)
})

test('switching to another conversation after sharing fails closed', async () => {
  const { sb, tab } = await shared()
  tab.adapter.probe = () => ({ origin: 'https://teams.microsoft.com', account: 'Avery Chen · Fabrikam', conversation: { ...CONV, fp: 'aaaaaaaaaaaaaaaa', label: 'Finance' } })
  await read(sb)
  await sb.settle()
  assert.deepEqual(failCode(sb), ['conversation_changed'])
  assert.equal(tab.calls.read.length, 0)
})

test('an account or tenant switch fails closed', async () => {
  const { sb, tab } = await shared()
  tab.adapter.probe = () => ({ origin: 'https://teams.microsoft.com', account: 'Avery Chen · Contoso', conversation: CONV })
  await read(sb)
  await sb.settle()
  assert.deepEqual(failCode(sb), ['account_changed'])
})

test('a Teams tab that navigated away fails closed before anything is injected', async () => {
  const { sb, tab } = await shared()
  tab.url = 'https://teams.microsoft.com.evil.example/'
  await read(sb)
  await sb.settle()
  assert.deepEqual(failCode(sb), ['wrong_origin'])
  assert.equal(tab.calls.read.length, 0)
})

test('a revoked Teams grant fails closed', async () => {
  const { sb } = await shared()
  sb.fetches.length = 0
  const granted = []
  // Revocation: the grant disappears between sharing and reading.
  const sb2 = sandbox({ tabs: { 7: fakeTab(TEAMS_URL) }, granted, claim: undefined })
  Object.assign(sb2.session, sb.session)
  await read(sb2)
  await sb2.settle()
  assert.deepEqual(failCode(sb2), ['permission_denied'])
})

test('a request for the other provider does not leave the page waiting', async () => {
  const { sb, tab } = await shared({ claim: () => ({ status: 422, data: { detail: 'wrong_provider' } }) })
  await read(sb)
  await sb.settle()
  assert.deepEqual(failCode(sb), ['no_source_selected'])
  assert.equal(tab.calls.read.length, 0)
})

test('cancel during a read aborts the reader and drops its late result', async () => {
  let release
  const { sb, tab } = await shared({ tab: { read: () => new Promise((resolve) => { release = resolve }) } })
  await read(sb)
  await sb.settle()
  assert.equal(typeof release, 'function')
  await sb.page({ type: 'latent.cancel', jobId: JOB })
  assert.equal(tab.calls.abort, 1)
  release({ origin: 'https://teams.microsoft.com', account: 'Avery Chen · Fabrikam', conversation: CONV.fp, error: null, result: { items: [], coverage: {} } })
  await sb.settle()
  assert.equal(sb.fetches.filter((f) => f.path === '/content').length, 0)
})

test('Outlook reads keep their original payload shape', async () => {
  const tab = fakeTab(OUTLOOK_URL, {
    probe: { conversation: undefined },
    read: (scope) => ({
      origin: 'https://outlook.office.com', account: 'Avery Chen · Fabrikam', error: null,
      result: { items: [], coverage: { requested: scope.count, inspected: 0, scrolls: 0, partial: true, reason: 'list_end', elapsed_ms: 1 } },
    }),
  })
  const sb = sandbox({
    tabs: { 3: tab }, granted: ['https://outlook.office.com/*'],
    claim: () => ({ status: 200, data: { provider: 'outlook', mode: 'latest', count: 5 } }),
  })
  assert.equal((await sb.popup({ type: 'latent.select', tabId: 3 })).ok, true)
  assert.equal(sb.session.source.conversation, undefined)
  await read(sb)
  await sb.settle()
  const content = sb.fetches.find((f) => f.path === '/content')
  assert.deepEqual(Object.keys(content.body).sort(), ['coverage', 'items', 'mode', 'origin', 'provider'])
  assert.deepEqual({ ...tab.calls.read[0].scope }, { mode: 'latest', count: 5 })
})
