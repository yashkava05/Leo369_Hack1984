#!/usr/bin/env bash
# Latent dev: one command brings the whole app up. Run from anywhere after ./scripts/setup.sh:
#
#   ./scripts/dev.sh
#
# 1. Starts `ollama serve` if it is not already answering (skipped when LATENT_MOCK=1); it is
#    left running on exit so the model stays warm.
# 2. Runs the backend on :8000, then the frontend on :5173 once the backend answers; Ctrl+C stops both.
#
# Open http://localhost:5173. The Vite dev server proxies /api to the backend, so the
# browser talks to a single origin.
#
# Environment (also read from .env at the repo root when not already set):
#   OLLAMA_HOST      Ollama URL (default http://localhost:11434)
#   LATENT_MOCK=1    backend replays fixtures; Ollama is not needed
#   VITE_MOCK=1      frontend runs with no backend (the backend is still started)
#   BACKEND_PORT     default 8000 (the frontend proxy follows it)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${BACKEND_PORT:-8000}"

info() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Read KEY from .env without sourcing it (so nothing else in it, like API keys, is evaluated or printed).
dotenv_get() {
  local key="$1" file="$ROOT/.env"
  [[ -f "$file" ]] || return 0
  grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//' || true
}

OLLAMA_HOST="${OLLAMA_HOST:-$(dotenv_get OLLAMA_HOST)}"
OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"
[[ "$OLLAMA_HOST" == *://* ]] || OLLAMA_HOST="http://$OLLAMA_HOST"
OLLAMA_HOST="${OLLAMA_HOST%/}"
LATENT_MOCK="${LATENT_MOCK:-$(dotenv_get LATENT_MOCK)}"
LATENT_MOCK="${LATENT_MOCK:-0}"

# --- Prerequisites --------------------------------------------------------------
if [[ -n "${VIRTUAL_ENV:-}" ]]; then
  PY="$VIRTUAL_ENV/bin/python"
else
  PY="$ROOT/backend/.venv/bin/python"
fi
[[ -x "$PY" ]] || die "backend virtualenv not found; run ./scripts/setup.sh first"
"$PY" -c 'import uvicorn' 2>/dev/null || die "uvicorn is not installed in $PY; run ./scripts/setup.sh"
command -v npm >/dev/null || die "npm (Node 20+) is required"
[[ -d "$ROOT/frontend/node_modules" ]] || die "frontend dependencies missing; run ./scripts/setup.sh"

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
port_busy "$BACKEND_PORT" && die "port $BACKEND_PORT is already in use (another backend running?)"
port_busy 5173 && die "port 5173 is already in use (another frontend running?)"

# --- Ollama ---------------------------------------------------------------------
ollama_up() { curl -sf --max-time 2 "$OLLAMA_HOST/api/version" >/dev/null 2>&1; }

pids=()
# Every descendant of a pid (uvicorn's reloader spawns a worker; vite may spawn esbuild).
tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do
    tree "$child"
  done
  echo "$1"
}
alive() { local p; for p in "$@"; do kill -0 "$p" 2>/dev/null && return 0; done; return 1; }
cleanup() {
  trap - INT TERM EXIT
  ((${#pids[@]})) || return 0
  info "stopping"
  local all=() pid
  for pid in "${pids[@]}"; do all+=($(tree "$pid")); done
  kill -TERM "${all[@]}" 2>/dev/null || true
  # A backend still loading the PII model at startup ignores TERM until it finishes; don't hang.
  for _ in $(seq 1 16); do
    alive "${all[@]}" || break
    sleep 0.5
  done
  kill -KILL "${all[@]}" 2>/dev/null || true
  wait "${pids[@]}" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [[ "$LATENT_MOCK" == "1" ]]; then
  info "LATENT_MOCK=1: backend replays fixtures, not starting Ollama"
elif ollama_up; then
  info "Ollama already running at $OLLAMA_HOST"
elif command -v ollama >/dev/null; then
  log="${TMPDIR:-/tmp}/latent-ollama-serve.log"
  info "starting 'ollama serve' in the background; it keeps running after Ctrl+C (log: $log)"
  OLLAMA_HOST="$OLLAMA_HOST" nohup ollama serve >"$log" 2>&1 &
  for _ in $(seq 1 15); do
    ollama_up && break
    sleep 1
  done
  ollama_up || info "warning: Ollama did not answer within 15 s (see $log); the UI will show a banner"
else
  info "warning: Ollama is not installed; the UI will show 'Local model not running'"
fi

# --- Backend and frontend -------------------------------------------------------
info "backend  → http://localhost:$BACKEND_PORT"
(cd "$ROOT/backend" && exec "$PY" -m uvicorn app.main:app --reload --port "$BACKEND_PORT") &
pids+=("$!")

# Start the frontend once the backend answers, so the first page load sees a live API.
# Real mode loads the spaCy model for the PII scrubber at startup, which can take a minute.
info "waiting for the backend (real mode loads the PII model first)…"
for _ in $(seq 1 180); do
  alive "${pids[0]}" || die "the backend exited during startup; see the log above"
  curl -sf --max-time 2 "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done

info "frontend → http://localhost:5173"
(cd "$ROOT/frontend" && LATENT_BACKEND_URL="http://127.0.0.1:$BACKEND_PORT" exec ./node_modules/.bin/vite --clearScreen false) &
pids+=("$!")

# Exit (and stop the rest through the trap) as soon as either server dies.
status=0
wait -n "${pids[@]}" || status=$?
info "a server exited (status $status); shutting down"
exit "$status"
