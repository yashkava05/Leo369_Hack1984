// Run with: node --test browser-extension/test
// Teams Web reader (#68). Fake people and fake companies only.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const core = require('../bridge-core.js')
const teams = require('../providers/teams.js')

const NOW = Date.parse('2026-11-08T15:00:00Z')
const MIDNIGHT = Date.parse('2026-11-08T05:00:00Z') // local midnight in a fake UTC-5 zone

/**
 * A virtualized timeline, newest at the bottom: only messages near the viewport are rendered.
 * opts.dividerAt: index of the first unread message (the "New messages" divider sits above it).
 */
function timeline(total, opts = {}) {
  const rowHeight = 60
  const viewportHeight = opts.viewport ?? 300
  const msgs = opts.messages ?? Array.from({ length: total }, (_, i) => ({
    key: `1700000${String(i).padStart(4, '0')}`,
    author: i % 2 ? 'Avery Chen' : 'Sam Rivera',
    time: `${(i % 12) + 1}:00 PM`,
    timestamp: new Date(NOW - (total - i) * 30 * 60 * 1000).toISOString(),
    text: `Message ${i} about the Fabrikam rollout.`,
    mentions: [],
    link: null,
    reply: false,
    rootKey: '',
    collapsedReplies: false,
  }))
  const height = msgs.length * rowHeight
  let top = opts.startTop ?? 0
  const state = { aborted: false, waits: 0, progress: [], scrolledTo: [] }
  const adapter = {
    items() {
      const first = Math.max(0, Math.floor(top / rowHeight) - 1)
      const last = Math.min(msgs.length, Math.ceil((top + viewportHeight) / rowHeight) + 1)
      const dividerRendered = opts.dividerAt != null && opts.dividerAt >= first && opts.dividerAt <= last
      const out = msgs.slice(first, last).map((m, j) => ({
        ...m,
        afterDivider: dividerRendered ? first + j >= opts.dividerAt : null,
      }))
      // Teams re-renders: occasionally the same message shows up twice.
      if (opts.rerender && out.length) out.push({ ...out[out.length - 1] })
      return out
    },
    getScroll: () => top,
    setScroll: (v) => { state.scrolledTo.push(v); top = Math.max(0, Math.min(v, Math.max(0, height - viewportHeight))) },
    toNewest: () => { top = Math.max(0, height - viewportHeight) },
    viewport: () => viewportHeight,
    atStart: () => top <= 2,
    wait: async () => {
      state.waits++
      if (opts.abortAfter && state.waits >= opts.abortAfter) state.aborted = true
    },
    aborted: () => state.aborted,
    progress: (n) => state.progress.push(n),
  }
  return { adapter, state, msgs, getTop: () => top }
}

const run = (adapter, opts) => teams.collectTimeline(adapter, { settleMs: 0, now: () => NOW, since: MIDNIGHT, ...opts })

test('reads the newest N in chronological order and restores the scroll position', async () => {
  const { adapter, msgs, getTop } = timeline(60, { startTop: 600 })
  const out = await run(adapter, { mode: 'latest', count: 10 })
  assert.equal(out.items.length, 10)
  assert.deepEqual(out.items.map((m) => m.text), msgs.slice(50).map((m) => m.text))
  assert.equal(out.coverage.reason, 'count_reached')
  assert.equal(out.coverage.partial, false)
  assert.equal(out.coverage.replies, 'not_requested')
  assert.equal(getTop(), 600)
  assert.ok(out.items.every((m) => /^t_[0-9a-f]{16}$/.test(m.id)))
})

test('never reads more than 20 messages', async () => {
  const { adapter } = timeline(100)
  const out = await run(adapter, { mode: 'latest', count: 500, maxScrolls: 100 })
  assert.equal(out.items.length, 20)
  assert.equal(out.coverage.requested, 20)
})

