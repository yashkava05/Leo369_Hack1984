# Latent

Local-first memory agent that turns screenshots into actions. Built for HACK1984.

Drop a screenshot; a local vision model (Ollama + Qwen2.5-VL) extracts the intent, PII is
stripped, a sanitized text query goes to Tavily, and the results render as action cards.

## Prerequisites

- Python 3.11+
- Node 20+ (Vite needs 20.19 or newer)
- [Ollama](https://ollama.com) (model setup comes in a later issue; not needed to run the scaffold)

## Quick start

```bash
git clone https://github.com/yashkava05/Leo369_Hack1984.git latent
cd latent
./scripts/setup.sh          # creates .env, backend/.venv, installs backend + frontend deps
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
| `VITE_API_URL` | `http://localhost:8000` | frontend |
| `VITE_MOCK` | `0` | frontend |

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
