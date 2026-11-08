/*
 * Teams Web adapter (#68). Injected only into the one Teams tab the user authorized, and only
 * after Latent's backend accepted a confirmed request for the chat/channel the user selected.
 * Read-only by construction: it reads rendered text and scrolls the open conversation's
 * timeline (then scrolls back). It never clicks, expands threads, opens links, posts, reacts,
 * edits, joins meetings, downloads files, switches chats or touches cookies/storage.
 *
 * Layout notes (verify on the demo laptop; Teams changes its DOM often):
 * - Conversation header: [data-tid="chat-title"] / [data-tid="chat-header-title"] for chats,
 *   [data-tid="channel-name"] / [data-tid="channel-header-title"] for channels.
 * - Timeline viewport: [data-tid="message-pane-list-viewport"] (chats) or
 *   [data-tid="channel-pane-viewport"] (channels); newest messages at the bottom, older ones
 *   load as you scroll up (virtualized).
 * - Messages: [data-tid="chat-pane-item"] / [data-tid="channel-pane-message"]; body
 *   [data-tid="chat-pane-message"] or [id^="content-"]; author [data-tid="message-author-name"]
 *   (omitted on consecutive messages by the same author); time <time datetime>.
 * - Unread divider: [data-tid="unread-divider"] or a separator saying "New messages".
 * - Collapsed channel threads show a replies summary button; Latent reports them as
 *   incomplete instead of expanding them.
 */