test('deduplicates re-rendered messages across scrolls', async () => {
  const { adapter } = timeline(40, { rerender: true })
  const out = await run(adapter, { mode: 'latest', count: 15 })
  const texts = out.items.map((m) => m.text)
  assert.equal(new Set(texts).size, texts.length)
  assert.equal(out.items.length, 15)
})

test('short history reports list_end and partial coverage honestly', async () => {
  const { adapter } = timeline(4)
  const out = await run(adapter, { mode: 'latest', count: 10 })
  assert.equal(out.items.length, 4)
  assert.equal(out.coverage.reason, 'list_end')
  assert.equal(out.coverage.partial, true)
})

test('scroll and time budgets stop the read', async () => {
  let { adapter } = timeline(200, { viewport: 120 })
  let out = await run(adapter, { mode: 'latest', count: 20, maxScrolls: 2 })
  assert.equal(out.coverage.reason, 'budget')
  assert.equal(out.coverage.partial, true)
  let clock = NOW
  ;({ adapter } = timeline(200, { viewport: 120 }))
  out = await teams.collectTimeline(adapter, { mode: 'latest', count: 20, settleMs: 0, budgetMs: 1000, now: () => (clock += 400) })
  assert.equal(out.coverage.reason, 'timeout')
})

test('cancel stops between steps and still restores the scroll position', async () => {
  const { adapter, getTop } = timeline(200, { viewport: 120, abortAfter: 2, startTop: 90 })
  const out = await run(adapter, { mode: 'latest', count: 20 })
  assert.equal(out.coverage.reason, 'cancelled')
  assert.equal(getTop(), 90)
})

test('"today" stops at local midnight and treats that boundary as complete', async () => {
  const { adapter, msgs } = timeline(40) // one message every 30 minutes, newest 30 min ago
  const since = NOW - 5 * 60 * 60 * 1000 // "today" started five hours ago
  const out = await run(adapter, { mode: 'today', count: 20, since })
  const expected = msgs.filter((m) => Date.parse(m.timestamp) >= since)
  assert.equal(expected.length, 10)
  assert.deepEqual(out.items.map((m) => m.text), expected.map((m) => m.text))
  assert.equal(out.coverage.reason, 'window_end')
  assert.equal(out.coverage.partial, false)
})

test('"today" skips undated messages and says so', async () => {
  const { adapter, msgs } = timeline(6)
  msgs[4].timestamp = null
  const out = await run(adapter, { mode: 'today', count: 20 })
  assert.equal(out.coverage.skipped_undated, 1)
  assert.equal(out.coverage.partial, true)
})

test('unread reads only messages below the "New messages" divider', async () => {
  const { adapter } = timeline(30, { dividerAt: 26 })
  const out = await run(adapter, { mode: 'unread', count: 10 })
  assert.equal(out.items.length, 4)
  assert.ok(out.items.every((m) => m.unread))
  assert.equal(out.coverage.reason, 'unread_end')
  assert.equal(out.coverage.partial, false)
})

test('unread with more unread than the count stops at the count', async () => {
  const { adapter } = timeline(60, { dividerAt: 30 })
  const out = await run(adapter, { mode: 'unread', count: 5, maxScrolls: 40 })
  assert.equal(out.items.length, 5)
  assert.equal(out.coverage.reason, 'count_reached')
  assert.equal(out.coverage.partial, false)
})

test('unread never guesses when no divider can be found', async () => {
  let { adapter } = timeline(8) // whole history, no divider: nothing is unread
  let out = await run(adapter, { mode: 'unread', count: 10 })
  assert.deepEqual(out.items, [])
  assert.equal(out.coverage.reason, 'unread_end')
  ;({ adapter } = timeline(200, { viewport: 120 })) // budget hit before any divider
  out = await run(adapter, { mode: 'unread', count: 10, maxScrolls: 2 })
  assert.deepEqual(out.items, [])
  assert.equal(out.coverage.partial, true)
})

