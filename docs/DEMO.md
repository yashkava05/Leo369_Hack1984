# Latent demo script

The demo is judged in about 2 minutes, on someone else's Wi-Fi, with a local model that may be
cold. This page is the plan: the timed script with exact words, the checklist for the demo laptop,
the fallback plan if something breaks, and the rehearsal log.

Anything marked `[TBD: ...]` needs a person, the demo laptop or a real recording. Fill it in before
the demo and never replace it with a made-up number.

## Roles

| Role | Who | Does |
| --- | --- | --- |
| Narrator | [TBD: name] | Says the lines below, faces the judges, keeps time |
| Driver | [TBD: name] | Drives the laptop: drops screenshots, flips the air-gap switch, opens the audit log |
| Backup | [TBD: name] | Watches the timer and the terminal; starts the backup video if the laptop fails |

## Screenshots

Both are on the demo laptop's desktop (copied from `eval/screenshots/`). Every name, handle and
figure in them is made up.

- `concert_ig.png`: an Instagram-style post for a concert (performer, venue, city, date) with
  planted fake handles and a private DM line.
- `doc_internal_email.png`: an internal email with fake names, emails, a fake project codename and
  confidential figures. Its only public entity is the topic ("edge AI").

## The script (target 90 s, hard limit 100 s)

Timings are targets from the issue. The real extraction time depends on the laptop; see the
rehearsal log and adjust the words, not the demo, if a beat runs long.

### 0–10 s · Problem (empty Latent on screen)

> "Your camera roll is a graveyard of intentions. Concerts you meant to go to, products you meant
> to compare. Latent turns a screenshot into the next step, without your screenshot leaving your
> laptop."

Driver: Latent is open and empty, terminal visible.

### 10–40 s · Drop the concert post (terminal + orb pulse)

Driver drops `concert_ig.png` onto the drop zone.

> "Watch the terminal. Every line is tagged LOCAL or NET. LOCAL: Qwen 2.5 VL reads the image right
> here, on this laptop. LOCAL: the scrubber strips anything private, like the handles. LOCAL: we
> build short search queries from public facts only: the artist, the venue, the city. Now the
> NET lines: small text queries to Tavily, a couple of hundred bytes each, and image data: zero
> bytes."

Point at: the scrub line (`Removed ... — N public entities kept`), the `Built N search queries`
line, and `image data 0 B` on a NET line. If the scrub line says nothing was removed, skip "like
the handles".

### 40–55 s · Cards bloom (dashboard)

> "Tickets, the venue on a map, and the date. One click and it's in my calendar."

(Name only the cards that actually appear.)

Driver clicks **Add to calendar** on the calendar card (the `.ics` downloads; it was built
on-device).

### 55–80 s · Air-gap and the audit log (terminal + drawer)

Driver switches **Air-gap mode** on and drops `doc_internal_email.png`.

> "Now a confidential email, with air-gap on. Extraction still runs locally and finishes, but the
> search is blocked at the egress guard: nothing leaves. Air-gap off, run it again..."

Driver switches **Air-gap mode** off and drops `doc_internal_email.png` again.

> "...and all that goes out is a query about the public topic, edge AI. No names, no codename, no
> figures. Here is the audit log: every request that left this device, byte for byte."

Driver opens **Audit log** and points at the blocked row and the sent row.

If a **Related** card (from Exa) appears, point at it: "plus related reading from Exa." If none
appears, say nothing about Exa. The script works either way, and Exa may be out of credits.

### 80–90 s · Close (dashboard)

> "Latent: local-first, privacy enforced and auditable. Built for Privacy-First, SURGE with Tavily
> and Exa, and Most Startup-able: free for consumers with an affiliate share on tickets and
> products, and an on-prem tier for teams that can't use cloud assistants."

Do not say "mathematically guaranteed" or "zero risk". Say "enforced and auditable".

## Demo-laptop checklist

Five minutes before:

- [ ] `.env` is correct: `TAVILY_API_KEY` set, `LATENT_MOCK=0`, `DEMO_FALLBACK=1` (or start with
      `DEMO_FALLBACK=1 ./scripts/dev.sh`). Do not open `.env` on the projector.
- [ ] `./scripts/dev.sh` is running. The model is warm: `curl -s localhost:8000/api/health` shows
      `"model_loaded": true` (drop one throwaway screenshot if it says `false`).
- [ ] Tavily credits checked in the Tavily dashboard: [TBD: credits left on demo day]. Exa
      credits: [TBD: available or not; the script works without them].
- [ ] Recorded fallbacks are fresh: `ls backend/fixtures/tavily_recorded/` lists a `.json` for
      every demo query (see "Fallback plan").
