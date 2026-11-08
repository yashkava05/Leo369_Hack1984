# Latent Browser Bridge (Chrome extension)

Lets Latent read **one Outlook on the web tab you explicitly share**, read-only, for one
request you reviewed and confirmed in Latent (issue #67). Teams Web (#68) will reuse
`bridge-core.js` and the backend bridge with its own adapter under `providers/`.

## Load it (unpacked)

1. Start Latent: `./scripts/dev.sh` (backend on `127.0.0.1:8000`, UI on `localhost:5173`).
2. Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose
   this `browser-extension/` folder.
3. The extension ID must be `kemjkilbmidnkohlldbohmgjaljbkdcc` (fixed by the public `key` in
   `manifest.json`). The backend only accepts this ID; to use another build, set
   `LATENT_EXTENSION_IDS='["<id>"]'` for the backend and `VITE_LATENT_EXTENSION_ID=<id>` for the UI.
4. Open Outlook on the web in the same Chrome profile and sign in as usual.
5. On the Outlook tab, click the Latent toolbar icon → **Allow this Outlook tab** → accept
   Chrome's prompt for that one Outlook site.
6. In Latent, tap the mic, say e.g. "Check my latest ten Outlook emails and tell me what
   needs my attention", review the text, choose **Check Outlook**, check the scope, then
   **Read N emails**.

**Stop sharing** in the popup (or in Latent) forgets the tab and removes the site permission.
Closing the tab, or navigating it away from the shared Outlook site, also forgets it. The
selection (tab id, origin, an account fingerprint and the plain account label shown in the
popup and in Latent) is kept in `chrome.storage.session`: memory only, cleared when Chrome
exits. While a read runs, the toolbar icon shows a **READ** badge.

## Permissions and why

| Permission | Why |
| --- | --- |
| `optional_host_permissions`: `outlook.office.com`, `outlook.office365.com`, `outlook.live.com`, `outlook.cloud.microsoft` | Requested at runtime, one origin at a time, only when you click **Allow this Outlook tab**. Never all sites. |
| `activeTab` | Lets the popup see which tab you clicked it on. No other tab is inspected. |
| `scripting` | Injects the read-only Outlook reader into the shared tab, only after Latent confirmed a request. There is no always-on content script. |
| `storage` | `chrome.storage.session` only: the shared tab id, origin, account fingerprint and account label. Memory only. |
| `host_permissions`: `http://127.0.0.1:8000/*` | The local Latent backend. The only `fetch` target in the extension. |
| `externally_connectable`: `localhost:5173` | Only pages on `http://localhost:5173` can message the extension (see the trust boundary below). |

Not requested: cookies, tabs, history, downloads, webRequest, native messaging, `<all_urls>`.

## Trust boundary

- Pages on any other origin cannot message the extension, and the backend rejects their
  requests.
- A page that *is* on `http://localhost:5173` but is not Latent (another project's dev server
  using that port while Latent is stopped, or a malicious dependency of such a project) can
  message the extension, but it cannot start a read: creating a job needs the backend's
  per-launch secret, which only Latent's own Vite proxy adds (read from a 0600 file the backend
  writes at startup), so page JavaScript never holds it. Such a page can still call
  `latent.hello` (it learns whether a tab is shared, its Outlook origin and account label) and
  `latent.forget` (it can un-share the tab).
- An XSS inside Latent's own UI would run behind the proxy and could start a read. The **READ**
  badge in Chrome's toolbar makes every read visible; reads stay bounded to the scope limits
  (max 20 previews, read-only) and to the tab the user shared.
- Local processes running as the same user are out of scope (they can read the secret file).
  Requests without an Origin header cannot create jobs.
- The browser agent works only through the Vite dev proxy (`./scripts/dev.sh`); with
  `VITE_API_URL` pointing straight at the backend, job creation is refused.

## How a read works

1. The Latent UI creates a job on the backend (through Latent's proxy, which adds the launch
   secret) and gets a one-time nonce.
2. The UI passes `{jobId, nonce}` to the extension (`chrome.runtime.sendMessage`). The extension
   checks the sender is the Latent UI origin and the message shape.
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

- Latent never clicks a message, so it does not mark mail as read itself. Opening a message
  yourself (before using "this selected email") may mark it read. Scrolling the list can make
  Outlook load more mail from Microsoft: that is browser network traffic (shown as
  **Browser · Internet** in Latent), not traffic from Latent's backend, and `egress.py` does
  not control it. Air-gap stops Latent from reading; it does not disconnect other tabs.
- Your cookies, passwords and tokens stay in Chrome. The extension never reads them.

## Tests

```bash
node --test browser-extension/test
```

Covers the bounded virtualized-list reader (count, max 20, dedup, lazy load, scroll and time
budgets, cancel, scroll restore), the origin allowlist, page-message validation and static
checks that the extension has no write/navigation/cookie code or extra permissions.

Live Outlook DOM selectors are in `providers/outlook.js`; validate them against a real signed-in
inbox before a demo (see the PR for the manual checklist).
