// Run with: node --test browser-extension/test
// Fake people and fake companies only.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const core = require('../bridge-core.js')

const ROOT = path.join(__dirname, '..')

/** A virtualized list: only rows inside the viewport (+1 overscan) are rendered. */
function virtualList(total, opts = {}) {
  const rowHeight = 50
  const viewportHeight = opts.viewport ?? 300
  const rows = Array.from({ length: total }, (_, i) => ({
    key: `conv-${i}`,
    sender: `Sender ${i} at Fabrikam`,
    time: `${(i % 12) + 1}:00 PM`,
    subject: `Subject ${i}`,
    preview: `Please review item ${i} for Northwind.`,
    unread: i % 3 === 0,
  }))
  let top = opts.startTop ?? 0
  let loaded = opts.lazy ? Math.min(total, opts.lazy) : total
  const state = { aborted: false, waits: 0, progress: [] }
  const adapter = {
    rows() {
      const first = Math.max(0, Math.floor(top / rowHeight) - 1)
      const last = Math.min(loaded, Math.ceil((top + viewportHeight) / rowHeight) + 1)
      const visible = rows.slice(first, last)
      // Outlook re-renders rows; occasionally the same message appears under a new key.
      if (opts.rerender && visible.length) visible.push({ ...visible[0], key: `${visible[0].key}-again` })
      return visible
    },
    getScroll: () => top,
    setScroll: (value) => { top = Math.max(0, Math.min(value, loaded * rowHeight - viewportHeight)) },
    viewport: () => viewportHeight,
    atEnd: () => top + viewportHeight >= loaded * rowHeight - 2 && loaded >= total,
    wait: async () => {
      state.waits++
      if (opts.lazy && loaded < total) loaded = Math.min(total, loaded + opts.lazy)
      if (opts.abortAfter && state.waits >= opts.abortAfter) state.aborted = true
    },
    aborted: () => state.aborted,
    progress: (n) => state.progress.push(n),
  }
  return { adapter, state, getTop: () => top }
}

test('reads the confirmed count across a virtualized list and restores scroll', async () => {
  const { adapter, state, getTop } = virtualList(60, { startTop: 120 })
  const out = await core.collectRows(adapter, { mode: 'latest', count: 10, settleMs: 0 })
  assert.equal(out.items.length, 10)
  assert.equal(out.coverage.reason, 'count_reached')
  assert.equal(out.coverage.partial, false)
  assert.equal(getTop(), 120)
  assert.ok(state.progress.length > 1)
  assert.ok(out.items.every((item) => /^o_[0-9a-f]{16}$/.test(item.id)))
})

test('never reads more than 20, even if asked for more', async () => {
  const { adapter } = virtualList(80)
  const out = await core.collectRows(adapter, { mode: 'latest', count: 500, settleMs: 0, maxScrolls: 100 })
  assert.equal(out.items.length, 20)
  assert.equal(out.coverage.requested, 20)
})

test('deduplicates re-rendered rows', async () => {
  const { adapter } = virtualList(30, { rerender: true })
  const out = await core.collectRows(adapter, { mode: 'latest', count: 12, settleMs: 0 })
  const subjects = out.items.map((item) => item.subject)
  assert.equal(new Set(subjects).size, subjects.length)
  assert.equal(out.items.length, 12)
})

test('short inbox reports list_end and partial coverage honestly', async () => {
  const { adapter } = virtualList(4)
  const out = await core.collectRows(adapter, { mode: 'latest', count: 10, settleMs: 0 })
  assert.equal(out.items.length, 4)
  assert.equal(out.coverage.partial, true)
  assert.equal(out.coverage.reason, 'list_end')
})

test('lazy loading waits explicitly and the scroll budget stops the read', async () => {
  const { adapter, state } = virtualList(200, { lazy: 3, viewport: 100 })
  const out = await core.collectRows(adapter, { mode: 'unread', count: 20, settleMs: 0, maxScrolls: 4 })
  assert.equal(out.coverage.reason, 'budget')
  assert.equal(out.coverage.scrolls, 4)
  assert.equal(state.waits, 4)
  assert.equal(out.coverage.partial, true)
  assert.ok(out.items.every((item) => item.unread))
})

test('time budget stops the read', async () => {
  let clock = 0
  const { adapter } = virtualList(200, { viewport: 100 })
  const out = await core.collectRows(adapter, { mode: 'latest', count: 20, settleMs: 0, budgetMs: 1000, now: () => (clock += 400) })
  assert.equal(out.coverage.reason, 'timeout')
  assert.equal(out.coverage.partial, true)
})

