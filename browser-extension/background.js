/*
 * Latent bridge service worker (#67; Teams Web adapter #68). Talks to exactly two parties:
 * - the Latent page on localhost (externally_connectable + sender.origin check), and
 * - the Latent backend on 127.0.0.1:8000, authenticated by this extension's origin and a
 *   one-job nonce the backend issued for a request the user confirmed.
 * The selected source lives in chrome.storage.session (memory only, cleared on browser exit).
 * One source at a time: sharing a Teams tab replaces a shared Outlook tab and vice versa, and
 * each provider's site needs its own Chrome grant.
 * Page text passes through this worker once, on its way to the local backend; it is never
 * stored, logged or sent anywhere else.
 */
/* global importScripts, LatentBridge */
importScripts('bridge-core.js')

var core = LatentBridge
var running = Object.create(null) // jobId -> { tabId, cancelled, nonce } for the read in flight

async function getSource() {
  var data = await chrome.storage.session.get('source')
  return data.source || null
}

async function setSource(source) {
  if (source) await chrome.storage.session.set({ source: source })
  else await chrome.storage.session.remove('source')
}

async function backend(path, jobId, nonce, body) {
  var response = await fetch(core.BACKEND + '/api/browser/jobs/' + jobId + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Latent-Nonce': nonce },
    body: JSON.stringify(body),
    credentials: 'omit',
    cache: 'no-store',
  })
  if (response.status === 204) return { ok: true, status: 204, data: null }
  var data = await response.json().catch(function () { return null })
  return { ok: response.ok, status: response.status, data: data }
}

async function report(jobId, nonce, code) {
  if (core.ERROR_CODES.indexOf(code) === -1) code = 'read_failed'
  try { await backend('/fail', jobId, nonce, { code: code }) } catch (e) { /* backend gone: nothing to tell */ }
}

async function inTab(tabId, func, args) {
  var results = await chrome.scripting.executeScript({ target: { tabId: tabId }, func: func, args: args || [] })
  return results && results[0] ? results[0].result : null
}

function adapterOf(provider) {
  return Object.prototype.hasOwnProperty.call(core.PROVIDERS, provider) ? core.PROVIDERS[provider] : null
}

async function inject(tabId, provider) {
  await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['bridge-core.js', adapterOf(provider).script] })
}

// These run inside the tab; the adapter's global name is passed in, never page-controlled.
function probeInTab(name) { return globalThis[name].probe() }
function readInTab(name, scope, jobId) { return globalThis[name].read(scope, jobId) }
function abortInTab(name) { if (globalThis[name]) globalThis[name].abort() }

/** Re-check every condition right before reading: tab, origin, grant, account (and for Teams,
 * the confirmed chat/channel). Fails closed. */
async function verifySource(source) {
  var adapter = adapterOf(source.provider)
  if (!adapter) return { error: 'wrong_origin' }
  var tab
  try { tab = await chrome.tabs.get(source.tabId) } catch (e) { return { error: 'tab_closed' } }
  if (!tab) return { error: 'tab_closed' }
  var granted = await chrome.permissions.contains({ origins: [source.origin + '/*'] })
  if (!granted) return { error: 'permission_denied' }
  try { await inject(source.tabId, source.provider) } catch (e) { return { error: 'permission_denied' } }
  var probe = await inTab(source.tabId, probeInTab, [adapter.global])
  if (!probe || probe.origin !== source.origin) return { error: 'wrong_origin' }
  if (probe.blocked) return { error: 'org_blocked' }
  if (probe.signedOut) return { error: 'login_required' }
  // Fail closed: a tab whose account cannot be identified is never treated as the same account.
  if (!probe.account || core.fingerprint(probe.account) !== source.account) return { error: 'account_changed' }
  if (source.provider === 'teams') {
    if (!probe.conversation) return { error: 'nothing_selected' }
    if (!source.conversation || probe.conversation.fp !== source.conversation.fp) return { error: 'conversation_changed' }
  }
  return { tab: tab }
}

