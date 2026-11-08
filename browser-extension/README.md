# PrismLocal Browser Bridge (Chrome extension)

Lets PrismLocal read **one Outlook on the web tab** (issue #67) or **one Teams on the web chat or
channel** (issue #68) that you explicitly share, read-only, for one request you reviewed and
confirmed in PrismLocal. Both reuse `bridge-core.js` and the backend bridge; each has its own
adapter under `providers/` and its own Chrome site permission.

## Load it (unpacked)

1. Start PrismLocal: `./scripts/dev.sh` (backend on `127.0.0.1:8000`, UI on `localhost:5173`).
2. Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose
   this `browser-extension/` folder.
3. The extension ID must be `kemjkilbmidnkohlldbohmgjaljbkdcc` (fixed by the public `key` in
   `manifest.json`). The backend only accepts this ID; to use another build, set
   `LATENT_EXTENSION_IDS='["<id>"]'` for the backend and `VITE_LATENT_EXTENSION_ID=<id>` for the UI.
4. Open Outlook on the web in the same Chrome profile and sign in as usual.
5. On the Outlook tab, click the PrismLocal toolbar icon → **Allow this Outlook tab** → accept
   Chrome's prompt for that one Outlook site.
6. In PrismLocal, tap the mic, say e.g. "Check my latest ten Outlook emails and tell me what
   needs my attention", review the text, choose **Check Outlook**, check the scope, then
   **Read N emails**.

**Stop sharing** in the popup (or in PrismLocal) forgets the tab and removes the site permission.
Closing the tab, or navigating it away from the shared Outlook site, also forgets it. The
selection (tab id, origin, an account fingerprint and the plain account label shown in the
popup and in PrismLocal) is kept in `chrome.storage.session`: memory only, cleared when Chrome
exits. While a read runs, the toolbar icon shows a **READ** badge.

## Permissions and why

| Permission | Why |
| --- | --- |
| `optional_host_permissions`: `outlook.office.com`, `outlook.office365.com`, `outlook.live.com`, `outlook.cloud.microsoft` | Requested at runtime, one origin at a time, only when you click **Allow this Outlook tab**. Never all sites. |
| `optional_host_permissions`: `teams.microsoft.com`, `teams.cloud.microsoft`, `teams.live.com` | Requested separately, only when you click **Allow this Teams chat**. An Outlook grant never covers Teams. |
| `activeTab` | Lets the popup see which tab you clicked it on. No other tab is inspected. |
| `scripting` | Injects the read-only Outlook reader into the shared tab, only after PrismLocal confirmed a request. There is no always-on content script. |
| `storage` | `chrome.storage.session` only: the shared tab id, origin, account fingerprint and account label. Memory only. |
| `host_permissions`: `http://127.0.0.1:8000/*` | The local PrismLocal backend. The only `fetch` target in the extension. |
| `externally_connectable`: `localhost:5173` | Only pages on `http://localhost:5173` can message the extension (see the trust boundary below). |

Not requested: cookies, tabs, history, downloads, webRequest, native messaging, `<all_urls>`.

## Trust boundary

- Pages on any other origin cannot message the extension, and the backend rejects their
  requests.
- A page that *is* on `http://localhost:5173` but is not PrismLocal (another project's dev server
  using that port while PrismLocal is stopped, or a malicious dependency of such a project) can
  message the extension, but it cannot start a read: creating a job needs the backend's
  per-launch secret, which only PrismLocal's own Vite proxy adds (read from a 0600 file the backend
  writes at startup), so page JavaScript never holds it. Such a page can still call
  `latent.hello` (it learns whether a tab is shared, its Outlook origin and account label) and
  `latent.forget` (it can un-share the tab).
- An XSS inside PrismLocal's own UI would run behind the proxy and could start a read. The **READ**
  badge in Chrome's toolbar makes every read visible; reads stay bounded to the scope limits
  (max 20 previews, read-only) and to the tab the user shared.
- Local processes running as the same user are out of scope (they can read the secret file).
  Requests without an Origin header cannot create jobs.
- The browser agent works only through the Vite dev proxy (`./scripts/dev.sh`); with
  `VITE_API_URL` pointing straight at the backend, job creation is refused.

## How a read works

1. The PrismLocal UI creates a job on the backend (through PrismLocal's proxy, which adds the launch
   secret) and gets a one-time nonce.
2. The UI passes `{jobId, nonce}` to the extension (`chrome.runtime.sendMessage`). The extension
   checks the sender is the PrismLocal UI origin and the message shape.
3. The extension shows the **READ** badge and **claims** the job on the backend with its extension origin and the nonce. The
   backend returns the confirmed scope (mode and count); the page message cannot change it.
   Air-gap on → refused before anything is read.
4. Before injecting anything it checks the tab's URL is still the shared Outlook origin, then
   re-checks the tab still exists, is still an allow-listed Outlook origin,
   still has the grant, is still signed in and is still the same account. Any mismatch fails
   closed with a constant code.
5. The reader takes visible previews from the message list, scrolling at most 15 steps with
   explicit waits and deduplication, stops at the count, list end, scroll budget or 12 s, and
   restores your scroll position. Coverage reports both the messages kept and the rows
   examined (they differ in unread mode). "This selected email" mode reads only the message
   already open in the reading pane, never an inline reply editor; if a conversation shows
   several message bodies and none is uniquely expanded, it stops with "unsupported layout".
6. The text goes once to the local backend (nonce, schema, size and scope checked), which
   analyzes it with local Ollama. A task survives only if its quote is a whole sentence of the
   email (shown as the email wrote it), the task restates that sentence, and nothing in it is
   an instruction to an assistant. Emails that carry such instructions produce no tasks.
   Summaries may not add numbers, dates or urgency the email does not contain.
7. Results stay in the backend's memory for at most 5 minutes after they are ready (the UI
   deletes them as soon as it has displayed them); a new request wipes all earlier ones.

