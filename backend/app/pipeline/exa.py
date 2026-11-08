"""Exa "related" cards: deeper reading for book, chart and document intents.

Two calls, both through `egress.internet_post` (so each is rule-checked, audited and shown in
the terminal) with the key only in the `x-api-key` header:

- `/search` for the sanitized `purpose="related"` query built by `query.related_query`;
- `/findSimilar` on the top Tavily result URL — a public web URL, never user data.

`related_concurrent` starts `/search` at once and `/findSimilar` as soon as Tavily answers, so
the runner can run Exa alongside Tavily. With no `EXA_API_KEY` nothing is sent: one local
event says Exa is disabled and the result is `[]`. Failures never raise.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Awaitable, Set

import httpx
from pydantic import BaseModel, ValidationError

from app import egress
from app.config import get_settings
from app.models import Card, CardAction, SearchQuery, StageEvent
from app.pipeline.cards import MAX_CARDS, card_id, clean_url, domain_of, snippet
from app.pipeline.search import TavilyResponse, _Errors

EXA_SEARCH_URL = "https://api.exa.ai/search"
EXA_SIMILAR_URL = "https://api.exa.ai/findSimilar"
NUM_RESULTS = 5
TEXT_CHARS = 300
MAX_RELATED = 2
DISABLED_MESSAGE = "Exa disabled (no key)"

# (top Tavily result URL or None, cleaned URLs of every Tavily result)
TavilyContext = tuple[str | None, Set[str]]


class ExaResult(BaseModel):
    title: str | None = None
    url: str
    text: str | None = None
    publishedDate: str | None = None  # noqa: N815 - Exa's field name


def _api_key() -> str:
    return (os.getenv("EXA_API_KEY") or get_settings().exa_api_key or "").strip()


def search_body(q: SearchQuery) -> dict:
    return {
        "query": q.text,
        "numResults": NUM_RESULTS,
        "type": "auto",
        "contents": {"text": {"maxCharacters": TEXT_CHARS}},
    }


def similar_body(url: str) -> dict:
    return {
        "url": url,
        "numResults": NUM_RESULTS,
        "contents": {"text": {"maxCharacters": TEXT_CHARS}},
    }


def parse_results(data: object) -> list[ExaResult]:
    """Keep the fields we use; skip malformed results."""
    if not isinstance(data, dict):
        return []
    out = []
    for raw in data.get("results") or []:
        try:
            r = ExaResult.model_validate(raw)
        except ValidationError:
            continue
        if r.url.strip().lower().startswith(("https://", "http://")):
            out.append(r)
    return out


def tavily_context(queries: list[SearchQuery], results: dict[str, TavilyResponse]) -> TavilyContext:
    """Top Tavily URL and the cleaned URLs of every Tavily result.

    The top URL is the highest-scored result of the first query that found anything, trying
    `context` queries first: similar pages to a review or analysis read better than similar
    pages to a shop listing.
    """
    top: str | None = None
    seen: set[str] = set()
    ordered = sorted(queries, key=lambda q: q.purpose != "context")  # stable
    for q in ordered:
        resp = results.get(q.text)
        if resp is None:
            continue
        urls = [r for r in resp.results if r.url.strip()]
        seen.update(clean_url(r.url) for r in urls)
        if top is None and urls:
            top = clean_url(max(urls, key=lambda r: r.score).url)
    return top, seen


async def _emit_local(job_id: str | None, message: str) -> None:
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
            status="progress",
            message=message,
            local=True,
        )
    )


async def _post(
    url: str, body: dict, key: str, job_id: str | None, allow_terms: Set[str], errors: _Errors
) -> list[ExaResult]:
    try:
        resp = await egress.internet_post(
            url, body, {"x-api-key": key}, job_id=job_id, allow_terms=allow_terms
        )
    except egress.EgressBlocked as exc:
        await errors.report(f"Exa request blocked by egress guard: {exc.reason}")
        return []
    except httpx.TimeoutException:
        await errors.report("Exa timed out")
        return []
    except httpx.HTTPError as exc:
        await errors.report(f"Exa unreachable ({type(exc).__name__})")
        return []

    if resp.status_code in (401, 403):
        await errors.report("Exa key rejected")
        return []
    if resp.status_code == 429:
        await errors.report("Exa rate limit reached (HTTP 429)")
        return []
    if resp.status_code != 200:
        await errors.report(f"Exa error (HTTP {resp.status_code})")
        return []
    try:
        return parse_results(resp.json())
    except ValueError:
        await errors.report("Exa returned invalid JSON")
        return []


def _card(r: ExaResult, score: float) -> Card:
    url = clean_url(r.url)
    host = domain_of(url)
    published = (r.publishedDate or "")[:10]
    return Card(
        id=card_id("related", url),
        kind="related",
        title=" ".join((r.title or "").split()) or host,
        subtitle=f"Published {published}" if published else None,
        url=url,
        source=host,
        snippet=snippet(r.text),
        score=score,
        actions=[CardAction(label="Read", type="open_url", url=url)],
    )


def build_related_cards(
    search_results: list[ExaResult],
    similar_results: list[ExaResult],
    exclude_urls: Set[str] = frozenset(),
) -> list[Card]:
    """Interleave /search and /findSimilar results, drop Tavily URLs and repeats, keep 2."""
    ordered: list[ExaResult] = []
    for i in range(max(len(search_results), len(similar_results))):
        ordered += [lst[i] for lst in (search_results, similar_results) if i < len(lst)]
    cards: list[Card] = []
    seen = set(exclude_urls)
    for r in ordered:
        url = clean_url(r.url)
        if url in seen:
            continue
        seen.add(url)
        cards.append(_card(r, score=round(1.0 - 0.1 * len(cards), 2)))
        if len(cards) == MAX_RELATED:
            break
    return cards


async def _resolved(ctx: TavilyContext) -> TavilyContext:
    return ctx


async def related_concurrent(
    queries: list[SearchQuery],
    tavily: Awaitable[TavilyContext],
    job_id: str,
    allow_terms: Set[str],
) -> list[Card]:
    """Like `related`, but `/search` starts before Tavily has answered.

    `tavily` resolves to the Tavily context once web search is done; `/findSimilar` and the
    dedupe wait for it. The awaitable is always awaited, so a coroutine is never left behind.
    """
    related_q = next((q for q in queries if q.purpose == "related"), None)
    key = _api_key() if related_q else ""
    errors = _Errors(job_id)

    search_task = None
    if related_q and key:
        search_task = asyncio.create_task(
            _post(EXA_SEARCH_URL, search_body(related_q), key, job_id, allow_terms, errors)
        )
    try:
        top_url, exclude = await tavily
    except Exception:  # Tavily failing must not take Exa down with it
        top_url, exclude = None, frozenset()

    if related_q is None:
        return []
    if not key:
        await _emit_local(job_id, DISABLED_MESSAGE)
        return []

    try:
        similar: list[ExaResult] = []
        if top_url:
            similar = await _post(
                EXA_SIMILAR_URL, similar_body(top_url), key, job_id, allow_terms, errors
            )
        found = await search_task if search_task is not None else []
    finally:
        if search_task is not None and not search_task.done():
            search_task.cancel()
    return build_related_cards(found, similar, exclude)


async def related(
    queries: list[SearchQuery],
    top_url: str | None,
    job_id: str,
    allow_terms: set[str],
    *,
    exclude_urls: Set[str] = frozenset(),
) -> list[Card]:
    """Up to 2 `related` cards from Exa for the `purpose="related"` query in `queries`."""
    exclude = {clean_url(u) for u in exclude_urls}
    if top_url:
        top_url = clean_url(top_url)
        exclude.add(top_url)
    return await related_concurrent(queries, _resolved((top_url, exclude)), job_id, allow_terms)


def merge_cards(cards: list[Card], related_cards: list[Card]) -> list[Card]:
    """Append related cards last; when the 6-card cap is full they replace trailing links."""
    taken = {c.url for c in cards if c.url}
    extra = [c for c in related_cards if c.url not in taken][:MAX_RELATED]
    out = list(cards)
    overflow = len(out) + len(extra) - MAX_CARDS
    for i in range(len(out) - 1, -1, -1):
        if overflow <= 0:
            break
        if out[i].kind == "link":
            del out[i]
            overflow -= 1
    return (out + extra)[:MAX_CARDS]
