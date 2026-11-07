@AGENTS.md

## Claude Code specifics
- Start every task by reading your issue: `gh issue view <n> -R yashkava05/Leo369_Hack1984`. Plan, then implement, then run the issue's "How to verify" commands.
- Subagents: give each subagent a disjoint set of files and the issue number. Subagents must not edit `models.py`, `types.ts`, `egress.py`, `main.py` or `runner.py`; only the main agent integrates, runs the tests and commits.
- Subagents may not load this file. Paste the "Privacy invariants" section and the issue number into every subagent prompt.
- Before opening a PR, run the `latent-reviewer` subagent on your branch and fix every BLOCK finding.
- Never push to `main`, never force-push a branch someone else is using, never commit `.env`.