function thread() {
  const base = (i, extra) => ({
    key: `m${i}`, author: 'Riley Brooks', time: '10:00 AM', timestamp: new Date(NOW - (10 - i) * 60000).toISOString(),
    text: `Post ${i} for Northwind.`, mentions: [], link: null, reply: false, rootKey: '', collapsedReplies: false, ...extra,
  })
  return [
    base(1, { collapsedReplies: true }), // a thread whose replies are not loaded
    base(2),
    base(3, { reply: true, rootKey: 'm2', text: 'Reply to post 2.' }),
    base(4),
  ]
}

test('replies are skipped unless in scope', async () => {
  const { adapter } = timeline(0, { messages: thread() })
  const out = await run(adapter, { mode: 'latest', count: 10 })
  assert.deepEqual(out.items.map((m) => m.reply_to), [null, null, null])
  assert.equal(out.coverage.replies, 'not_requested')
})

test('replies in scope are linked to their root and unloaded threads are reported', async () => {
  const { adapter } = timeline(0, { messages: thread() })
  const out = await run(adapter, { mode: 'latest', count: 10, replies: true })
  assert.equal(out.items.length, 4)
  const reply = out.items.find((m) => m.text === 'Reply to post 2.')
  assert.equal(reply.reply_to, 't_' + core.fingerprint('m2'))
  assert.equal(out.coverage.replies, 'incomplete')
  assert.equal(out.coverage.collapsed_threads, 1)
  assert.equal(out.coverage.partial, true)
})

test('empty system events are not counted as messages', async () => {
  const msgs = thread().slice(0, 2).concat([{ ...thread()[3], key: 'sys', text: '   ' }])
  const { adapter } = timeline(0, { messages: msgs })
  const out = await run(adapter, { mode: 'latest', count: 10 })
  assert.equal(out.items.length, 2)
})

test('only Teams permalinks survive; links are never built', () => {
  assert.equal(teams.safeLink('https://teams.microsoft.com/l/message/19:abc@thread.v2/1700'), 'https://teams.microsoft.com/l/message/19:abc@thread.v2/1700')
  for (const bad of [
    'https://teams.microsoft.com.evil.example/l/message/1/2', 'https://exfil.example/l/message/1/2',
    'http://teams.microsoft.com/l/message/1/2', 'https://teams.microsoft.com/v2/', 'javascript:alert(1)', '', null,
  ]) assert.equal(teams.safeLink(bad), null, String(bad))
})

test('Teams origins are separate from Outlook and lookalikes are rejected', () => {
  for (const url of ['https://teams.microsoft.com/v2/', 'https://teams.cloud.microsoft/', 'https://teams.live.com/v2/']) {
    assert.equal(core.providerForUrl(url).provider, 'teams', url)
  }
  assert.equal(core.providerForUrl('https://outlook.office.com/mail/').provider, 'outlook')
  for (const url of [
    'http://teams.microsoft.com/', 'https://teams.microsoft.com.evil.example/', 'https://evil.example/?u=teams.microsoft.com',
    'https://teams.microsoft.com:8443/', 'https://user:pw@teams.microsoft.com/', 'https://teams-microsoft.com/',
    'https://gov.teams.microsoft.us/', 'https://www.microsoft.com/', 'https://login.microsoftonline.com/',
  ]) assert.equal(core.providerForUrl(url), null, url)
})

test('conversation fingerprint identifies the open chat/channel, not the page', () => {
  const doc = (selector, label) => ({ querySelector: (s) => (s.split(', ').includes(selector) ? { textContent: label, getAttribute: () => null } : null) })
  const chat = teams.conversation(doc('[data-tid="chat-title"]', 'Fabrikam launch'), 'https://teams.microsoft.com/v2/')
  assert.equal(chat.kind, 'chat')
  assert.equal(chat.label, 'Fabrikam launch')
  const channel = teams.conversation(doc('[data-tid="channel-name"]', 'Fabrikam launch'), 'https://teams.microsoft.com/v2/')
  assert.equal(channel.kind, 'channel')
  assert.notEqual(chat.fp, channel.fp)
  assert.equal(teams.conversation(doc('[data-tid="nothing"]', 'x'), ''), null)
})
