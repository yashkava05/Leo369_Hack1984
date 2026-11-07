# Latent eval results

Not run yet. `extract_intent`, `scrub_intent` and `build_queries` (issues #4, #5, #6) are not merged, so
`python eval/run_eval.py` currently stops with exit code 2 and a message that names the missing functions.

Before the demo, run `LATENT_OFFLINE=1 python eval/run_eval.py` and commit the file it writes here.
