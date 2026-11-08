# Latent demo script

The demo is judged in about 2 minutes, on someone else's Wi-Fi, with a local model that may be
cold. This page is the plan: the timed script with exact words, the checklist for the demo laptop,
the fallback plan if something breaks, and the rehearsal log.

The demo runs on the chat screen at http://localhost:5173: you send Latent a screenshot, its work
steps tag every stage **On device** or **Internet**, it replies with action cards and a privacy
receipt, and it asks before it acts. The older Terminal + Dashboard layout is still at
http://localhost:5173/?view=classic; the fallback plan says when to switch to it.

Anything marked `[TBD: ...]` needs a person, the demo laptop or a real recording. Fill it in before
the demo and never replace it with a made-up number.

## Roles

| Role | Who | Does |
| --- | --- | --- |
| Narrator | [TBD: name] | Says the lines below, faces the judges, keeps time |
| Driver | [TBD: name] | Drives the laptop: drops screenshots on the chat, answers Latent's questions, flips the air-gap switch, opens Receipts |
| Backup | [TBD: name] | Watches the timer and the work steps; switches to `?view=classic` or starts the backup video if the laptop fails |

## Screenshots

Both are on the demo laptop's desktop (copied from `eval/screenshots/`). Every name, handle and
figure in them is made up.

- `concert_ig.png`: an Instagram-style post for a concert (performer, venue, city, date) with
  planted fake handles and a private DM line.
- `doc_internal_email.png`: an internal email with fake names, emails, a fake project codename and
  confidential figures. Its only public entity is the topic ("edge AI").

The same two images are also the **Try a concert flyer** and **Try a work email** chips under
Latent's welcome message. Clicking a chip sends that sample exactly as a drop would, so the driver
can use it if dragging from the desktop fails.

## The script (target 90 s, hard limit 100 s)

Timings are targets from the issue. The real extraction time depends on the laptop; see the
rehearsal log and adjust the words, not the demo, if a beat runs long.

What the driver needs to know about the chat screen:

- Drop a screenshot anywhere on the window ("Drop it here. I'll take a look."), click **+** in the
  message box, or paste it. It appears as your message with "Stays on this device" under it.
