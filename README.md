# Latent

Local-first memory agent that turns screenshots into actions. Built for HACK1984.

Drop a screenshot; a local vision model (Ollama + Qwen2.5-VL) extracts the intent, PII is
stripped, a sanitized text query goes to Tavily, and the results render as action cards.

## Prerequisites

- Python 3.11+
- Node 20+ (Vite needs 20.19 or newer)
- [Ollama](https://ollama.com/download) 0.7+ (see [Local model setup](#local-model-setup-ollama--qwen25-vl))
- About 600 MB of disk for the spaCy `en_core_web_lg` model the local PII scrubber uses (setup installs it)

## Quick start

```bash
git clone https://github.com/yashkava05/Leo369_Hack1984.git latent
cd latent
./scripts/setup.sh          # .env, Ollama model pull + smoke test, backend/.venv, spaCy model, frontend deps
```

Then run each server in its own terminal:

```bash
# Terminal 1: backend on http://localhost:8000
cd backend && source .venv/bin/activate && uvicorn app.main:app --reload --port 8000

# Terminal 2: frontend on http://localhost:5173
cd frontend && npm run dev
```

Open http://localhost:5173: the page shows the JSON from `GET /api/health`.

<details><summary>Manual setup (instead of scripts/setup.sh)</summary>

```bash
cp .env.example .env
cd backend && python3 -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"
cd ../frontend && npm install
```
</details>

## Local model setup (Ollama + Qwen2.5-VL)

The vision model runs on your own machine through Ollama (0.7 or newer). `./scripts/setup.sh`
starts `ollama serve` if needed, pulls `qwen2.5vl:3b` (about 3.2 GB), and asks the model to read
`scripts/smoke.png`. It prints `smoke test passed in Ns`, then installs the backend into
`backend/.venv` (or your active virtualenv), including the spaCy `en_core_web_lg` model for the PII
scrubber (pinned in `backend/pyproject.toml`, about 600 MB), checks that the model imports, and
runs `npm install` in `frontend/`. Re-running it is safe. `LATENT_SKIP_NPM=1` skips the frontend
install.

Check it end to end (from the repo root, with the backend venv active):

```bash
uvicorn app.main:app --port 8000 --app-dir backend &
sleep 20 && curl -s localhost:8000/api/health
# {"status":"ok","ollama":"up","model":"qwen2.5vl:3b","model_loaded":true,"tavily_key":true}
```

The backend warms the model on startup (`keep_alive: 30m`; skipped when `LATENT_MOCK=1`).
`status` is `ok` once Ollama is up and the model is pulled; `model_loaded` says whether it is in
memory right now. If Ollama is not running, `/api/health` still returns 200 with
`"status": "degraded"` and `"ollama": "down"`. `tavily_key` only says whether a key is set; the
key itself is never returned or logged.

**Hardware.** The 3B model runs on CPU, but expect roughly 10–40 s per screenshot; on Apple
Silicon or a GPU it takes a few seconds. With 16 GB+ RAM or a good GPU you can use the 7B model:
set `LATENT_MODEL=qwen2.5vl:7b` in `.env` and re-run `./scripts/setup.sh`.

**Windows.** `setup.sh` is for macOS and Linux. On Windows, run it inside WSL, or do the steps by
hand: install Ollama for Windows, `ollama pull qwen2.5vl:3b`, then follow the manual setup above
(the backend install includes `en_core_web_lg`).

## Configuration

All settings live in one repo-root `.env` (copy `.env.example`). The backend reads it with
`pydantic-settings`; Vite reads the `VITE_*` variables from the same file.

| Variable | Default | Used by |
| --- | --- | --- |
| `OLLAMA_HOST` | `http://localhost:11434` | backend |
| `LATENT_MODEL` | `qwen2.5vl:3b` | backend |
| `TAVILY_API_KEY` | empty | backend |
| `EXA_API_KEY` | empty | backend |
| `LATENT_MOCK` | `0` | backend |
| `LATENT_WATCH_DIR` | empty (off) | backend, see [Auto-ingest](#auto-ingest-from-the-screenshot-folder) |
| `VITE_API_URL` | `http://localhost:8000` | frontend |
| `VITE_MOCK` | `0` | frontend |

## Auto-ingest from the screenshot folder

Opt-in and off by default. Set `LATENT_WATCH_DIR` to a folder and every new screenshot saved there
starts a job within about a second; the open UI shows a "Watching ~/Desktop" pill and follows the
newest job unless you are in the middle of one.

```bash
LATENT_WATCH_DIR=~/Desktop uvicorn app.main:app --port 8000   # from backend/
```

- Find the macOS screenshot folder with `defaults read com.apple.screencapture location`. If that
  prints "does not exist", screenshots go to the default, `~/Desktop`.
- Only new `.png`, `.jpg`, `.jpeg` and `.webp` files are picked up (including the macOS
  temp-name-then-rename save); hidden and temp files, files over 10 MB and files already in the
  folder are ignored. A file must stop growing for 500 ms before it is read, so half-written
  files never start a job.
- Latent only reads the file. It never moves, edits or deletes anything in the folder, and the
  image bytes stay on this machine exactly as with a dropped screenshot.

## Checks

```bash
cd backend && pytest                    # tests
cd backend && ruff check . && ruff format --check .   # lint + format
cd frontend && npm run lint && npm run build          # lint + type-check + build
```

## Layout

```text
backend/app/            FastAPI app (main.py, models.py, jobs.py, egress.py)
backend/app/pipeline/   extract -> scrub -> query -> search -> cards
backend/fixtures/       test fixtures
backend/tests/          pytest suite
frontend/src/           Vite + React + TS (api/, components/, types.ts, App.tsx, main.tsx)
eval/                   screenshots/, expected.json, run_eval.py
scripts/setup.sh        one-shot local setup
```

## Pitch deck

- [`docs/pitch.pdf`](docs/pitch.pdf): the 6-slide deck for the submission.
- [`docs/pitch-notes.pdf`](docs/pitch-notes.pdf): the same slides with speaker notes under each one.
- [`docs/pitch.html`](docs/pitch.html): the source. Open it in any browser to present
  (arrow keys or click to move, `F` fullscreen, `N` speaker notes). Edit the text in the file; no
  build step and no network needed.

Every `[TBD: ...]` in the deck must be filled before presenting: the eval numbers come from
`eval/results.md`, the stills from a real run. To re-export, open `docs/pitch.html` in Chrome and print
to PDF with margins "None" and background graphics on (`docs/pitch.html?notes` for the notes copy), or:

```bash
chrome --headless --no-pdf-header-footer --print-to-pdf=docs/pitch.pdf docs/pitch.html
```

## Team rules

- One branch per issue, named `<number>-<slug>` (for example `1-repo-scaffold`).
- Every PR body includes `Closes #<number>`.
- Never push directly to `main`.

## Mock mode

The pipeline contract lives in `backend/app/models.py` and is mirrored in `frontend/src/types.ts`.
Fixture runs (`concert_flyer`, `sensitive_doc`) let the UI be built without Ollama or Tavily:

- Backend: `LATENT_MOCK=1 uvicorn app.main:app --port 8000` replays a fixture for every upload
  (`sensitive_doc` when the filename contains "doc", otherwise `concert_flyer`).
- Frontend: `VITE_MOCK=1` makes `analyze()` and `subscribe()` in `src/api/events.ts` replay the
  same fixtures with no backend running.

Fixtures live in `backend/fixtures/` and are copied to `frontend/src/api/fixtures/`;
`pytest tests/test_contract.py` checks both copies against the models.
