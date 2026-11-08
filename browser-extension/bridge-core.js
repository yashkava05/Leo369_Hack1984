/*
 * Provider-neutral core of the Latent browser bridge (#67, reused by #68).
 *
 * Loaded three ways: importScripts() in the service worker, chrome.scripting file injection in
 * the authorized tab (isolated world), and require() in the Node tests. No DOM access here: the
 * provider adapters pass in small functions, which keeps the bounded reading loop testable.
 */
;(function (root) {
  'use strict'

  var BACKEND = 'http://127.0.0.1:8000'
  // Must match the backend's cors_origins; the backend refuses job creation from anything else.
  var UI_ORIGINS = ['http://localhost:5173']
  var PROVIDERS = {
    outlook: {
      label: 'Outlook on the web',
      origins: [
        'https://outlook.office.com',
        'https://outlook.office365.com',
        'https://outlook.live.com',
        'https://outlook.cloud.microsoft',
      ],
    },
  }
  var MAX_ITEMS = 20
  var ERROR_CODES = [
    'extension_unavailable', 'no_source_selected', 'permission_denied', 'wrong_origin',
    'account_changed', 'login_required', 'unsupported_layout', 'empty_mailbox',
    'nothing_selected', 'tab_closed', 'cancelled', 'read_failed',
  ]

  /** Exact origin match against the provider allowlist; lookalike hosts never match. */
  function originOf(url) {
    var parsed
    try { parsed = new URL(url) } catch (e) { return null }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
    if (parsed.port && parsed.port !== '443') return null
    return 'https://' + parsed.hostname.toLowerCase()
  }

  function providerForUrl(url) {
    var origin = originOf(url)
    if (!origin) return null
    for (var name in PROVIDERS) {
      if (PROVIDERS[name].origins.indexOf(origin) !== -1) return { provider: name, origin: origin }
    }
    return null
  }

  function isUiOrigin(origin) { return UI_ORIGINS.indexOf(origin) !== -1 }

  var JOB_ID = /^b_[0-9a-f]{32}$/
  var NONCE = /^[A-Za-z0-9_-]{32,64}$/

  /** Messages from the Latent page. Unknown shapes are rejected; nothing else is trusted. */
  function validateUiMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null
    var keys = Object.keys(msg).sort().join(',')
    if (msg.type === 'latent.hello' && keys === 'type') return { type: msg.type }
    if (msg.type === 'latent.forget' && keys === 'type') return { type: msg.type }
    if (msg.type === 'latent.read' && keys === 'jobId,nonce,type'
      && JOB_ID.test(msg.jobId) && NONCE.test(msg.nonce)) {
      return { type: msg.type, jobId: msg.jobId, nonce: msg.nonce }
    }
    if (msg.type === 'latent.cancel' && keys === 'jobId,type' && JOB_ID.test(msg.jobId)) {
      return { type: msg.type, jobId: msg.jobId }
    }
    return null
  }

  /** FNV-1a 64-bit as hex: opaque ids and change detection, never a security boundary. */
  function fingerprint(text) {
    var h1 = 0x811c9dc5, h2 = 0x01000193
    var s = String(text || '')
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i)
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
    }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8)
  }

  function clip(text, max) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max)
  }

  function rowKey(row) {
    return [row.sender, row.time, row.subject, String(row.preview || '').slice(0, 120)]
      .map(function (v) { return clip(v, 300).toLowerCase() }).join('|')
  }

  /**
   * Bounded reading of a virtualized list.
   *   adapter.rows()        -> rows currently rendered [{key, sender, time, subject, preview, unread}]
   *   adapter.getScroll() / adapter.setScroll(top) / adapter.viewport() / adapter.atEnd()
   *   adapter.wait(ms)      -> Promise; explicit wait for lazy loading
   *   adapter.aborted()     -> true once the user cancelled
   *   adapter.progress(n)   -> optional live count
   * Stops at the confirmed count, the end of the list, the scroll budget or the time budget,
   * always restores the user's scroll position, and reports honest coverage.
   */
  async function collectRows(adapter, opts) {
    var count = Math.max(1, Math.min(MAX_ITEMS, opts.count | 0))
    var unreadOnly = opts.mode === 'unread'
    var maxScrolls = opts.maxScrolls == null ? 15 : opts.maxScrolls
    var budgetMs = opts.budgetMs == null ? 12000 : opts.budgetMs
    var settleMs = opts.settleMs == null ? 350 : opts.settleMs
    var now = opts.now || Date.now
    var started = now()
    var start = adapter.getScroll()
    var examined = 0
    var seenKeys = Object.create(null)
    var seenPrints = Object.create(null)
    var items = []
    var scrolls = 0
    var idle = 0
    var reason = 'count_reached'
    try {
      for (;;) {
        if (adapter.aborted()) { reason = 'cancelled'; break }
        var fresh = 0
        var rows = adapter.rows()
        for (var i = 0; i < rows.length && items.length < count; i++) {
          var row = rows[i]
          var key = String(row.key || '')
          var print = rowKey(row)
          if (!key || seenKeys[key] || seenPrints[print]) continue
          seenKeys[key] = true
          seenPrints[print] = true
          fresh++
          examined++
          if (unreadOnly && !row.unread) continue
          items.push({
            id: 'o_' + fingerprint(key),
            sender: clip(row.sender, 200),
            time: clip(row.time, 80),
            subject: clip(row.subject, 300),
            preview: clip(row.preview, 1200),
            unread: !!row.unread,
          })
        }
        if (adapter.progress) adapter.progress(items.length)
        if (items.length >= count) { reason = 'count_reached'; break }
        if (now() - started >= budgetMs) { reason = 'timeout'; break }
        if (scrolls >= maxScrolls) { reason = 'budget'; break }
        idle = fresh ? 0 : idle + 1
        if (adapter.atEnd() && idle >= 1) { reason = 'list_end'; break }
        if (idle >= 3) { reason = 'list_end'; break }
        adapter.setScroll(adapter.getScroll() + Math.max(80, Math.floor(adapter.viewport() * 0.8)))
        scrolls++
        await adapter.wait(settleMs)
      }
    } finally {
      adapter.setScroll(start)
    }
    return {
      items: items,
      coverage: {
        requested: count,
        inspected: items.length,
        examined: examined,
        scrolls: scrolls,
        partial: items.length < count,
        reason: reason,
        elapsed_ms: Math.max(0, Math.round(now() - started)),
      },
    }
  }

  var api = {
    BACKEND: BACKEND,
    UI_ORIGINS: UI_ORIGINS,
    PROVIDERS: PROVIDERS,
    MAX_ITEMS: MAX_ITEMS,
    ERROR_CODES: ERROR_CODES,
    originOf: originOf,
    providerForUrl: providerForUrl,
    isUiOrigin: isUiOrigin,
    validateUiMessage: validateUiMessage,
    fingerprint: fingerprint,
    clip: clip,
    collectRows: collectRows,
  }
  root.LatentBridge = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