test('cancel stops between steps and still restores scroll', async () => {
  const { adapter, getTop } = virtualList(200, { viewport: 100, abortAfter: 2, startTop: 50 })
  const out = await core.collectRows(adapter, { mode: 'latest', count: 20, settleMs: 0 })
  assert.equal(out.coverage.reason, 'cancelled')
  assert.equal(getTop(), 50)
})

test('origin allowlist rejects lookalikes', () => {
  for (const url of ['https://outlook.office.com/mail/', 'https://outlook.live.com/mail/0/', 'https://outlook.cloud.microsoft/mail/']) {
    assert.equal(core.providerForUrl(url).provider, 'outlook', url)
  }
  for (const url of [
    'http://outlook.office.com/mail/', 'https://outlook.office.com.evil.example/', 'https://evil.example/?u=outlook.office.com',
    'https://outlook.office.com:8443/', 'https://user:pw@outlook.office.com/', 'https://outlook-office.com/',
    'javascript:alert(1)', 'not a url',
  ]) {
    assert.equal(core.providerForUrl(url), null, url)
  }
  // Teams Web is its own provider (#68): never matched as Outlook, so an Outlook grant cannot cover it.
  assert.equal(core.providerForUrl('https://teams.microsoft.com/').provider, 'teams')
})

test('page messages are schema-checked', () => {
  const jobId = 'b_' + 'a'.repeat(32)
  const nonce = 'N'.repeat(43)
  assert.deepEqual(core.validateUiMessage({ type: 'latent.read', jobId, nonce }), { type: 'latent.read', jobId, nonce })
  assert.equal(core.validateUiMessage({ type: 'latent.read', jobId, nonce, scope: { count: 500 } }), null)
  assert.equal(core.validateUiMessage({ type: 'latent.read', jobId: '../x', nonce }), null)
  assert.equal(core.validateUiMessage({ type: 'latent.read', jobId, nonce: 'short' }), null)
  assert.equal(core.validateUiMessage({ type: 'latent.send', to: 'drop@exfil.example' }), null)
  assert.equal(core.validateUiMessage({ type: 'latent.hello', tabId: 3 }), null)
  assert.equal(core.validateUiMessage(null), null)
  assert.equal(core.validateUiMessage([]), null)
  assert.equal(core.isUiOrigin('http://localhost:5173'), true)
  assert.equal(core.isUiOrigin('https://evil.example'), false)
})

test('manifest never requests all sites, cookies, tabs or history', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'))
  const all = JSON.stringify(manifest)
  for (const forbidden of ['<all_urls>', '*://*/*', 'https://*/*', '"cookies"', '"tabs"', '"history"', '"webRequest"', '"nativeMessaging"', '"downloads"']) {
    assert.ok(!all.includes(forbidden), forbidden)
  }
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1:8000/*'])
  assert.ok(manifest.optional_host_permissions.every((p) => core.providerForUrl(p.replace('/*', '/'))))
  assert.ok(!('content_scripts' in manifest), 'nothing is injected until a confirmed read')
  assert.ok(manifest.externally_connectable.matches.every((m) => /^http:\/\/(localhost|127\.0\.0\.1):5173\/\*$/.test(m)))
})

test('extension code has no write, navigation, link or credential actions', () => {
  const files = ['background.js', 'bridge-core.js', 'popup.js', 'providers/outlook.js', 'providers/teams.js']
  const forbidden = [
    /\.click\(/, /dispatchEvent\(/, /chrome\.tabs\.(create|update|remove|move|highlight)\b/, /window\.open\(/,
    /location\.(assign|replace|href\s*=)/, /chrome\.cookies/, /document\.cookie/, /localStorage|indexedDB/,
    /chrome\.storage\.local/, /\.submit\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /console\.(log|info|debug|warn|error)/,
    /eval\(|new Function\(/,
  ]
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    for (const pattern of forbidden) assert.ok(!pattern.test(text), `${file}: ${pattern}`)
  }
  // The worker's only fetch goes to the fixed local backend constant.
  const worker = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8')
  assert.equal((worker.match(/fetch\(/g) || []).length, 1)
  assert.ok(worker.includes('fetch(core.BACKEND +'))
  assert.equal(core.BACKEND, 'http://127.0.0.1:8000')
  for (const file of ['bridge-core.js', 'providers/outlook.js', 'providers/teams.js', 'popup.js']) {
    assert.ok(!/fetch\(/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')), file)
  }
})
