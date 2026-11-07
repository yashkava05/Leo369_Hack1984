#!/usr/bin/env bash
# One-shot local setup: .env, backend virtualenv + deps, frontend deps.
# Run from anywhere: ./scripts/setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "Created .env from .env.example (add your TAVILY_API_KEY there)."
fi

PYTHON="${PYTHON:-python3}"
if [ ! -d "$ROOT/backend/.venv" ]; then
  "$PYTHON" -m venv "$ROOT/backend/.venv"
fi
"$ROOT/backend/.venv/bin/pip" install --upgrade pip >/dev/null
(cd "$ROOT/backend" && "$ROOT/backend/.venv/bin/pip" install -e ".[dev]")

(cd "$ROOT/frontend" && npm install)

cat <<MSG

Setup complete. In two terminals:
  cd backend && source .venv/bin/activate && uvicorn app.main:app --reload --port 8000
  cd frontend && npm run dev
MSG
