/*
 * Latent bridge service worker (#67). Talks to exactly two parties:
 * - the Latent page on localhost (externally_connectable + sender.origin check), and
 * - the Latent backend on 127.0.0.1:8000, authenticated by this extension's origin and a
 *   one-job nonce the backend issued for a request the user confirmed.
 * The selected source lives in chrome.storage.session (memory only, cleared on browser exit).
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

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['bridge-core.js', 'providers/outlook.js'] })
}

/** Re-check every condition right before reading: tab, origin, grant, account. Fails closed. */
async function verifySource(source) {
  var tab
  try { tab = await chrome.tabs.get(source.tabId) } catch (e) { return { error: 'tab_closed' } }
  if (!tab) return { error: 'tab_closed' }
  var granted = await chrome.permissions.contains({ origins: [source.origin + '/*'] })
  if (!granted) return { error: 'permission_denied' }
  try { await inject(source.tabId) } catch (e) { return { error: 'permission_denied' } }
  var probe = await inTab(source.tabId, function () { return globalThis.__latentOutlook.probe() })
  if (!probe || probe.origin !== source.origin) return { error: 'wrong_origin' }
  if (probe.signedOut) return { error: 'login_required' }
  // Fail closed: a tab whose account cannot be identified is never treated as the same account.
  if (!probe.account || core.fingerprint(probe.account) !== source.account) return { error: 'account_changed' }
  return { tab: tab }
}

async function read(jobId, nonce) {
  var source = await getSource()
  if (!source) { await report(jobId, nonce, 'no_source_selected'); return }
  // Registered before the claim so a cancel that arrives mid-claim is honoured.
  // The nonce stays in worker memory only while this read runs (for progress reports).
  var job = running[jobId] = { tabId: source.tabId, cancelled: false, nonce: nonce }
  try {
    var claim
    try {
      claim = await backend('/claim', jobId, nonce, { provider: source.provider, origin: source.origin })
    } catch (e) { return } // backend unreachable: the page shows its own error
    if (!claim.ok || job.cancelled) return // refused (air-gap, wrong origin, replay) or stopped
    var check = await verifySource(source)
    if (check.error) { await report(jobId, nonce, check.error); return }
    if (job.cancelled) return
    // The scope comes from the backend's claim response, not from the page message.
    var scope = { mode: claim.data.mode, count: claim.data.count }
    var out = await inTab(source.tabId, function (s, id) { return globalThis.__latentOutlook.read(s, id) }, [scope, jobId])
    if (job.cancelled) return
    if (!out) { await report(jobId, nonce, 'read_failed'); return }
    if (out.origin !== source.origin) { await report(jobId, nonce, 'wrong_origin'); return }
    if (!out.account || core.fingerprint(out.account) !== source.account) { await report(jobId, nonce, 'account_changed'); return }
    if (out.error) { await report(jobId, nonce, out.error); return }
    var sent = await backend('/content', jobId, nonce, {
      provider: source.provider,
      origin: source.origin,
      mode: scope.mode,
      items: out.result.items,
      coverage: out.result.coverage,
    })
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
  try { await inTab(job.tabId, function () { if (globalThis.__latentOutlook) globalThis.__latentOutlook.abort() }) } catch (e) { /* tab gone */ }
}

async function hello() {
  var source = await getSource()
  if (!source) return { ok: true, version: chrome.runtime.getManifest().version, source: null }
  var granted = await chrome.permissions.contains({ origins: [source.origin + '/*'] })
  var alive = true
  try { await chrome.tabs.get(source.tabId) } catch (e) { alive = false }
  if (!alive) { await setSource(null); return { ok: true, version: chrome.runtime.getManifest().version, source: null } }
  return {
    ok: true,
    version: chrome.runtime.getManifest().version,
    source: { provider: source.provider, origin: source.origin, accountLabel: source.accountLabel || '', granted: granted },
  }
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
  var granted = await chrome.permissions.contains({ origins: [match.origin + '/*'] })
  if (!granted) return { ok: false, error: 'permission_denied' }
  await inject(tabId)
  var probe = await inTab(tabId, function () { return globalThis.__latentOutlook.probe() })
  if (!probe || probe.origin !== match.origin) return { ok: false, error: 'wrong_origin' }
  if (probe.signedOut) return { ok: false, error: 'login_required' }
  if (!probe.account) return { ok: false, error: 'unsupported_layout' } // account switches must be detectable
  await setSource({
    provider: match.provider,
    origin: match.origin,
    tabId: tabId,
    account: core.fingerprint(probe.account),
    accountLabel: probe.account,
  })
  return { ok: true, origin: match.origin, accountLabel: probe.account }
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
