#!/usr/bin/env bash
# Render eval/mockups/*.html to eval/screenshots/*.png with headless Chrome.
# Phone mock-ups: 390x844 CSS px at 3x -> 1170x2532. Desktop: 1440x900 at 1x.
# Usage: CHROME=/path/to/chrome eval/mockups/render.sh
# Under WSL, Windows Chrome works too: CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../screenshots"
chrome="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser)}"
profile="$(mktemp -d)"
trap 'rm -rf "$profile"' EXIT

topath() {  # Windows Chrome needs Windows paths
  if [[ "$chrome" == *.exe ]]; then wslpath -w "$1"; else printf '%s' "$1"; fi
}
tourl() {
  if [[ "$chrome" == *.exe ]]; then printf 'file:///%s' "$(wslpath -m "$1")"; else printf 'file://%s' "$1"; fi
}

render() {  # name width height scale
  "$chrome" --headless=new --disable-gpu --hide-scrollbars \
    --user-data-dir="$(topath "$profile")" \
    --force-device-scale-factor="$4" --window-size="$2,$3" \
    --screenshot="$(topath "$out/$1.png")" "$(tourl "$here/$1.html")" >/dev/null 2>&1
  echo "rendered $1.png"
}

for f in concert_ig concert_poster product_ig_shop book_goodreads place_maps other_homescreen; do
  render "$f" 390 844 3
done
for f in product_amazon chart_stock doc_internal_email doc_slack; do
  render "$f" 1440 900 1
done