- The work steps message lists five steps, each tagged **On device** or **Internet**: Reading your
  screenshot, Hiding personal details, Writing short searches, Searching the web, Putting your
  options together. About a second after the last step it folds into one line (for example "Done
  on this device, plus a short web search · 5.6s"); click that line to open it again.
- After the cards comes the privacy receipt, a pill such as "Screenshot stayed here. 2 text
  searches sent (307 bytes)." Clicking it opens **What left this device** for that turn; the
  **Receipts** button at the top right opens it for every request.

### 0–10 s · Problem (empty chat on screen)

> "Your camera roll is a graveyard of intentions. Concerts you meant to go to, products you meant
> to compare. Latent turns a screenshot into the next step, without your screenshot leaving your
> laptop."

Driver: Latent is open on a fresh chat: the welcome message and the four sample chips, header
status "Works on this device", **Air-gap** off.

### 10–40 s · Drop the concert post (work steps)

Driver drops `concert_ig.png` on the chat (or clicks **Try a concert flyer**).

> "Watch the steps. Each one says where it ran. On device: Qwen 2.5 VL reads the image right here,
> on this laptop. On device: personal details are hidden, like the handles. On device: we write
> short searches from public facts only: the artist, the venue, the city. Then one step on the
> Internet: a couple of short text searches to Tavily, and no image."

Point at: the line under "Hiding personal details" (`Removed ... — N public entities kept` on a
live run; a mock replay says `scrub: redacted ...`), "Using only: ..." under "Writing short
searches", and "N text searches, no image" on the **Internet** step. If the scrub line says
nothing was removed, skip "like the handles". If the steps have already folded, click
the summary line to open them.

### 40–55 s · Cards and the calendar approval

Latent replies ("Looks like you want to see ... Here's what I found."), the cards appear in a row,
then the receipt pill and the question "Want me to put it on your calendar?".

> "Tickets, the venue on a map, and the date. It asks before it does anything: yes, put it in my
> calendar."

(Name only the cards that actually appear.)

Driver clicks **Add to calendar** under the question. The `.ics` downloads (it was built
on-device), Latent says "Done. Your calendar file is ready." and the result appears under **Kept
for later** in the sidebar.

### 55–80 s · Air-gap and the receipts

Driver switches **Air-gap** on (top right). The status turns to "Air-gap on: nothing leaves this
device". Driver drops `doc_internal_email.png` (or clicks **Try a work email**).

> "Now a confidential email, with air-gap on. Extraction still runs locally and finishes, but the
> search is blocked at the egress guard: nothing leaves."

Point at: the **Internet** step "Blocked: offline mode" and the receipt pill "Nothing left this
device. 2 searches blocked." Latent asks "Turn air-gap off and finish?".

Driver clicks **Turn off and finish**. Latent turns air-gap off and runs the same screenshot again,
so there is no second drop.

> "...and all that goes out is a search about the public topic, edge AI. No names, no codename, no
> figures. Here are the receipts: every request that left this device, with its size."

(Say the topic Latent names in its reply: "I ... only searched the general topic: ...".)

Driver clicks **Receipts** (top right) and points at the summary line ("Image data sent: 0 bytes.
N text searches sent, ... bytes. N blocked."), a "Blocked: offline mode" row and a "Sent N bytes"
row. Close the drawer. If Latent asks to save these cards, leave the question unanswered.

If a **Related** card (from Exa) appears among the cards, point at it: "plus related reading from
Exa." If none appears, say nothing about Exa. The script works either way, and Exa may be out of
credits.

### 80–90 s · Close (chat)

> "Latent: local-first, privacy enforced and auditable. Built for Privacy-First, SURGE with Tavily
> and Exa, and Most Startup-able: free for consumers with an affiliate share on tickets and
> products, and an on-prem tier for teams that can't use cloud assistants."

Do not say "mathematically guaranteed" or "zero risk". Say "enforced and auditable".

## Windows demo laptop

On the Windows demo laptop, use the Windows clone (on `C:`, not the WSL file system) and
`scripts\start-windows.cmd` instead of `./scripts/dev.sh`. Double-click it, or run it from
PowerShell with flags. It never prints key values and never overwrites `.env` or `.env.local`.

| Command | Use it for |
| --- | --- |
| `scripts\start-windows.cmd -Check` | Readiness report only (Python, Node, Ollama running, `qwen2.5vl:3b` pulled, spaCy model, optional voice model, keys set, ports free). Changes nothing; exit code 1 if something needs fixing. |
| `scripts\start-windows.cmd` | Set up what is missing, start Ollama if needed, the backend and the frontend, wait for `/api/health` and open the chat. Ctrl+C or closing the window stops both servers; Ollama keeps running. |
| `scripts\start-windows.cmd -Mock` | Fallback layer 2: the backend replays fixtures, no Ollama and no network needed. |
| `scripts\start-windows.cmd -AirGap` | Rehearse with the backend starting in air-gap (`LATENT_OFFLINE=1`). The **Air-gap** switch can still turn it off. For the real demo, start without it: the demo script above starts with air-gap off. |
| `scripts\start-windows.cmd -Wsl` | Bind the backend and frontend to `0.0.0.0` so a WSL shell on the same laptop can reach them. Ollama is bound to `0.0.0.0` only if the script starts it; if the Ollama app is already running, the script tells you how to rebind it. This also exposes the app to the local network, so do not use it on venue Wi-Fi. |

For `DEMO_FALLBACK=1`, put `DEMO_FALLBACK=1` in `.env.local` before starting. The rest of the
checklist below applies unchanged; replace `./scripts/dev.sh` with `scripts\start-windows.cmd`, and
check health with `curl.exe -s localhost:8000/api/health` (the script also prints it once at start).

## Demo-laptop checklist

Five minutes before:

- [ ] `.env` is correct: `TAVILY_API_KEY` set, `LATENT_MOCK=0`, `DEMO_FALLBACK=1` (or start with
      `DEMO_FALLBACK=1 ./scripts/dev.sh`). Do not open `.env` on the projector.
- [ ] `./scripts/dev.sh` is running. The model is warm: `curl -s localhost:8000/api/health` shows
      `"model_loaded": true` (send one throwaway screenshot if it says `false`). The chat screen
      shows no health banner, so check with `curl`.
- [ ] Tavily credits checked in the Tavily dashboard: [TBD: credits left on demo day]. Exa
      credits: [TBD: available or not; the script works without them].
- [ ] Recorded fallbacks are fresh: `ls backend/fixtures/tavily_recorded/` lists a `.json` for
      every demo query (see "Fallback plan").
- [ ] After the throwaway run, restart `./scripts/dev.sh` (Ollama keeps the model loaded) and
      reload http://localhost:5173. The reload clears the chat, but only the restart clears
      **Receipts**, which lists every request the backend has seen since it started, warm-up and
      rehearsals included. **Air-gap** is off, the Receipts drawer is closed, and no
      "Demo mode" line shows above the message box (that line means `VITE_MOCK=1`).
- [ ] Optional: empty **Kept for later** so the calendar result is the only entry (it lives in this
      browser's `localStorage` under `latent:kept`).
- [ ] `concert_ig.png` and `doc_internal_email.png` are on the desktop.
- [ ] Do Not Disturb on; notifications, chat apps and email closed.
- [ ] Browser zoom 110%, one window, only the Latent tab plus the backup video tab. The window is
      wide enough to show the sidebar with **Kept for later**.
- [ ] Backup video open in another tab, paused at 0:00: [TBD: link].
- [ ] Laptop on power, sleep disabled, screen mirroring tested on the venue projector.

## Fallback plan

Three layers, in order. In every case, say out loud what is happening; never pass off a recording
as live.

### 1. Tavily slow or the Wi-Fi drops: `DEMO_FALLBACK=1`

With `DEMO_FALLBACK=1`, when a Tavily call fails or times out, the backend answers that query from
`backend/fixtures/tavily_recorded/<query-slug>.json` instead, and the cards render from the
recorded response.

On the chat screen it looks like this: the **Internet** step turns red with the error (for example
`search ✕ Tavily unreachable`), Latent says "Some web searches couldn't finish. Check the API key
and connection in your backend, then try again. The options built on this device are still here.",
and the cards from the recording still appear. The chat does **not** label these results as
recorded. Only the classic view's terminal does, with a LOCAL line
`search ↺ (recorded result) <query> · N results` right after the red error line. To show that
label, run the beat at http://localhost:5173/?view=classic.

What it never does:

- It never replaces a request the egress guard blocked. With air-gap on, the search is still
  blocked and no recorded result is served, so the air-gap beat stays honest.
- It never hides the failure: the error on the Internet step and the receipt row for the attempt
  are still there.
- It only serves a file recorded for exactly that query text. A query with no recording shows
  `search ✕ no recorded result for '<query>'` and the turn ends with on-device cards only.

Line to say if it happens: "The venue Wi-Fi just dropped, so these are Tavily results we recorded
earlier for this exact query. Latent shows the search as failed, and the cards come from that
recording."

Limits to know:

- Neither the chat, the cards, the Kept for later entry nor the receipts (which show the failed
  attempt as a "Sent" row) mark the results as recorded, so the narrator must say it.
- On a slow (not dead) network the fallback starts only after the 15 s egress timeout. If Wi-Fi is
  flaky, turn it off before the demo so the call fails at once.

**Record the fallbacks (once, on good Wi-Fi, on the demo laptop):**

1. Run a live rehearsal of the whole script with `DEMO_FALLBACK` unset, so every demo screenshot
   finishes and is saved in the local library (`~/.latent/latent.db`). After **Turn off and
   finish** the email has two runs; the second one is the one with real searches.
2. Record the queries for those runs:
   ```bash
   backend/.venv/bin/python scripts/record_tavily.py --last 3   # or --job <id> per run
   ```
   The script never takes query text by hand: it rebuilds each run's queries with the pipeline's own
   scrubber and query builder from the saved scrubbed intent, sends them through the egress guard
   (same allow rule as the pipeline) and saves each response with its request. The API key is never
   written.
3. Check `backend/fixtures/tavily_recorded/`: one `.json` per demo query. These files are
   git-ignored on purpose (real web results); keep them on the demo laptop and do not commit them.
4. Test it: turn Wi-Fi off, `DEMO_FALLBACK=1 ./scripts/dev.sh`, run the script end to end and
   confirm the cards appear after the red Internet step (and, once, the "(recorded result)" lines in
   `?view=classic`). Note the result in the rehearsal log.

If the model gives a different query on demo day (different wording), that query has no recording
and falls back to on-device cards only; the calendar and map cards still appear because they are
built locally.

### 2. The local model fails or is far too slow

- Cold model: send a throwaway screenshot 5 minutes before (checklist). Ollama keeps it loaded for
  30 minutes.
- Model broken: stop `dev.sh`, restart with `LATENT_MOCK=1 ./scripts/dev.sh`. The backend then
  replays the recorded fixtures (`concert_flyer`, and `sensitive_doc` for a file name containing
  "doc"), and the chat runs the same way: work steps, cards, receipt, the calendar question, and
  the air-gap block and **Turn off and finish**. The replayed cards come from the fixture, not from
  the screenshot you dropped. Say so: "the model on this laptop just failed, so this is a replay of
  a real run."
- Backend broken too: start only the frontend with `cd frontend && VITE_MOCK=1 npm run dev`. The
  chat replays the same fixtures with no backend, and shows "Demo mode · Sample results, no web
  searches sent" above the message box. Say so the same way.

### 3. The laptop or the projector fails

Switch to the backup video tab and narrate over it with the same script: [TBD: backup video link].

### If the chat screen itself misbehaves

Open http://localhost:5173/?view=classic and run the same beats there: the drop zone, the terminal
with LOCAL/NET lines, the dashboard cards, the **Air-gap mode** switch and the **Audit log** drawer
(with each request's payload preview). Air-gap is a backend setting, so it carries over between
the two views. The classic view has no approval questions: use **Add to calendar** on the calendar
card, and drop the email a second time after switching air-gap off.

## Backup video

[TBD: record it.] Steps:

1. Do the checklist above on the demo laptop, with Wi-Fi on and `DEMO_FALLBACK` unset (a live run).
2. Record the screen at 1080p with OBS or QuickTime, browser zoom 110%, with or without narration.
3. Run the full script once on the chat screen, start to finish, within 100 s: the concert drop,
   the opened work steps, **Add to calendar**, air-gap on with the email, **Turn off and finish**,
   and **Receipts**. Re-record rather than edit.
4. Upload it (unlisted YouTube or Google Drive, viewable by anyone with the link), paste the link
   here, in the README ("Demo") and in the hackathon portal, and open it in a tab before the demo.

## Rehearsal log

Run the full script at least three times with a timer. Log real times only; adjust the words if a
beat runs long.

| # | Date | Mode (live / Wi-Fi off + `DEMO_FALLBACK=1`) | Total time | Slowest beat | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | [TBD] | [TBD] | [TBD] | [TBD] | [TBD] |
| 2 | [TBD] | [TBD] | [TBD] | [TBD] | [TBD] |
| 3 | [TBD] | [TBD] | [TBD] | [TBD] | [TBD] |

## Submission text (paste into the hackathon portal)

> **Latent: your screenshots, turned into actions, without your screenshots leaving your laptop.**
>
> Your camera roll is a graveyard of intentions. Send Latent a screenshot and a vision model
> running on your own machine (Qwen2.5-VL through Ollama) works out what you meant to do and pulls
> out the public facts: the artist and venue on a concert flyer, the product in a shop post. A
> deterministic PII scrubber removes names, handles, emails, phone numbers and account numbers on
> the device. Only short text queries built from public facts go out, through one egress guard with
> six rules, to Tavily (and Exa for related reading). Latent replies in a chat with action cards:
> tickets, a map pin, a calendar file it creates only after you say yes. Its work steps tag every
> stage On device or Internet, a privacy receipt under each reply shows exactly what left, an
> air-gap switch cuts the network entirely, and Receipts lists every request and its size. Privacy
> is enforced and auditable, and checked by a leak eval on screenshots full of fake personal data.
>
> Tracks: Privacy-First, SURGE (Tavily & Exa), Most Startup-able.
> Code: https://github.com/yashkava05/Leo369_Hack1984 · Video: [TBD: backup video link]
> Team: [TBD: names]