## Side effects and network boundaries

- PrismLocal never clicks a message, so it does not mark mail as read itself. Opening a message
  yourself (before using "this selected email") may mark it read. Scrolling the list can make
  Outlook load more mail from Microsoft: that is browser network traffic (shown as
  **Browser · Internet** in PrismLocal), not traffic from PrismLocal's backend, and `egress.py` does
  not control it. Air-gap stops PrismLocal from reading; it does not disconnect other tabs.
- Your cookies, passwords and tokens stay in Chrome. The extension never reads them.

## Teams on the web (#68)

1. Open Teams on the web (Chrome desktop) in the same profile, sign in as usual, and open the
   **one chat or channel** PrismLocal may read. Government clouds (`*.microsoft.us`) and the native
   Teams apps are not supported.
2. Click the PrismLocal icon → **Allow this Teams chat** → accept Chrome's prompt for that Teams site.
   The popup records the open conversation (its title and an opaque fingerprint), the account
   and the tenant name. If no chat/channel is open, sharing fails with "nothing selected".
3. In PrismLocal, tap the mic, say e.g. "What have I been asked to do in this channel?", review the
   text, choose **Check Teams**, tick **Read only this channel: …**, check the scope (most recent,
   today or unread; at most 20; replies only for channels and only when ticked), then read.

How it stays scoped:
- PrismLocal never searches or picks a conversation. If your request names another chat ("in the
  Finance channel") PrismLocal says so and still reads only the shared one, after you confirm it.
- The backend binds the job to the fingerprint you confirmed. The extension refuses to read if
  the tab now shows another conversation, account or tenant (`conversation_changed`,
  `account_changed`), the grant was revoked, you are signed out, or the organization blocks it.
- The reader scrolls the open timeline from the newest message upward (at most 15 steps,
  explicit waits, 12 s), deduplicates re-rendered messages, stops at the count, the start of
  today, the "New messages" divider or the top of the history, and scrolls back. It never
  clicks, so collapsed thread replies are **not expanded**: they are reported as incomplete.
  In unread mode, if no "New messages" divider can be found PrismLocal returns nothing rather than
  guess.
- A message link is kept only if Teams itself rendered a message permalink; otherwise PrismLocal
  shows an honest locator (conversation · author · time). It never builds a link.
- Tasks need an explicit request quoted verbatim from the message; the owner is shown only
  when the message @mentions or names that person, otherwise it is "unknown". Messages with
  instructions aimed at an assistant are flagged and produce no tasks or summary points.

Read receipts: Teams may mark messages as read or send read receipts while a conversation is
open or scrolled, depending on your and your organization's settings. PrismLocal cannot promise a
silent read, and scrolling also makes Teams load older messages from Microsoft (browser
network traffic, shown as **Browser · Internet**).

## Tests

```bash
node --test browser-extension/test
```

`bridge-core.test.js` covers the bounded virtualized-list reader (count, max 20, dedup, lazy load, scroll and time
budgets, cancel, scroll restore), the origin allowlist, page-message validation and static
checks that the extension has no write/navigation/cookie code or extra permissions.
`teams.test.js` covers the Teams timeline reader (newest-first, max 20, dedup, today/unread
boundaries, replies in/out of scope, unloaded threads, budgets, cancel, scroll restore,
permalink filter, origin allowlist). `worker.test.js` runs `background.js` in a sandbox with a
fake `chrome`: separate Teams grant, confirmed conversation, account/conversation switches,
revoked grant, cancel dropping late results, and the unchanged Outlook payload.

Live Outlook DOM selectors are in `providers/outlook.js` and Teams selectors in
`providers/teams.js`; validate them against a real signed-in session before a demo (see the
PRs for the manual checklists).
