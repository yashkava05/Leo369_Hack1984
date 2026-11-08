#!/usr/bin/env python3
"""Record real Tavily responses for the demo queries, for the DEMO_FALLBACK safety net (#17).

Run once on a good network with the backend virtualenv, after a live rehearsal:

    backend/.venv/bin/python scripts/record_tavily.py --from-egress-log
    backend/.venv/bin/python scripts/record_tavily.py "Lumen Drift tickets" --allow "Lumen Drift"

Each query is sent exactly like the pipeline sends it: through `egress.internet_post`, so every
egress rule applies and the attempt lands in the audit log. The raw response is saved to
`backend/fixtures/tavily_recorded/<query-slug>.json` together with the query text and the
request body; the API key is never written. With DEMO_FALLBACK=1 the backend serves these
files when a live Tavily call fails, and the terminal labels them "(recorded result)".

`--from-egress-log` re-records every query that the backend sent to Tavily (not blocked) in
`backend/egress.log`, with the same topic and domains. Queries naming a performer or author
need `--allow "<name>"`, just as the pipeline allows only kept performer and author names;
the script says so when the guard blocks one.
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

from app import egress  # noqa: E402
from app.models import SearchQuery  # noqa: E402
from app.pipeline import search  # noqa: E402


def queries_from_egress_log(path: Path) -> list[SearchQuery]:
    """Tavily queries that actually went out, oldest first, without duplicates."""
    found: dict[str, SearchQuery] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            record = json.loads(line)
            if record.get("blocked") or record.get("host") != "api.tavily.com":
                continue
            body = json.loads(record["payload_preview"])
        except (ValueError, KeyError, TypeError):
            continue  # not a record, or a preview cut off at 300 chars
        if not isinstance(body, dict) or not isinstance(body.get("query"), str):
            continue
        topic = body.get("topic") if body.get("topic") in ("general", "news", "finance") else None
        domains = body.get("include_domains")
        found[body["query"]] = SearchQuery(
            text=body["query"],
            purpose="context",  # not sent; only text, topic and domains shape the request
            topic=topic or "general",
            include_domains=[d for d in domains if isinstance(d, str)]
            if isinstance(domains, list)
            else [],
        )
    return list(found.values())


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
        hint = ' (add --allow "<name>" for a performer or author)' if "pii" in exc.reason else ""
        print(f"  blocked by egress guard: {exc.reason}{hint}")
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
    parser.add_argument("queries", nargs="*", help="query text, exactly as the pipeline builds it")
    parser.add_argument(
        "--from-egress-log",
        nargs="?",
        const=str(egress.LOG_PATH),
        metavar="PATH",
        help="also record every Tavily query sent in this egress log (default backend/egress.log)",
    )
    parser.add_argument("--allow", action="append", default=[], metavar="TERM")
    parser.add_argument("--topic", choices=["general", "news", "finance"], default="general")
    args = parser.parse_args(argv)

    queries = [SearchQuery(text=t, purpose="context", topic=args.topic) for t in args.queries]
    if args.from_egress_log:
        log_path = Path(args.from_egress_log)
        if not log_path.is_file():
            print(f"no egress log at {log_path}; run a live rehearsal first")
            return 2
        queries += queries_from_egress_log(log_path)
    queries = list({q.text: q for q in queries}.values())
    if not queries:
        parser.error("give at least one query or --from-egress-log")

    key = search._api_key()
    if not key:
        print("TAVILY_API_KEY is not set (env or .env); nothing recorded")
        return 2
    ok = 0
    try:
        for q in queries:
            print(f"{q.text}")
            ok += await record(q, key, set(args.allow))
    finally:
        await egress.aclose()
    print(f"recorded {ok} of {len(queries)} queries")
    return 0 if ok == len(queries) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
