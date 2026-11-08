/*
 * Outlook on the web adapter (#67). Injected only into the one tab the user authorized, and
 * only after Latent's backend accepted a confirmed request. Read-only by construction: it reads
 * rendered text and scrolls the message list (then restores it). It never clicks, opens,
 * composes, follows links, downloads attachments or touches cookies/storage.
 *
 * Layout notes (verify on the demo laptop, Outlook changes its DOM often):
 * - The message list is a [role=listbox] of [role=option] rows; aria-label starts with
 *   "Unread" for unread mail. Row ids come from data-convid / data-item-id / id.
 * - The reading pane body is [aria-label="Message body"] inside [role=main].
 */
;(function (root) {
  'use strict'
  var core = root.LatentBridge
  var TIME = /^(?:\d{1,2}:\d{2}\s?(?:AM|PM)?|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*(?:\s+\d{1,2}[:/]\d{2}(?:\s?(?:AM|PM))?)?|Yesterday|Today|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}(?:,\s*\d{4})?)$/i
  var state = root.__latentOutlookState || (root.__latentOutlookState = { aborted: false })

  function lines(el) {
    return String(el.innerText || el.textContent || '').split('\n')
      .map(function (s) { return s.trim() }).filter(Boolean)
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

  function list(doc) {
    var boxes = doc.querySelectorAll('[role=listbox]')
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].querySelector('[role=option]')) return boxes[i]
    }
    return null
  }

  function scroller(el) {
    for (var node = el; node && node !== node.ownerDocument.body; node = node.parentElement) {
      var style = node.ownerDocument.defaultView.getComputedStyle(node)
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node
    }
    return el
  }

  function parseRow(row) {
    var parts = lines(row)
    var label = row.getAttribute('aria-label') || ''
    var timeIndex = -1
    for (var i = 0; i < parts.length; i++) { if (TIME.test(parts[i])) { timeIndex = i; break } }
    var rest = parts.filter(function (_, i) { return i !== timeIndex })
    return {
      key: row.getAttribute('data-convid') || row.getAttribute('data-item-id') || row.id || label,
      sender: rest[0] || '',
      subject: rest[1] || '',
      time: timeIndex === -1 ? '' : parts[timeIndex],
      preview: rest.slice(2).join(' '),
      unread: /^\s*unread\b/i.test(label) || /\bunread\b/i.test(row.className || ''),
    }
  }

  async function readList(doc, scope, progress) {
    var box = list(doc)
    if (!box) return { error: signedOut(doc) ? 'login_required' : 'unsupported_layout' }
    var el = scroller(box)
    var result = await core.collectRows({
      rows: function () {
        return Array.prototype.map.call(box.querySelectorAll('[role=option]'), parseRow)
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
    if (!result.items.length) return { error: scope.mode === 'unread' ? null : 'empty_mailbox', result: result }
    return { result: result }
  }

  function readSelected(doc) {
    var body = doc.querySelector('[role=main] [aria-label="Message body"], [aria-label="Message body"]')
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
        coverage: { requested: 1, inspected: 1, scrolls: 0, partial: false, reason: 'selected_message', elapsed_ms: 0 },
      },
    }
  }

  root.__latentOutlook = {
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
