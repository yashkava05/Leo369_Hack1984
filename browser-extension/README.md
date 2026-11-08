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

**Stop sharing** in the popup forgets the tab and removes the site permission. Closing the tab
also forgets it. The selection is kept in `chrome.storage.session` (memory only).

## Permissions and why

| Permission | Why |
| --- | --- |
| `optional_host_permissions`: `outlook.office.com`, `outlook.office365.com`, `outlook.live.com`, `outlook.cloud.microsoft` | Requested at runtime, one origin at a time, only when you click **Allow this Outlook tab**. Never all sites. |
| `activeTab` | Lets the popup see which tab you clicked it on. No other tab is inspected. |
| `scripting` | Injects the read-only Outlook reader into the shared tab, only after Latent confirmed a request. There is no always-on content script. |
| `storage` | `chrome.storage.session` only: the shared tab id, origin and an account fingerprint. Memory only. |
| `host_permissions`: `http://127.0.0.1:8000/*` | The local Latent backend. The only `fetch` target in the extension. |
| `externally_connectable`: `localhost:5173` | Only the Latent UI can message the extension; other web pages cannot. |

Not requested: cookies, tabs, history, downloads, webRequest, native messaging, `<all_urls>`.

## How a read works

1. The Latent UI creates a job on the backend and gets a one-time nonce.
2. The UI passes `{jobId, nonce}` to the extension (`chrome.runtime.sendMessage`). The extension
   checks the sender is the Latent UI origin and the message shape.
3. The extension **claims** the job on the backend with its extension origin and the nonce. The
   backend returns the confirmed scope (mode and count); the page message cannot change it.
   Air-gap on → refused before anything is read.
4. Before reading it re-checks the tab still exists, is still an allow-listed Outlook origin,
   still has the grant, is still signed in and is still the same account. Any mismatch fails
   closed with a constant code.
5. The reader takes visible previews from the message list, scrolling at most 15 steps with
   explicit waits and deduplication, stops at the count, list end, scroll budget or 12 s, and
   restores your scroll position. "This selected email" mode reads only the message already
   open in the reading pane.
6. The text goes once to the local backend (nonce, schema, size and scope checked), which
   analyzes it with local Ollama and drops any task without a verbatim supporting quote.

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