;(function (root) {
  'use strict'
  var core = root.LatentBridge || (typeof require === 'function' ? require('../bridge-core.js') : null)
  var state = root.__latentTeamsState || (root.__latentTeamsState = { aborted: false })

  var CHAT_TITLE = '[data-tid="chat-title"], [data-tid="chat-header-title"], [data-tid="chat-header-name"]'
  var CHANNEL_TITLE = '[data-tid="channel-name"], [data-tid="channel-header-title"], [data-tid="channelTitle-text"]'
  var VIEWPORT = '[data-tid="message-pane-list-viewport"], [data-tid="channel-pane-viewport"], [data-tid="chat-pane-list"]'
  var ITEM = '[data-tid="chat-pane-item"], [data-tid="channel-pane-message"], [data-tid="channel-reply-pane-message"]'
  var BODY = '[data-tid="chat-pane-message"], [data-tid="message-body-content"], [id^="content-"]'
  var AUTHOR = '[data-tid="message-author-name"], [data-tid="threadBodyDisplayName"]'
  var MENTION = '[itemtype="http://schema.skype.com/Mention"], [data-tid="mention"], span[id^="mention-"]'
  var REPLIES_SUMMARY = '[data-tid="replies-summary"], [data-tid="reply-summary"], [data-tid="channel-replies-summary"]'
  var DIVIDER = '[data-tid="unread-divider"], [data-tid="message-pane-unread-divider"], [data-tid="new-messages-divider"]'
  var THREAD = /19:[A-Za-z0-9_.-]+@(?:thread\.[a-z0-9]+|unq\.gbl\.spaces)/
  var BLOCKED = /\b(?:organi[sz]ation|admin(?:istrator)?|IT department)\b[^.]{0,80}\b(?:block|blocked|doesn'?t allow|does not allow|disabled|restrict)/i

  // --- bounded, provider-local timeline reader (pure; tested in Node) -----------------------

  function iso(value) {
    var t = Date.parse(value || '')
    return isNaN(t) ? null : new Date(t).toISOString()
  }

  function printOf(row) {
    return [row.author, row.timestamp || row.time, String(row.text || '').slice(0, 200), row.reply ? row.rootKey || '' : '']
      .map(function (v) { return core.clip(v, 300).toLowerCase() }).join('|')
  }

  function toItem(row, unread) {
    var link = safeLink(row.link)
    return {
      id: 't_' + core.fingerprint(row.key || printOf(row)),
      author: core.clip(row.author, 200),
      time: core.clip(row.time, 80),
      timestamp: iso(row.timestamp),
      text: core.clip(row.text, 3000),
      reply_to: row.reply ? 't_' + core.fingerprint(row.rootKey || 'root:' + (row.key || '')) : null,
      mentions: (row.mentions || []).map(function (m) { return core.clip(m, 120) }).filter(Boolean).slice(0, 10),
      link: link,
      unread: !!unread,
    }
  }

  /** A link is kept only if Teams itself rendered a message permalink on an allowed origin. */
  function safeLink(href) {
    if (!href) return null
    var origin = core.originOf(href)
    if (!origin || core.PROVIDERS.teams.origins.indexOf(origin) === -1) return null
    try { return new URL(href).pathname.indexOf('/l/message/') === 0 ? href : null } catch (e) { return null }
  }

  /**
   * Bounded reading of a virtualized, newest-at-the-bottom timeline.
   *   adapter.items()      -> rendered messages in DOM order (oldest first):
   *                           [{key, author, time, timestamp, text, mentions, link, reply, rootKey,
   *                             afterDivider (true|false|null when no divider is rendered),
   *                             collapsedReplies}]
   *   adapter.getScroll() / setScroll(top) / toNewest() / viewport() / atStart()
   *   adapter.wait(ms), adapter.aborted(), adapter.progress(n)
   * opts: {mode: latest|unread|today, count, replies, since (ms, local midnight for "today")}
   * Reads newest first, stops at the confirmed count, the window/unread boundary, the top of the
   * history, the scroll budget or the time budget; restores the scroll position; reports honest
   * coverage, including unloaded replies and undated messages it had to skip.
   */
  async function collectTimeline(adapter, opts) {
    var count = Math.max(1, Math.min(core.MAX_ITEMS, opts.count | 0))
    var mode = opts.mode
    var replies = !!opts.replies
    var maxScrolls = opts.maxScrolls == null ? 15 : opts.maxScrolls
    var budgetMs = opts.budgetMs == null ? 12000 : opts.budgetMs
    var settleMs = opts.settleMs == null ? 400 : opts.settleMs
    var now = opts.now || Date.now
    var started = now()
    var start = adapter.getScroll()
    var seenKeys = Object.create(null)
    var seenPrints = Object.create(null)
    var picked = [] // newest first
    var collapsed = 0
    var skippedUndated = 0
    var dividerSeen = false
    var overflow = false // more unread candidates than the confirmed count
    var scrolls = 0
    var idle = 0
    var reason = 'list_end'
    try {
      adapter.toNewest()
      if (adapter.wait) await adapter.wait(settleMs)
      for (;;) {
        if (adapter.aborted()) { reason = 'cancelled'; break }
        var rows = adapter.items()
        var fresh = 0
        var stop = false
        for (var i = rows.length - 1; i >= 0; i--) {
          var row = rows[i]
          var print = printOf(row)
          var key = String(row.key || '') || print
          if (seenKeys[key] || seenPrints[print]) continue
          seenKeys[key] = true
          seenPrints[print] = true
          fresh++
          if (!String(row.text || '').trim()) continue // system events ("X added Y") carry no text
          if (row.reply && !replies) continue
          if (mode === 'today') {
            var ts = Date.parse(row.timestamp || '')
            if (isNaN(ts)) { skippedUndated++; continue }
            if (ts < opts.since) {
              if (row.reply) continue
              reason = 'window_end'; stop = true; break
            }
          }
          if (mode === 'unread') {
            if (row.afterDivider === false) {
              dividerSeen = true
              reason = overflow ? 'count_reached' : 'unread_end'
              stop = true
              break
            }
            if (row.afterDivider === true) dividerSeen = true
            // Until the divider is seen, keep scanning but never hold more than the count.
            if (picked.length >= count) { overflow = true; continue }
          }
          picked.push(row)
          if (replies && !row.reply && row.collapsedReplies) collapsed++
          if (mode !== 'unread' && picked.length >= count) { reason = 'count_reached'; stop = true; break }
        }
        if (adapter.progress) adapter.progress(mode === 'unread' && !dividerSeen ? 0 : picked.length)
        if (stop) break
        if (mode === 'unread' && dividerSeen && picked.length >= count) { reason = 'count_reached'; break }
        if (now() - started >= budgetMs) { reason = 'timeout'; break }
        if (scrolls >= maxScrolls) { reason = 'budget'; break }
        idle = fresh ? 0 : idle + 1
        if (adapter.atStart() && idle >= 1) { reason = 'list_end'; break }
        if (idle >= 3) { reason = 'list_end'; break }
        adapter.setScroll(Math.max(0, adapter.getScroll() - Math.max(80, Math.floor(adapter.viewport() * 0.8))))
        scrolls++
        await adapter.wait(settleMs)
      }
    } finally {
      adapter.setScroll(start)
    }
    if (mode === 'unread' && !dividerSeen) {
      // No "New messages" divider: either nothing is unread (top of history reached) or Latent
      // could not confirm which messages are unread. Never guess.
      picked = []
      collapsed = 0
      if (reason === 'list_end') reason = 'unread_end'
    }
    var items = picked.slice(0, count).reverse().map(function (row) {
      return toItem(row, mode === 'unread' || row.afterDivider === true)
    })
    var repliesState = !replies ? 'not_requested' : collapsed ? 'incomplete' : 'complete'
    var boundary = reason === 'window_end' || reason === 'unread_end'
    return {
      items: items,
      coverage: {
        requested: count,
        inspected: items.length,
        scrolls: scrolls,
        partial: (items.length < count && !boundary) || repliesState === 'incomplete' || skippedUndated > 0,
        reason: reason,
        elapsed_ms: Math.max(0, Math.round(now() - started)),
        replies: repliesState,
        collapsed_threads: Math.min(100, collapsed),
        skipped_undated: Math.min(100, skippedUndated),
      },
    }
  }

  // --- DOM side (runs only inside the authorized Teams tab) ----------------------------------

  function text(el) { return el ? String(el.innerText || el.textContent || '') : '' }

  /** First descendant matching `selector` that belongs to this message, not a nested reply. */
  function own(el, selector) {
    var found = el.querySelectorAll(selector)
    for (var i = 0; i < found.length; i++) if (found[i].closest(ITEM) === el) return found[i]
    return null
  }

  function ownAll(el, selector) {
    return Array.prototype.filter.call(el.querySelectorAll(selector), function (n) { return n.closest(ITEM) === el })
  }

  function signedOut(doc) {
    return !!doc.querySelector('input[type=password], input[name=loginfmt], #i0116')
  }

  function blocked(doc) {
    var nodes = doc.querySelectorAll('[role=alert], [role=alertdialog], [data-tid="error-page"]')
    for (var i = 0; i < nodes.length; i++) if (BLOCKED.test(text(nodes[i]))) return true
    return false
  }

  /** Signed-in account plus tenant, so an account or tenant switch is detected. */
  function accountHint(doc) {
    var el = doc.querySelector('#mectrl_currentAccount_secondary, #mectrl_currentAccount_primary')
      || doc.querySelector('[data-tid="me-control-avatar-trigger"], button[id="idna-me-control-avatar-trigger"]')
    var who = el ? (el.textContent || el.getAttribute('aria-label') || '') : ''
    // Drop "Profile picture of" prefixes and presence suffixes ("…, Available") that change.
    who = who.replace(/^\s*(?:your profile|profile picture of|profile|account manager for)[,:]?\s*/i, '').split(',')[0]
    var tenantEl = doc.querySelector('[data-tid="tenant-switcher-org-name"], [data-tid="app-bar-tenant-name"], [data-tid="tenant-name"]')
    var tenant = tenantEl ? tenantEl.textContent : ''
    return core.clip(who + (tenant && core.clip(tenant, 80) ? ' · ' + core.clip(tenant, 80) : ''), 160)
  }

  /** The one open chat/channel. Null when none is open (Activity, Calendar, search…). */
  function conversation(doc, href) {
    var channel = doc.querySelector(CHANNEL_TITLE)
    var el = channel || doc.querySelector(CHAT_TITLE)
    if (!el) return null
    var label = core.clip(el.textContent || el.getAttribute('aria-label') || '', 160)
    if (!label) return null
    var kind = channel ? 'channel' : 'chat'
    var thread = (String(href || '').match(THREAD) || [''])[0]
    return { kind: kind, label: label, fp: core.fingerprint(kind + '|' + label + '|' + thread) }
  }

  function scroller(el) {
    for (var node = el; node && node !== node.ownerDocument.body; node = node.parentElement) {
      var style = node.ownerDocument.defaultView.getComputedStyle(node)
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node
    }
    return el
  }

  function keyOf(el) {
    var body = own(el, BODY)
    var id = el.getAttribute('data-mid') || (body && body.id ? body.id.replace(/^content-/, '') : '')
    if (!id) { var mb = own(el, '[id^="message-body-"]'); id = mb ? mb.id.replace(/^message-body-/, '') : '' }
    return id || el.id || ''
  }

  function readItems(box, doc) {
    var divider = box.querySelector(DIVIDER)
    if (!divider) {
      var seps = box.querySelectorAll('[role=separator]')
      for (var s = 0; s < seps.length; s++) if (/\b(new messages|unread)\b/i.test(text(seps[s]))) { divider = seps[s]; break }
    }
    var lastAuthor = ''
    return Array.prototype.map.call(box.querySelectorAll(ITEM), function (el) {
      var parent = el.parentElement ? el.parentElement.closest(ITEM) : null
      var authorEl = own(el, AUTHOR)
      var author = authorEl ? core.clip(text(authorEl), 200) : ''
      // Teams omits the name on consecutive messages from the same person.
      if (author) lastAuthor = author
      else if (!parent) author = lastAuthor
      var timeEl = own(el, 'time')
      var permalink = own(el, 'a[data-tid="message-permalink"]')
      var summary = own(el, REPLIES_SUMMARY)
      var nested = el.querySelector(ITEM)
      return {
        key: keyOf(el),
        author: author,
        time: timeEl ? core.clip(timeEl.textContent || timeEl.getAttribute('aria-label') || '', 80) : '',
        timestamp: timeEl ? timeEl.getAttribute('datetime') : null,
        text: text(own(el, BODY)),
        mentions: ownAll(el, MENTION).map(function (m) { return text(m) }),
        link: permalink ? permalink.getAttribute('href') : null,
        reply: !!parent || /reply/i.test(el.getAttribute('data-tid') || ''),
        rootKey: parent ? keyOf(parent) : '',
        afterDivider: divider ? !!(divider.compareDocumentPosition(el) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING) : null,
        collapsedReplies: !!summary && !nested,
      }
    })
  }

  async function readTimeline(doc, scope, progress) {
    var box = doc.querySelector(VIEWPORT)
    if (!box) return { error: signedOut(doc) ? 'login_required' : 'unsupported_layout' }
    var el = scroller(box)
    var midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    var result = await collectTimeline({
      items: function () { return readItems(box, doc) },
      getScroll: function () { return el.scrollTop },
      setScroll: function (top) { el.scrollTop = top },
      toNewest: function () { el.scrollTop = el.scrollHeight },
      viewport: function () { return el.clientHeight || 400 },
      atStart: function () { return el.scrollTop <= 2 },
      wait: function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) },
      aborted: function () { return state.aborted },
      progress: progress,
    }, { mode: scope.mode, count: scope.count, replies: scope.replies, since: midnight.getTime() })
    if (state.aborted) return { error: 'cancelled' }
    if (!result.items.length && scope.mode === 'latest') return { error: 'empty_conversation' }
    return { result: result }
  }

  var api = {
    collectTimeline: collectTimeline,
    safeLink: safeLink,
    conversation: conversation,
    /** Called by the service worker before sharing and before every read. */
    probe: function () {
      var doc = root.document
      var conv = conversation(doc, root.location.href)
      return {
        origin: root.location.origin,
        account: accountHint(doc),
        signedOut: signedOut(doc),
        blocked: blocked(doc),
        conversation: conv,
      }
    },
    read: async function (scope, jobId) {
      state.aborted = false
      var doc = root.document
      var base = { origin: root.location.origin, account: accountHint(doc) }
      var conv = conversation(doc, root.location.href)
      base.conversation = conv ? conv.fp : null
      var error = null
      var out = null
      if (blocked(doc)) error = 'org_blocked'
      else if (signedOut(doc)) error = 'login_required'
      else if (!conv) error = 'nothing_selected'
      else if (conv.fp !== scope.source) error = 'conversation_changed' // never read another chat
      else {
        out = await readTimeline(doc, scope, function (n) {
          try { chrome.runtime.sendMessage({ type: 'latent.progress', jobId: jobId, inspected: n }) } catch (e) { /* worker restarts are harmless */ }
        })
        error = out.error || null
      }
      return { origin: base.origin, account: base.account, conversation: base.conversation, error: error, result: out && out.result ? out.result : null }
    },
    abort: function () { state.aborted = true },
  }
  root.__latentTeams = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(globalThis)