- [ ] Air-gap switch is **off** and the audit log is closed.
- [ ] `concert_ig.png` and `doc_internal_email.png` are on the desktop.
- [ ] Do Not Disturb on; notifications, chat apps and email closed.
- [ ] Browser zoom 110%, one window, only the Latent tab plus the backup video tab.
- [ ] Backup video open in another tab, paused at 0:00: [TBD: link].
- [ ] Laptop on power, sleep disabled, screen mirroring tested on the venue projector.

## Fallback plan

Three layers, in order. In every case, say out loud what is happening; never pass off a recording
as live.

### 1. Tavily slow or the Wi-Fi drops: `DEMO_FALLBACK=1`

With `DEMO_FALLBACK=1`, when a Tavily call fails or times out, the backend answers that query from
`backend/fixtures/tavily_recorded/<query-slug>.json` instead, and the terminal shows a LOCAL line
`search ↺ (recorded result) <query> · N results` right after the red `search ✕ Tavily unreachable`
(or timed out, or usage limit) line. The cards then render from the recorded response.

What it never does:

- It never replaces a request the egress guard blocked. With air-gap on, the search is still
  blocked and no recorded result is served, so the air-gap beat stays honest.
- It never hides the failure: the error line and the audit-log row for the attempt are still there.
- It only serves a file recorded for exactly that query text. A query with no recording shows
  `search ✕ no recorded result for '<query>'` and the job ends with on-device cards only.

Line to say if it happens: "The venue Wi-Fi just dropped, so these are Tavily results we recorded
earlier for this exact query, and the terminal labels them as recorded."

**Record the fallbacks (once, on good Wi-Fi, on the demo laptop):**

1. Run a live rehearsal of the whole script with `DEMO_FALLBACK` unset, so every demo query goes to
   Tavily for real and lands in `backend/egress.log`. The exact query text comes from the model,
   which is why we record from a real run instead of typing queries by hand.
2. Record every query that went out:
   ```bash
   backend/.venv/bin/python scripts/record_tavily.py --from-egress-log --allow "<performer>"
   ```
   `--allow` takes the performer or author name in the concert query (the egress guard only lets a
   kept performer or author name through, exactly as in the pipeline). The script sends each query
   through the egress guard and saves the response with the query text; the API key is never
   written.
3. Check `backend/fixtures/tavily_recorded/`: one `.json` per demo query. Commit them (they hold
   public search results only).
4. Test it: turn Wi-Fi off, `DEMO_FALLBACK=1 ./scripts/dev.sh`, run the script end to end and
   confirm the "(recorded result)" lines and the cards. Note the result in the rehearsal log.

If the model gives a different query on demo day (different wording), that query has no recording
and falls back to on-device cards only; the calendar and map cards still appear because they are
built locally.

### 2. The local model fails or is far too slow

- Cold model: drop a throwaway screenshot 5 minutes before (checklist). Ollama keeps it loaded for
  30 minutes.
- Model broken: stop `dev.sh`, restart with `LATENT_MOCK=1 ./scripts/dev.sh`. The backend then
  replays the recorded fixtures (`concert_flyer`, and `sensitive_doc` for a file name containing
  "doc"). Say so: "the model on this laptop just failed, so this is a replay of a real run."

### 3. The laptop or the projector fails

Switch to the backup video tab and narrate over it with the same script: [TBD: backup video link].

## Backup video

[TBD: record it.] Steps:

1. Do the checklist above on the demo laptop, with Wi-Fi on and `DEMO_FALLBACK` unset (a live run).
2. Record the screen at 1080p with OBS or QuickTime, browser zoom 110%, with or without narration.
3. Run the full script once, start to finish, within 100 s. Re-record rather than edit.
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
> Your camera roll is a graveyard of intentions. Drop a screenshot into Latent and a vision model
> running on your own machine (Qwen2.5-VL through Ollama) works out what you meant to do and pulls
> out the public facts: the artist and venue on a concert flyer, the product in a shop post. A
> deterministic PII scrubber removes names, handles, emails, phone numbers and account numbers on
> the device. Only short text queries built from public facts go out, through one egress guard with
> six rules, to Tavily (and Exa for related reading). The results come back as action cards:
> tickets, a map pin, an Add to calendar button. A live terminal tags every step LOCAL or NET, an
> air-gap switch cuts the network entirely, and the audit log shows every byte that left the
> device. Privacy is enforced and auditable, and checked by a leak eval on screenshots full of
> fake personal data.
>
> Tracks: Privacy-First, SURGE (Tavily & Exa), Most Startup-able.
> Code: https://github.com/yashkava05/Leo369_Hack1984 · Video: [TBD: backup video link]
> Team: [TBD: names]
