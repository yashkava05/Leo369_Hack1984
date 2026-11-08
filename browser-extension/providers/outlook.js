/*
 * Outlook on the web adapter (#67). Injected only into the one tab the user authorized, and
 * only after PrismLocal's backend accepted a confirmed request. Read-only by construction: it reads
 * rendered text and scrolls the message list (then restores it). It never clicks, opens,
 * composes, follows links, downloads attachments or touches cookies/storage.
 *
 * Layout notes (verify on the demo laptop, Outlook changes its DOM often):
 * - The message list is a [role=listbox] of [role=option] rows carrying data-convid; the
 *   aria-label starts with "Unread" for unread mail. Other listboxes (search suggestions,
 *   people pickers) are ignored.
 * - The reading pane body is a read-only [aria-label="Message body"] inside [role=main].
 */
;(function (root) {
  'use strict'
  var core = root.LatentBridge
  // Anchored: a whole line must be a time or date. Day names need a word boundary, so senders
  // such as "Monica", "Satish" or "Sundar" are never mistaken for a time.
  var DAY = '(?:Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)'
  var CLOCK = '\\d{1,2}:\\d{2}(?:\\s?[AP]M)?'
  var DATE = '\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?'
  var MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2}(?:,\\s*\\d{4})?'
  var TIME = new RegExp('^(?:' + CLOCK + '|' + DAY + '\\.?(?:\\s+(?:' + DATE + '|' + CLOCK + '))?(?:\\s+' + CLOCK + ')?'
    + '|Yesterday|Today|' + DATE + '|' + MONTH + ')$', 'i')
  var state = root.__latentOutlookState || (root.__latentOutlookState = { aborted: false })

  function isTime(line) { return TIME.test(String(line || '').trim()) }

  function lines(el) {
    return String(el.innerText || el.textContent || '').split('\n')
      .map(function (s) { return s.trim() }).filter(Boolean)
  }

  /** Pure row parser (tested in Node): visible lines + aria-label -> fields. */
  function parseRowText(parts, label, key) {
    var timeIndex = -1
    for (var i = 0; i < parts.length; i++) { if (isTime(parts[i])) { timeIndex = i; break } }
    var rest = parts.filter(function (_, j) { return j !== timeIndex })
    return {
      key: key || '',
      sender: rest[0] || '',
      subject: rest[1] || '',
      time: timeIndex === -1 ? '' : parts[timeIndex],
      preview: rest.slice(2).join(' '),
      unread: /^\s*unread\b/i.test(label || ''),
    }
  }

  function signedOut(doc) {
    return !!doc.querySelector('input[type=password], input[name=loginfmt], #i0116')
  }

  function accountHint(doc) {
    var el = doc.querySelector('#mectrl_currentAccount_secondary, #mectrl_currentAccount_primary')
      || doc.querySelector('[aria-label^="Account manager for"]')
    var text = el ? (el.textContent || el.getAttribute('aria-label') || '') : ''
    return core.clip(text.replace(/^Account manager for\s*/i, ''), 120)
  }

  /** The mail list: the listbox whose options carry conversation ids, else none at all. */
  function list(doc) {
    var best = null
    var bestCount = 0
    var boxes = doc.querySelectorAll('[role=listbox]')
    for (var i = 0; i < boxes.length; i++) {
      var count = boxes[i].querySelectorAll('[role=option][data-convid], [role=option][data-item-id]').length
      if (count > bestCount) { best = boxes[i]; bestCount = count }
    }
    return best
  }

  function scroller(el) {
    for (var node = el; node && node !== node.ownerDocument.body; node = node.parentElement) {
      var style = node.ownerDocument.defaultView.getComputedStyle(node)
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node
    }
    return el
  }

  function parseRow(row) {
    var key = row.getAttribute('data-convid') || row.getAttribute('data-item-id') || ''
    return parseRowText(lines(row), row.getAttribute('aria-label') || '', key)
  }

  async function readList(doc, scope, progress) {
    var box = list(doc)
    if (!box) return { error: signedOut(doc) ? 'login_required' : 'unsupported_layout' }
    var el = scroller(box)
    var rendered = 0
    var parsed = 0
    var result = await core.collectRows({
      rows: function () {
        var rows = Array.prototype.map.call(box.querySelectorAll('[role=option]'), parseRow)
        rendered += rows.length
        var usable = rows.filter(function (r) { return r.key && (r.sender || r.subject) })
        parsed += usable.length
        return usable
      },
      getScroll: function () { return el.scrollTop },
      setScroll: function (top) { el.scrollTop = top },
      viewport: function () { return el.clientHeight || 400 },
      atEnd: function () { return el.scrollTop + el.clientHeight >= el.scrollHeight - 2 },
      wait: function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) },
      aborted: function () { return state.aborted },
      progress: progress,
    }, scope)
    if (state.aborted) return { error: 'cancelled' }
    // Rows on screen that could not be parsed mean the layout changed, not an empty inbox.
    if (rendered && !parsed) return { error: 'unsupported_layout' }
    if (!rendered) return { error: 'empty_mailbox' }
    return { result: result }
  }

  function readOnlyBody(el) {
    return !el.isContentEditable && !el.closest('[contenteditable=""], [contenteditable="true"]')
  }

  function readSelected(doc) {
    var bodies = Array.prototype.filter.call(doc.querySelectorAll('[aria-label="Message body"]'), readOnlyBody)
    if (bodies.length > 1) {
      // Conversation view: use the one expanded message, never guess between several.
      var expanded = bodies.filter(function (b) { return b.closest('[aria-expanded="true"]') })
      bodies = expanded.length === 1 ? expanded : []
      if (!bodies.length) return { error: 'unsupported_layout' }
    }
    var body = bodies[0]
    if (!body) return { error: signedOut(doc) ? 'login_required' : 'nothing_selected' }
    var pane = body.closest('[role=main]') || doc
    var heading = pane.querySelector('[role=heading]')
    var from = pane.querySelector('[aria-label^="From"], [data-testid="SenderPersona"]')
    var subject = heading ? core.clip(heading.textContent, 300) : ''
    var sender = from ? core.clip((from.textContent || from.getAttribute('aria-label') || '').replace(/^From:?\s*/i, ''), 200) : ''
    return {
      result: {
        items: [{
          id: 'o_' + core.fingerprint(subject + '|' + sender),
          sender: sender, time: '', subject: subject, preview: '',
          body: core.clip(lines(body).join(' '), 8000), unread: false,
        }],
        coverage: { requested: 1, inspected: 1, examined: 1, scrolls: 0, partial: false, reason: 'selected_message', elapsed_ms: 0 },
      },
    }
  }

  root.__latentOutlook = {
    isTime: isTime,
    parseRowText: parseRowText,
    /** Called by the service worker; returns {account} so the bridge can detect account switches. */
    probe: function () {
      var doc = root.document
      return { origin: root.location.origin, account: accountHint(doc), signedOut: signedOut(doc) }
    },
    read: async function (scope, jobId) {
      state.aborted = false
      var doc = root.document
      var progress = function (n) {
        try { chrome.runtime.sendMessage({ type: 'latent.progress', jobId: jobId, inspected: n }) } catch (e) { /* worker restarts are harmless */ }
      }
      var out = scope.mode === 'selected' ? readSelected(doc) : await readList(doc, scope, progress)
      return { origin: root.location.origin, account: accountHint(doc), error: out.error || null, result: out.result || null }
    },
    abort: function () { state.aborted = true },
  }
})(globalThis)
