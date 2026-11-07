# Eval set

Ten synthetic screenshots with planted **fake** PII, plus a script that runs the local pipeline
(extract → scrub → build_queries) offline and counts leaks, intent accuracy, entity recall and latency.

| Path | What |
| --- | --- |
| `mockups/*.html` | HTML sources for the screenshots (all names, handles, emails, addresses and figures are made up) |
| `mockups/render.sh` | Renders the mock-ups to `screenshots/` with headless Chrome (phone 1170×2532, desktop 1440×900) |
| `screenshots/*.png` | The eval images, which are also the demo's seed screenshots |
| `expected.json` | Per image: `intent_type`, `must_include` (lowercase substrings expected among public entity values), `must_not_appear` (planted strings that must never come out of the pipeline) |
| `run_eval.py` | The eval. Exit 0 = no leaks, 1 = leak, 2 = pipeline missing or an image failed |
| `results.md` | Report written by the latest run |

```bash
LATENT_OFFLINE=1 python eval/run_eval.py   # real run; writes eval/results.md
python eval/run_eval.py --no-scrub         # bypass the scrubber; should exit 1
python eval/run_eval.py --self-test        # checks the harness with fake stand-ins, no backend needed
```

A leak is any `must_not_appear` string found, case-insensitively, in the JSON of the scrubbed Intent
plus every built query. While the eval runs, outbound connections are refused unless they go to
loopback or `OLLAMA_HOST`.

After editing a mock-up, re-render with
`CHROME=/path/to/chrome eval/mockups/render.sh` (under WSL, Windows `chrome.exe` also works).
