#!/usr/bin/env bash
# Latent setup: zero to "local vision model loaded and answering about an image".
# Creates .env, checks Ollama, pulls and smoke-tests the model, then installs
# backend (backend/.venv), spaCy model and frontend deps. Run from anywhere:
#
#   ./scripts/setup.sh
#
# Safe to re-run: every step checks what is already there before acting.
#
# Environment (also read from .env at the repo root when not already set):
#   OLLAMA_HOST                 Ollama URL (default http://localhost:11434)
#   LATENT_MODEL                vision model to pull (default qwen2.5vl:3b; qwen2.5vl:7b on 16 GB+ RAM or a good GPU)
#   LATENT_SKIP_SPACY_MODEL=1   skip the ~600 MB en_core_web_lg download
#   LATENT_SKIP_NPM=1           skip npm install in frontend/
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_PNG="$ROOT/scripts/smoke.png"
MIN_OLLAMA="0.7.0"

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

if [[ ! -f "$ROOT/.env" && -f "$ROOT/.env.example" ]]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "Created .env from .env.example (add your TAVILY_API_KEY there)."
fi

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
LATENT_MODEL="${LATENT_MODEL:-$(dotenv_get LATENT_MODEL)}"
LATENT_MODEL="${LATENT_MODEL:-qwen2.5vl:3b}"

# version_ge A B: true when dotted version A >= B.
version_ge() {
  local IFS=.
  local -a a b
  read -r -a a <<<"$1"
  read -r -a b <<<"$2"
  local i
  for i in 0 1 2; do
    local x="${a[i]:-0}" y="${b[i]:-0}"
    if ((10#$x > 10#$y)); then return 0; fi
    if ((10#$x < 10#$y)); then return 1; fi
  done
  return 0
}

ollama_up() { curl -sf --max-time 2 "$OLLAMA_HOST/api/version" >/dev/null 2>&1; }

# --- 1. Prerequisites ---------------------------------------------------------
step "Checking prerequisites"
command -v curl >/dev/null || die "curl is required"
command -v python3 >/dev/null || die "python3 (3.11+) is required: https://www.python.org/downloads/"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
  || die "Python 3.11+ is required (found $(python3 --version 2>&1))"
info "$(python3 --version)"

if ! command -v ollama >/dev/null; then
  die "Ollama is not installed. Install it from https://ollama.com/download and re-run this script."
fi
ollama_version="$(ollama --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n 1 || true)"
[[ -n "$ollama_version" ]] || die "could not read the Ollama version from 'ollama --version'"
version_ge "$ollama_version" "$MIN_OLLAMA" \
  || die "Ollama $ollama_version is too old; qwen2.5vl needs $MIN_OLLAMA or newer. Update from https://ollama.com/download"
info "ollama $ollama_version"

# --- 2. Ollama server ---------------------------------------------------------
step "Checking the Ollama server at $OLLAMA_HOST"
if ollama_up; then
  info "already running"
else
  log="${TMPDIR:-/tmp}/latent-ollama-serve.log"
  info "not reachable; starting 'ollama serve' in the background (log: $log)"
  OLLAMA_HOST="$OLLAMA_HOST" nohup ollama serve >"$log" 2>&1 &
  for _ in $(seq 1 15); do
    ollama_up && break
    sleep 1
  done
  ollama_up || die "Ollama did not come up within 15 s; see $log"
  info "started"
fi

# --- 3. Model -----------------------------------------------------------------
step "Pulling $LATENT_MODEL"
if curl -sf --max-time 5 "$OLLAMA_HOST/api/tags" \
  | python3 -c 'import json, sys; m = sys.argv[1]; sys.exit(0 if any(x.get("name") == m or x.get("model") == m for x in json.load(sys.stdin).get("models", [])) else 1)' "$LATENT_MODEL"; then
  info "already pulled"
else
  OLLAMA_HOST="$OLLAMA_HOST" ollama pull "$LATENT_MODEL"
fi

# --- 4. Smoke test ------------------------------------------------------------
step "Smoke test: asking $LATENT_MODEL to read scripts/smoke.png (first load can take a while on CPU)"
[[ -f "$SMOKE_PNG" ]] || die "missing $SMOKE_PNG"
payload="$(mktemp)"
trap 'rm -f "$payload"' EXIT
python3 - "$SMOKE_PNG" "$LATENT_MODEL" >"$payload" <<'PY'
import base64, json, sys
png, model = sys.argv[1], sys.argv[2]
with open(png, "rb") as f:
    image = base64.b64encode(f.read()).decode()
json.dump({
    "model": model,
    "messages": [{"role": "user", "content": "What text is in this image?", "images": [image]}],
    "stream": False,
    "keep_alive": "30m",
}, sys.stdout)
PY
start=$SECONDS
reply="$(curl -sf --max-time 600 -H 'Content-Type: application/json' -d @"$payload" "$OLLAMA_HOST/api/chat")" \
  || die "the /api/chat request failed; is $LATENT_MODEL pulled and does the machine have enough memory?"
elapsed=$((SECONDS - start))
answer="$(printf '%s' "$reply" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("message", {}).get("content", ""))')"
info "model said: $answer"
if ! grep -qi 'hello' <<<"$answer"; then
  die "smoke test failed: expected the reply to contain HELLO (took ${elapsed}s)"
fi
printf '    smoke test passed in %ss\n' "$elapsed"

# --- 5. Backend and frontend dependencies -------------------------------------
step "Installing backend dependencies"
if [[ -n "${VIRTUAL_ENV:-}" ]]; then
  py="$VIRTUAL_ENV/bin/python"
  info "using the active virtualenv $VIRTUAL_ENV"
else
  venv="$ROOT/backend/.venv"
  if [[ ! -x "$venv/bin/python" ]]; then
    "${PYTHON:-python3}" -m venv "$venv" \
      || die "could not create backend/.venv (on Debian/Ubuntu install python3-venv, or activate your own virtualenv and re-run)"
  fi
  py="$venv/bin/python"
  info "using backend/.venv"
fi
"$py" -m pip install --quiet --upgrade pip
(cd "$ROOT/backend" && "$py" -m pip install --quiet -e ".[dev]")

step "spaCy model for the PII scrubber (en_core_web_lg)"
if "$py" -c 'import en_core_web_lg' >/dev/null 2>&1; then
  info "already installed"
elif [[ "${LATENT_SKIP_SPACY_MODEL:-0}" == "1" ]]; then
  info "skipped (LATENT_SKIP_SPACY_MODEL=1); run '$py -m spacy download en_core_web_lg' later"
else
  "$py" -m spacy download en_core_web_lg
fi

step "Installing frontend dependencies"
if [[ "${LATENT_SKIP_NPM:-0}" == "1" ]]; then
  info "skipped (LATENT_SKIP_NPM=1)"
elif [[ ! -f "$ROOT/frontend/package.json" ]]; then
  info "skipped: frontend/package.json not found"
else
  command -v npm >/dev/null || die "npm (Node 20+) is required: https://nodejs.org/"
  (cd "$ROOT/frontend" && npm install --no-fund --no-audit)
fi

step "Done"
info "Ollama $ollama_version at $OLLAMA_HOST, model $LATENT_MODEL, smoke test passed in ${elapsed}s"
cat <<MSG

Setup complete. In two terminals:
  cd backend && source .venv/bin/activate && uvicorn app.main:app --reload --port 8000
  cd frontend && npm run dev
MSG
