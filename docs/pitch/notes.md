# Latent — pitch deck (slide text + speaker notes)

Six slides, presentable in ≤ 3 minutes. Speaker notes are ≤ 60 words each. The deck source
is [`index.html`](./index.html); the exported PDF is [`../pitch.pdf`](../pitch.pdf).

Privacy claim used throughout: **"No image or raw text leaves the device — enforced by code and
shown in the audit log."** (Never "guarantees zero leakage".)

All numbers trace to the repo:
- Six egress rules, the 4 KB cap and loopback-only Ollama: `backend/app/egress.py` (docstring +
  `MAX_BODY_BYTES = 4096`, `ALLOWED_HOSTS`, `LOOPBACK_HOSTS`, `_check`).
- 10 eval screenshots: `eval/screenshots/` and `eval/expected.json`.
- Intent accuracy / leaks / latency: `eval/results.md` — **placeholders until the eval is run**
  (needs Ollama; see PR notes).
- Affiliate hook: shipped — `backend/app/affiliate.py` `tag_url` is wired into `backend/app/pipeline/cards.py` (3 call sites), through which every commercial URL routes; it returns the URL unchanged until a partner tag is set.

---

## Slide 1 — Problem

**On slide**
- Your camera roll is a graveyard of intentions.
- We screenshot concert flyers, products, books, places and charts meaning to act — then they're
  buried forever.
- Cloud screen assistants can't touch a work device: "read my screen" tools ship pixels to someone
  else's servers. Under NDAs and compliance duties (SOC 2 / HIPAA / GDPR), that's a non-starter.
- So the intent dies.

**Speaker notes** (55 words)
We all screenshot things we mean to act on — a flyer, a product, a chart — then they vanish into
the camera roll. Cloud "read my screen" assistants could help, but they upload your pixels. On a
work phone under an NDA or compliance rules, the useful screenshots are exactly the ones you can't
send. So nothing happens.

---

## Slide 2 — Latent

**On slide**
- Drop a screenshot. Get actions — privately.
- A vision model understands the screenshot **on your machine**, private data is scrubbed, and only
  short text queries leave — blooming into action cards.
- **No image or raw text leaves the device — enforced by code and shown in the audit log.**
- Still: action-card gallery (`docs/screenshots/card-gallery.png`).

**Speaker notes** (47 words)
Latent is a local-first memory agent. Drop a screenshot: a vision model reads it on your machine,
a scrubber strips anything private, and only short text queries ever leave — enforced by code and
shown in the audit log. They bloom into action cards you can act on. Let me show you.

> **→ Hand off to the live demo here (after slide 2).**

---

## Slide 3 — Architecture

**On slide**
- One door to the network.
- **Local zone (your machine):** Qwen2.5-VL via Ollama (loopback only, image bytes stay in memory)
  → PII scrubber (Presidio + spaCy, counts never values) → query builder (short text from public
  entities + fixed templates).
- → **Egress guard** (`egress.py`) → **Network zone:** Tavily (Exa as a stretch).
- Arrow label: **"text queries only, ≤ 4 KB"**.

**Speaker notes** (54 words)
Everything up to the query is on-device: the vision model talks to Ollama only over loopback, so
image bytes never leave memory. A deterministic scrubber removes PII, then the query builder emits
short text from public entities. One module — the egress guard — opens any internet connection, and
only text queries under four kilobytes get through to Tavily.

---

## Slide 4 — Proof

**On slide**
- Enforced by code, measured by eval.
- 10 synthetic screenshots with planted **fake** PII. Intent accuracy, leaks (target 0), latency —
  **[from `eval/results.md` — run `LATENT_OFFLINE=1 python eval/run_eval.py` before the demo]**.
- The six egress rules (`egress.py`): (1) air-gap `LATENT_OFFLINE=1` blocks everything;
  (2) allow-list host, https, default port; (3) body ≤ 4096 bytes; (4) no base64-like blob;
  (5) PII check finds nothing; (6) no API key in body (headers only).
- Air-gap demo still.

**Speaker notes** (56 words)
We prove it two ways. The egress guard enforces six hard rules in code — air-gap mode, a host
allow-list, a four-kilobyte cap no image fits, a base64 block, a PII check, and no keys in the
body. Our eval runs ten screenshots with planted fake PII and counts leaks; the target is zero.
Flip the air-gap toggle and search is blocked, in the audit log.

---

## Slide 5 — Business model

**On slide**
- Privacy is the product — and the moat.
- **B2C — affiliate share:** cards link to tickets, shopping and books; every commercial URL
  already routes through the `affiliate.tag_url` hook in `cards.py` — the single point where a
  partner tag is appended for a referral share. (Ships wired in; returns the URL unchanged until a
  tag is set.)
- **B2B — enterprise tier:** on-prem / fully local model, policy controls over what may leave,
  audit-log export for compliance.
- Same engine, two doors.

**Speaker notes** (49 words)
Two revenue paths on one engine. For consumers it's free: the action cards link to tickets,
shopping and books, and every commercial link already routes through our affiliate hook that takes a
referral share. For enterprise, the thing that blocks cloud assistants is our pitch: on-prem model,
policy controls and audit-log export they can show auditors.

---

## Slide 6 — Tracks + ask

**On slide**
- Three tracks, one build.
- **Privacy-First (main):** single egress door, six enforced rules, air-gap toggle, visible audit
  log.
- **SURGE (Tavily & Exa):** sanitized text queries drive Tavily; Exa through the same door
  (stretch).
- **Most Startup-able:** B2C affiliate + B2B on-prem tier on one engine.
- What's next: WebGL bloom dashboard (#13), Exa search through the same door, publish eval numbers.
- Team: [Team names].

**Speaker notes** (52 words)
One build hits three tracks. Privacy-First: a single egress door with six enforced rules and a
visible audit log. SURGE: sanitized queries drive Tavily, with Exa through the same door. Most
Startup-able: consumer affiliate plus an enterprise on-prem tier. Next is the bloom dashboard, Exa
search, and published eval numbers. Back the agent that keeps your pixels home.

---

## Competitor framing (for Q&A — not on a slide)

Describe cloud-based screen assistants **generally**: tools that read or screenshot your screen and
send that content to a remote server for processing. Do **not** name a specific product or quote a
specific claim unless you have verified it on that product's official page and can cite the URL here
first. No named competitor is currently cited, so none is on a slide.
