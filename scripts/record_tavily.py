#!/usr/bin/env python3
"""Record real Tavily responses for the demo queries, for the DEMO_FALLBACK safety net (#17).

Run once on a good network, on the demo laptop, right after a live rehearsal:

    backend/.venv/bin/python scripts/record_tavily.py            # the 5 newest library results
    backend/.venv/bin/python scripts/record_tavily.py --last 2
    backend/.venv/bin/python scripts/record_tavily.py --job j_1a2b3c

The queries are never typed by hand. Every finished job is saved in the local intent library
(`~/.latent/latent.db`, issue #21) with its scrubbed intent. For each chosen job this script
runs that intent through `scrub_intent` and `build_queries` again, so every recorded query is
`query.py` output built from scrubbed public entities, and it allows only the kept performer and
author names through the egress guard, exactly as the pipeline runner does.

Each query is sent through `egress.internet_post`, so every egress rule applies and the attempt
lands in the audit log. The response is saved to
`backend/fixtures/tavily_recorded/<query-slug>.json` with the query text and the request body;
the API key is never written. With DEMO_FALLBACK=1 the backend serves a file only when the live
call for that exact request fails, and the terminal labels it "(recorded result)".
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app import egress, library  # noqa: E402
from app.models import Intent, SearchQuery  # noqa: E402
from app.pipeline import search  # noqa: E402
from app.pipeline.query import build_queries  # noqa: E402
from app.pipeline.scrub import scrub_intent  # noqa: E402


def queries_for(intent: Intent) -> tuple[list[SearchQuery], set[str]]:
    """The pipeline's queries and allow terms for a saved intent (same rules as the runner)."""
    scrubbed, _ = scrub_intent(intent)
    allow = {e.value for e in scrubbed.public_entities if e.type in ("performer", "author")}
    return build_queries(scrubbed), allow


def library_jobs(job_ids: list[str], last: int) -> list[Intent]:
    ids = job_ids or [item.id for item in library.search(limit=last)]
    intents = []
    for job_id in ids:
        result = library.get(job_id)
        if result is None or result.intent is None:
            print(f"no saved result for job {job_id}; skipped")
            continue
        intents.append(result.intent)
    return intents


async def record(q: SearchQuery, key: str, allow: set[str]) -> bool:
    body = search.request_body(q)
    try:
        resp = await egress.internet_post(
            search.TAVILY_URL,
            body,
            {"Authorization": f"Bearer {key}"},
            job_id=None,
            allow_terms=allow,
        )
    except egress.EgressBlocked as exc:
        print(f"  blocked by egress guard: {exc.reason}; nothing saved")
        return False
    except Exception as exc:  # network trouble: report the type only
        print(f"  failed: {type(exc).__name__}")
        return False
    if resp.status_code != 200:
        print(f"  Tavily answered HTTP {resp.status_code}; nothing saved")
        return False
    try:
        data = resp.json()
    except ValueError:
        print("  Tavily returned invalid JSON; nothing saved")
        return False
    path = search.recorded_path(q.text)
    path.parent.mkdir(parents=True, exist_ok=True)
    saved = {
        "query": q.text,
        "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "request": body,
        "response": data,
    }
    path.write_text(json.dumps(saved, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    count = len(search.parse_response(q.text, data).results)
    shown = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
    print(f"  saved {count} results -> {shown}")
    return True


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--last", type=int, default=5, help="newest N library results (default 5)")
    parser.add_argument(
        "--job", action="append", default=[], metavar="ID", help="a library job id (repeatable)"
    )
    args = parser.parse_args(argv)

    key = search._api_key()
    if not key:
        print("TAVILY_API_KEY is not set (env or .env); nothing recorded")
        return 2
    planned: dict[str, tuple[SearchQuery, set[str]]] = {}
    for intent in library_jobs(args.job, args.last):
        queries, allow = queries_for(intent)
        for q in queries:
            planned.setdefault(q.text, (q, allow))
    if not planned:
        print("no queries to record; run a live rehearsal first so the library has results")
        return 2

    ok = 0
    try:
        for q, allow in planned.values():
            print(q.text)
            ok += await record(q, key, allow)
    finally:
        await egress.aclose()
    print(f"recorded {ok} of {len(planned)} queries")
    return 0 if ok == len(planned) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