async function read(jobId, nonce) {
  var source = await getSource()
  if (!source) { await report(jobId, nonce, 'no_source_selected'); return }
  // Registered before the claim so a cancel that arrives mid-claim is honoured.
  // The nonce stays in worker memory only while this read runs (for progress reports).
  var job = running[jobId] = { tabId: source.tabId, provider: source.provider, cancelled: false, nonce: nonce }
  try {
    var claim
    try {
      claim = await backend('/claim', jobId, nonce, { provider: source.provider, origin: source.origin })
    } catch (e) { return } // backend unreachable: the page shows its own error
    // A request for another provider than the shared tab (Outlook vs Teams) must not leave
    // the page waiting: say no matching tab is shared.
    if (claim.status === 422 && !job.cancelled) { await report(jobId, nonce, 'no_source_selected'); return }
    if (!claim.ok || job.cancelled) return // refused (air-gap, wrong origin, replay) or stopped
    var teams = source.provider === 'teams'
    // The chat/channel the user confirmed in Latent must be the one shared from this tab.
    if (teams && (!source.conversation || claim.data.source !== source.conversation.fp)) {
      await report(jobId, nonce, 'conversation_changed'); return
    }
    var check = await verifySource(source)
    if (check.error) { await report(jobId, nonce, check.error); return }
    if (job.cancelled) return
    // The scope comes from the backend's claim response, not from the page message.
    var scope = { mode: claim.data.mode, count: claim.data.count }
    if (teams) { scope.replies = claim.data.replies === true; scope.source = claim.data.source }
    var out = await inTab(source.tabId, readInTab, [adapterOf(source.provider).global, scope, jobId])
    if (job.cancelled) return
    if (!out) { await report(jobId, nonce, 'read_failed'); return }
    if (out.origin !== source.origin) { await report(jobId, nonce, 'wrong_origin'); return }
    if (!out.account || core.fingerprint(out.account) !== source.account) { await report(jobId, nonce, 'account_changed'); return }
    if (out.error) { await report(jobId, nonce, out.error); return }
    if (teams && out.conversation !== scope.source) { await report(jobId, nonce, 'conversation_changed'); return }
    var payload = {
      provider: source.provider,
      origin: source.origin,
      mode: scope.mode,
      items: out.result.items,
      coverage: out.result.coverage,
    }
    if (teams) payload.source = scope.source
    var sent = await backend('/content', jobId, nonce, payload)
    // A refused upload (size, schema, scope) must not leave the page waiting on "reading".
    if (!sent.ok && sent.status !== 404 && sent.status !== 410) await report(jobId, nonce, 'read_failed')
  } catch (e) {
    if (!job.cancelled) await report(jobId, nonce, 'read_failed')
  } finally {
    delete running[jobId]
  }
}

async function cancel(jobId) {
  var job = running[jobId]
  if (!job) return
  job.cancelled = true
  try { await inTab(job.tabId, abortInTab, [adapterOf(job.provider).global]) } catch (e) { /* tab gone */ }
}

async function hello() {
  var source = await getSource()
  if (!source) return { ok: true, version: chrome.runtime.getManifest().version, source: null }
  var granted = await chrome.permissions.contains({ origins: [source.origin + '/*'] })
  var alive = true
  try { await chrome.tabs.get(source.tabId) } catch (e) { alive = false }
  if (!alive) { await setSource(null); return { ok: true, version: chrome.runtime.getManifest().version, source: null } }
  var shared = { provider: source.provider, origin: source.origin, accountLabel: source.accountLabel || '', granted: granted }
  // Teams: the shared chat/channel label goes only to the local Latent page, for confirmation.
  if (source.provider === 'teams') shared.conversation = source.conversation || null
  return { ok: true, version: chrome.runtime.getManifest().version, source: shared }
}

chrome.runtime.onMessageExternal.addListener(function (message, sender, sendResponse) {
  if (!sender.origin || !core.isUiOrigin(sender.origin)) { sendResponse({ ok: false, error: 'untrusted_origin' }); return false }
  var msg = core.validateUiMessage(message)
  if (!msg) { sendResponse({ ok: false, error: 'invalid_message' }); return false }
  if (msg.type === 'latent.hello') { hello().then(sendResponse, function () { sendResponse({ ok: false }) }); return true }
  if (msg.type === 'latent.forget') { setSource(null).then(function () { sendResponse({ ok: true }) }); return true }
  if (msg.type === 'latent.cancel') { cancel(msg.jobId).then(function () { sendResponse({ ok: true }) }); return true }
  if (msg.type === 'latent.read') { void read(msg.jobId, msg.nonce); sendResponse({ ok: true, accepted: true }); return false }
  return false
})

