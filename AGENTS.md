# PrismLocal — context for every coding agent

Read this whole file before changing anything. Then read your GitHub issue: it is your spec.

## What we're building
PrismLocal (HACK1984) is a local-first memory agent. A user drops a screenshot; a local vision model (Ollama, `qwen2.5vl:3b`) extracts the intent and public entities on-device; a deterministic PII scrubber removes anything private; a query builder turns only the public entities into short text queries; the egress guard sends those queries to Tavily (and Exa, stretch); the results arrive in a Muse-style chat thread: a live work-steps message tags every stage On device or Internet, then PrismLocal replies with action cards, asks before acting, and shows a privacy receipt of exactly what left the device.

Tracks: Privacy-First (main), SURGE (Tavily & Exa), Most Startup-able.
Demo: drop a concert flyer → cards bloom → Add to calendar. Turn air-gap on, drop an internal email → extraction finishes locally, search is blocked; turn it off → market cards appear; the audit log shows exactly what left the device.

## Sources of truth
- Spec: GitHub issues #1–#21 in `yashkava05/Leo369_Hack1984`. Follow your issue's "Interfaces you must match" exactly.
- Build order and owners: the dependency board (link in README).
- Data contract: `backend/app/models.py` ⇄ `frontend/src/types.ts` (issue #3).

## Stack and commands
- Backend: Python 3.11, FastAPI, Pydantic v2, httpx, sse-starlette, Presidio + spaCy `en_core_web_lg`.
- Model: Ollama ≥ 0.7, `qwen2.5vl:3b` (env `LATENT_MODEL`).
- Frontend: React 18 + Vite + TypeScript, @react-three/fiber, drei, postprocessing.
- Setup once: `./scripts/setup.sh`. Run everything: `./scripts/dev.sh`.
- Tests: `cd backend && pytest` · `cd frontend && npx tsc --noEmit && npx vitest run` · leaks: `LATENT_OFFLINE=1 python eval/run_eval.py`.
- Mock modes: `LATENT_MOCK=1` (backend replays fixtures), `VITE_MOCK=1` (frontend runs with no backend). Both must keep working.

## Repo map and owners
| Path | Owner issue |
| --- | --- |
| `frontend/src/chat/` | chat UI (branch ui-chat) |
| `backend/app/models.py`, `frontend/src/types.ts`, `backend/fixtures/` | #3 contract (shared — see rules) |
| `backend/app/jobs.py` | #3 |
| `backend/app/egress.py` | #7 egress guard |
| `backend/app/pipeline/extract.py`, `prompts.py` | #4 |
| `backend/app/pipeline/scrub.py` | #5 |
| `backend/app/pipeline/query.py` | #6 |
| `backend/app/pipeline/search.py`, `cards.py`, `backend/app/affiliate.py` | #8 |
| `backend/app/pipeline/runner.py` | #9 |
| `eval/` | #10 |
| `frontend/src/state/useJob.ts`, `DropZone`, `StageStrip` | #11 |
| `frontend/src/components/Terminal*` | #12 |
| `frontend/src/components/Dashboard.tsx`, `frontend/src/three/` | #13 |
| `frontend/src/components/cards/`, `frontend/src/lib/ics.ts` | #14 |
| `frontend/src/App.tsx`, `vite.config.ts`, `scripts/dev.sh` | #15 |
| `AuditDrawer`, `AirGapToggle`, `LeftDeviceSummary` | #16 |
| `docs/`, `README.md` (final) | #17, #18 |
| `backend/app/pipeline/exa.py` · `backend/app/watch.py` · `backend/app/library.py` | #19 · #20 · #21 |

## Privacy invariants — never break these
1. Image bytes never leave the machine and are never written to disk or logs.
2. Only `backend/app/egress.py` may open network connections. Ollama is reached only through `egress.local_client()` (loopback only). Do not add `requests`, `aiohttp`, SDK clients (`tavily-python`, `exa-py`) or raw sockets anywhere else.
3. Outbound requests contain only query strings built by `query.py` from scrubbed public entities — never raw text, the summary, or model free text.
4. API keys come from env, go only in request headers, and are never logged, returned, printed or committed.
5. Never weaken an egress rule, the scrubber policy, `test_single_egress.py` or `test_contract.py` to make something pass. If an invariant blocks you, stop and explain in the issue.
6. All fixtures, eval images and test data use fake people and fake companies.

## Rules for parallel work (several agents run at the same time)
- One issue = one branch = one git worktree = one PR. Branch name `<issue-number>-<slug>`; PR body `Closes #<n>`.
- Stay inside your issue's scope and its "Files you'll likely touch". Need a change in a file another issue owns? Make the smallest additive change, never rewrite or reorder their code, and list it under "Touched outside my scope" in the PR.
- Contract freeze: never rename or remove fields in `models.py` / `types.ts`. Adding one requires updating both files, the fixtures and `test_contract.py` in the same PR, and `[contract]` in the PR title.
- `main.py`: put new routes in `backend/app/routes/<slug>.py` and register them with a single `app.include_router(...)` line, so parallel PRs don't conflict.
- Dependencies: add only; never upgrade, remove or reorder existing ones. Commit the updated lockfile and name the new dependency in the PR.
- Format only files you changed. Don't reformat, rename or move other files.
- Don't delete, skip or loosen tests. Don't tick an acceptance criterion you didn't verify.
- If the issue is ambiguous or wrong, comment on the issue and ask; don't invent a new interface.
- Before opening a PR: `git fetch && git rebase origin/main`, run all tests, fix conflicts by keeping both sides' intent.

## Definition of done (every issue)
- Every acceptance criterion verified with the issue's "How to verify" commands.
- Tests pass; mock modes still work; no new console errors.
- PR describes what changed, how it was verified, and anything left undone.
