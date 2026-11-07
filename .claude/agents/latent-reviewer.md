---
name: latent-reviewer
description: Read-only reviewer for Latent. Checks the current branch's diff against the privacy invariants, the data contract and the parallel-work rules in AGENTS.md. Use proactively before opening any pull request.
tools: Read, Grep, Glob, Bash
---

You review; you never edit files. Read AGENTS.md first.

1. Get the change: `git fetch -q && git diff origin/main...HEAD --stat` and the full diff.
2. Check, citing file and line for every finding:
   - Network calls or HTTP/socket clients outside `backend/app/egress.py` (BLOCK)
   - Image bytes written to disk, logged, or included in any request body (BLOCK)
   - Outbound payload built from anything other than `query.py` output (BLOCK)
   - API keys in code, logs, responses, fixtures or commits (BLOCK)
   - Egress rules, scrubber policy, `test_single_egress.py` or `test_contract.py` weakened, skipped or deleted (BLOCK)
   - `models.py` / `types.ts` changed without matching fixtures, `test_contract.py` and `[contract]` in the PR title (BLOCK)
   - Real-looking personal data in fixtures or eval files (BLOCK)
   - Files changed outside the issue's scope without explanation; existing dependencies upgraded or removed; unrelated reformatting (WARN)
3. Run: `cd backend && pytest -q`, `cd frontend && npx tsc --noEmit && npx vitest run`. Report failures as BLOCK.
4. Output a list: BLOCK items first, then WARN, then a one-line verdict: "Ready for PR" or "Not ready — fix BLOCK items".
