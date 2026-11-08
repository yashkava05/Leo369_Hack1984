"""Web search (Tavily) over the sanitized queries.

Every request goes through `egress.internet_post`, so the guard checks it, records it for
GET /api/egress and emits the network line for the terminal. The API key travels only in
the Authorization header. Failures never raise: each query that fails produces an error
event (once per distinct message) and the others carry on.

Demo safety net (issue #17): with DEMO_FALLBACK=1, a query whose Tavily call fails or times
out is answered from `backend/fixtures/tavily_recorded/<query-slug>.json` (saved earlier by
`scripts/record_tavily.py`), and the terminal says "(recorded result)". It never replaces a
request the egress guard blocked (air-gap, PII, ...), and the failure is still reported.
"""

import asyncio
import json
import os
import re
import time
from collections.abc import Set
from pathlib import Path

import httpx
from pydantic import BaseModel, ValidationError

from app import egress
from app.config import get_settings
from app.models import SearchQuery, StageEvent

TAVILY_URL = "https://api.tavily.com/search"
MAX_RESULTS = 5
LIMIT_STATUSES = {429, 432, 433}  # rate limit, plan limit, pay-as-you-go limit
RECORDED_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "tavily_recorded"
RECORDED_LABEL = "(recorded result)"
_TRUTHY = ("1", "true", "yes", "on")


class TavilyResult(BaseModel):
    title: str
    url: str
    content: str = ""
    score: float = 0.0


class TavilyResponse(BaseModel):
    query: str
    answer: str | None = None
    results: list[TavilyResult] = []


def _api_key() -> str:
    return (os.getenv("TAVILY_API_KEY") or get_settings().tavily_api_key or "").strip()


def demo_fallback() -> bool:
    env = os.getenv("DEMO_FALLBACK")
    if env is not None:
        return env.strip().lower() in _TRUTHY
    return bool(getattr(get_settings(), "demo_fallback", False))


def query_slug(text: str) -> str:
    """File name stem for a recorded query: lowercase words joined by '-', at most 80 chars."""
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:80].rstrip("-") or "query"


def recorded_path(text: str) -> Path:
    return RECORDED_DIR / f"{query_slug(text)}.json"


def load_recorded(text: str) -> TavilyResponse | None:
    """The recorded Tavily response for exactly this query text, or None."""
    try:
        saved = json.loads(recorded_path(text).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(saved, dict) or saved.get("query") != text:
        return None  # slug collision or hand-edited file: never serve another query's results
    return parse_response(text, saved.get("response"))


def request_body(q: SearchQuery) -> dict:
    body: dict = {
        "query": q.text,
        "topic": q.topic,
        "search_depth": "basic",
        "max_results": MAX_RESULTS,
        "include_answer": True,
    }
    if q.include_domains:
        body["include_domains"] = list(q.include_domains)
    return body


def parse_response(query: str, data: object) -> TavilyResponse:
    """Keep the fields we use; skip malformed results instead of failing the query."""
    if not isinstance(data, dict):
        return TavilyResponse(query=query)
    results = []
    for raw in data.get("results") or []:
        try:
            results.append(TavilyResult.model_validate(raw))
        except ValidationError:
            continue
    answer = data.get("answer")
    return TavilyResponse(
        query=query, answer=answer if isinstance(answer, str) else None, results=results
    )


async def _publish(job_id: str | None, status: str, message: str, local: bool, data: dict):
    if not job_id:
        return
    from app import jobs  # local import: jobs owns the job store

    job = jobs.get_job(job_id)
    if job is None:
        return
    await job.publish(
        StageEvent(
            job_id=job_id,
            seq=len(job.events),
            ts=time.time(),
            stage="search",
            status=status,
            message=message,
            local=local,
            data=data,
        )
    )


class _Errors:
    """Publishes search error events for a job, each distinct message once."""

    def __init__(self, job_id: str | None):
        self.job_id = job_id
        self.seen: set[str] = set()

    async def report(self, message: str) -> None:
        if message in self.seen:
            return
        self.seen.add(message)
        await _publish(self.job_id, "error", f"search ✕ {message}", False, {"error": message})


class _Blocked:
    """Marker: the egress guard refused the request, as opposed to Tavily failing."""


_BLOCKED = _Blocked()


async def _one(
    q: SearchQuery, key: str, job_id: str, allow_terms: Set[str], errors: _Errors
) -> TavilyResponse | _Blocked | None:
    headers = {"Authorization": f"Bearer {key}"}
    try:
        resp = await egress.internet_post(
            TAVILY_URL, request_body(q), headers, job_id=job_id, allow_terms=allow_terms
        )
    except egress.EgressBlocked as exc:
        await errors.report(f"query blocked by egress guard: {exc.reason}")
        return _BLOCKED
    except httpx.TimeoutException:
        await errors.report("Tavily timed out")
        return None
    except httpx.HTTPError as exc:
        await errors.report(f"Tavily unreachable ({type(exc).__name__})")
        return None

    if resp.status_code == 401:
        await errors.report("Tavily key rejected")
        return None
    if resp.status_code in LIMIT_STATUSES:
        await errors.report(f"Tavily usage limit reached (HTTP {resp.status_code})")
        return None
    if resp.status_code != 200:
        await errors.report(f"Tavily error (HTTP {resp.status_code})")
        return None
    try:
        data = resp.json()
    except ValueError:
        await errors.report("Tavily returned invalid JSON")
        return None
    return parse_response(q.text, data)


async def _one_or_recorded(
    q: SearchQuery, key: str, job_id: str, allow_terms: Set[str], errors: _Errors
) -> TavilyResponse | None:
    """`_one`, but a failed (not blocked) call is answered from disk when DEMO_FALLBACK is on."""
    resp = await _one(q, key, job_id, allow_terms, errors)
    if resp is _BLOCKED:
        return None  # the guard said no (air-gap, PII, ...): never paper over that
    if resp is not None or not demo_fallback():
        return resp
    recorded = load_recorded(q.text)
    if recorded is None:
        await errors.report(f"no recorded result for '{q.text}'")
        return None
    # These results come from this machine's disk, not the network: a LOCAL line that says so.
    await _publish(
        job_id,
        "progress",
        f"search ↺ {RECORDED_LABEL} {q.text} · {len(recorded.results)} results",
        True,
        {"recorded": True, "query": q.text},
    )
    return recorded


async def search(
    queries: list[SearchQuery], job_id: str, allow_terms: set[str]
) -> dict[str, TavilyResponse]:
    """Run every query concurrently; return the ones that succeeded, keyed by query text."""
    errors = _Errors(job_id)
    if not queries:
        return {}
    key = _api_key()
    if not key:
        await errors.report("TAVILY_API_KEY not set; skipping web search")
        return {}
    unique = list({q.text: q for q in queries}.values())
    responses = await asyncio.gather(
        *(_one_or_recorded(q, key, job_id, allow_terms, errors) for q in unique),
        return_exceptions=True,
    )
    out: dict[str, TavilyResponse] = {}
    for q, resp in zip(unique, responses, strict=True):
        if isinstance(resp, BaseException):
            await errors.report(f"search failed ({type(resp).__name__})")
        elif resp is not None:
            out[q.text] = resp
    return out