// Popup (select/forget) and the in-tab reader (progress) are this extension's own contexts.
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false
  // select/pending/unselect come only from the popup (no tab); progress only from the reader in the tab.
  var fromPopup = !sender.tab
  if (message.type === 'latent.select' && fromPopup && Number.isInteger(message.tabId)) {
    selectTab(message.tabId).then(sendResponse, function () { sendResponse({ ok: false, error: 'permission_denied' }) })
    return true
  }
  if (message.type === 'latent.pending' && fromPopup && Number.isInteger(message.tabId)) {
    chrome.storage.session.set({ pending: { tabId: message.tabId, at: Date.now() } }).then(function () { sendResponse({ ok: true }) })
    return true
  }
  if (message.type === 'latent.unselect' && fromPopup) { setSource(null).then(function () { sendResponse({ ok: true }) }); return true }
  if (message.type === 'latent.progress' && sender.tab && typeof message.jobId === 'string') {
    var job = running[message.jobId]
    if (job && job.tabId === sender.tab.id && Number.isInteger(message.inspected)) void progress(message.jobId, message.inspected)
    return false
  }
  return false
})

async function progress(jobId, inspected) {
  var job = running[jobId]
  if (!job || job.cancelled) return
  try { await backend('/progress', jobId, job.nonce, { inspected: Math.min(core.MAX_ITEMS, inspected) }) } catch (e) { /* best effort */ }
}

/** Popup asked to share its active tab. Requires the optional host grant for that origin. */
async function selectTab(tabId) {
  var tab = await chrome.tabs.get(tabId)
  var match = tab && tab.url ? core.providerForUrl(tab.url) : null
  if (!match) return { ok: false, error: 'wrong_origin' }
  // Each provider's site needs its own grant: an Outlook grant never authorizes Teams.
  var granted = await chrome.permissions.contains({ origins: [match.origin + '/*'] })
  if (!granted) return { ok: false, error: 'permission_denied' }
  await inject(tabId, match.provider)
  var probe = await inTab(tabId, probeInTab, [adapterOf(match.provider).global])
  if (!probe || probe.origin !== match.origin) return { ok: false, error: 'wrong_origin' }
  if (probe.blocked) return { ok: false, error: 'org_blocked' }
  if (probe.signedOut) return { ok: false, error: 'login_required' }
  if (!probe.account) return { ok: false, error: 'unsupported_layout' } // account switches must be detectable
  var source = {
    provider: match.provider,
    origin: match.origin,
    tabId: tabId,
    account: core.fingerprint(probe.account),
    accountLabel: probe.account,
  }
  if (match.provider === 'teams') {
    // Teams shares exactly the chat/channel open now; Latent never picks or searches one.
    var conv = probe.conversation
    if (!conv || !conv.fp || !conv.label) return { ok: false, error: 'nothing_selected' }
    source.conversation = { fp: conv.fp, label: conv.label, kind: conv.kind === 'channel' ? 'channel' : 'chat' }
  }
  await setSource(source)
  return { ok: true, origin: match.origin, accountLabel: probe.account, conversation: source.conversation || null }
}

chrome.tabs.onRemoved.addListener(function (tabId) {
  getSource().then(function (source) { if (source && source.tabId === tabId) return setSource(null) })
})

chrome.permissions.onAdded.addListener(function () {
  chrome.storage.session.get('pending').then(function (data) {
    var pending = data.pending
    if (!pending) return
    return chrome.storage.session.remove('pending').then(function () {
      if (Date.now() - pending.at < 120000) return selectTab(pending.tabId).catch(function () {})
    })
  })
})

chrome.permissions.onRemoved.addListener(function () {
  getSource().then(function (source) {
    if (!source) return
    return chrome.permissions.contains({ origins: [source.origin + '/*'] }).then(function (ok) { if (!ok) return setSource(null) })
  })
})
