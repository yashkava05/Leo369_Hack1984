"""Exa related cards: request shape, audit, no-key path, dedupe, merge and runner concurrency.

Exa and Tavily are served by an httpx.MockTransport with recorded Exa-shaped JSON
(tests/data/exa_book.json), so nothing leaves the machine. Fake books, people and domains only.
"""

import asyncio
import io
import json
import os
from datetime import date
from pathlib import Path

import httpx
import pytest
from PIL import Image

from app import egress, jobs
from app.config import Settings, get_settings
from app.models import Card, CardAction, Entity, Intent, SearchQuery
from app.pipeline import exa, runner
from app.pipeline import scrub as scrub_mod
from app.pipeline.cards import MAX_CARDS, SNIPPET_CHARS
from app.pipeline.query import build_queries, related_query
from app.pipeline.search import TavilyResponse

DATA = Path(__file__).resolve().parent / "data"
EXA = json.loads((DATA / "exa_book.json").read_text())
TAVILY_BOOK = json.loads((DATA / "tavily_book.json").read_text())
EXA_KEY = "exa-testkey-0123456789abcdef"
TAVILY_KEY = "tvly-testkey0123456789"
NOW = date(2026, 11, 7)
TOP_URL = "https://www.bookbarn.test/books/the-glass-orchard"


def make_intent(intent_type: str, *entities: tuple[str, str]) -> Intent:
    return Intent(
        intent_type=intent_type,
        summary="s",
        public_entities=[Entity(type=t, value=v) for t, v in entities],
        redaction_counts={},
        confidence=0.88,
    )


# Not "The Glass Orchard": the scrubber reads that title as a person name and drops it.
BOOK = make_intent("book", ("book_title", "Orchard of Glass"), ("author", "Mira Calloway"))
RELATED_Q = SearchQuery(
    text="Orchard of Glass Mira Calloway summary review", purpose="related", topic="general"
)
ALLOW = {"Mira Calloway"}


class Server:
    """Records every request and answers Exa/Tavily with the recorded JSON."""

    def __init__(
        self,
        exa_status: int = 200,
        delay: float = 0.0,
        delays: dict[str, float] | None = None,
        tavily_top: str | None = None,
    ):
        self.requests: list[httpx.Request] = []
        self.log: list[str] = []
        self.exa_status = exa_status
        self.delay = delay
        self.delays = delays or {}  # per "host/path" delay, overrides `delay`
        self.tavily_top = tavily_top  # extra top-scored Tavily result URL

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        name = f"{request.url.host}{request.url.path}"
        self.log.append(f"start {name}")
        delay = self.delays.get(name, self.delay)
        try:
            if delay:
                await asyncio.sleep(delay)
        except asyncio.CancelledError:
            self.log.append(f"cancelled {name}")
            raise
        self.log.append(f"end {name}")
        if request.url.host == "api.tavily.com":
            body = json.loads(request.content)
            payload = next(iter(TAVILY_BOOK["responses"].values()))
            results = list(payload["results"])
            if self.tavily_top:
                results.insert(0, {**results[0], "url": self.tavily_top, "score": 0.99})
            return httpx.Response(200, json={**payload, "query": body["query"], "results": results})
        if self.exa_status != 200:
            return httpx.Response(self.exa_status, json={"error": "nope"})
        key = "search" if request.url.path == "/search" else "findSimilar"
        return httpx.Response(200, json=EXA[key])

    def exa_requests(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.host == "api.exa.ai"]


def use(monkeypatch, server: Server) -> None:
    client = httpx.AsyncClient(transport=httpx.MockTransport(server))
    monkeypatch.setattr(egress, "_internet", client)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("LATENT_MOCK", "0")
    monkeypatch.setenv("EXA_API_KEY", EXA_KEY)
    monkeypatch.setenv("TAVILY_API_KEY", TAVILY_KEY)
    get_settings.cache_clear()
    egress.set_offline(None)
    egress.clear_records()
    jobs.JOBS.clear()
    yield
    egress.set_offline(None)
    get_settings.cache_clear()


# --- query builder ------------------------------------------------------------------


def test_related_query_uses_first_context_template():
    assert related_query(BOOK, now=NOW) == RELATED_Q
    chart = make_intent("chart", ("topic", "Tesla"), ("metric", "stock price"))
    assert related_query(chart, now=NOW) == SearchQuery(
        text="Tesla stock price latest data 2026", purpose="related", topic="finance"
    )
    doc = make_intent("document", ("topic", "solar panels"), ("public_org", "Acme Solar"))
    assert related_query(doc, now=NOW) == SearchQuery(
        text="solar panels market trends 2026", purpose="related"
    )


@pytest.mark.parametrize("intent_type", ["event", "product", "place", "other"])
def test_no_related_query_for_other_intents(intent_type):
    rich = make_intent(intent_type, ("topic", "x"), ("product", "y"), ("place", "z"))
    assert related_query(rich, now=NOW) is None


def test_no_related_query_without_entities():
    assert related_query(make_intent("book", ("book_title", "Dune")), now=NOW) is None


def test_build_queries_never_contains_related():
    for intent in (BOOK, make_intent("chart", ("topic", "Tesla"), ("metric", "revenue"))):
        assert all(q.purpose != "related" for q in build_queries(intent, now=NOW))


# --- exa.related --------------------------------------------------------------------


async def test_request_shapes_header_and_audit(monkeypatch):
    server = Server()
    use(monkeypatch, server)
    job = jobs.create_job()

    cards = await exa.related([RELATED_Q], TOP_URL, job.job_id, ALLOW)

    reqs = {r.url.path: r for r in server.exa_requests()}
    assert set(reqs) == {"/search", "/findSimilar"}
    assert json.loads(reqs["/search"].content) == {
        "query": RELATED_Q.text,
        "numResults": 5,
        "type": "auto",
        "contents": {"text": {"maxCharacters": 300}},
    }
    assert json.loads(reqs["/findSimilar"].content) == {
        "url": TOP_URL,
        "numResults": 5,
        "contents": {"text": {"maxCharacters": 300}},
    }
    for r in reqs.values():
        assert str(r.url).startswith("https://api.exa.ai/")
        assert r.headers["x-api-key"] == EXA_KEY
        assert EXA_KEY not in r.content.decode()

    # Both calls are audited, and the key never reaches a record, the job or the log file.
    records = egress.records()
    assert {(rec.host, rec.path, rec.blocked) for rec in records} == {
        ("api.exa.ai", "/search", False),
        ("api.exa.ai", "/findSimilar", False),
    }
    for rec in records:
        assert EXA_KEY not in rec.model_dump_json()
    assert EXA_KEY not in job.result.model_dump_json()
    assert all(EXA_KEY not in e.model_dump_json() for e in job.events)
    if egress.LOG_PATH.exists():
        assert EXA_KEY not in egress.LOG_PATH.read_text(encoding="utf-8")
    assert len(cards) == 2


async def test_cards_shape_dedupe_and_cap(monkeypatch):
    use(monkeypatch, Server())
    tavily_urls = {"https://openshelf.test/works/glass-orchard"}  # also Exa's first hit
    cards = await exa.related([RELATED_Q], TOP_URL, "", ALLOW, exclude_urls=tavily_urls)

    assert len(cards) == 2
    assert [c.url for c in cards] == [
        # interleaved search[0], similar[0], search[1]...; search[0] is a Tavily URL
        "https://quietreview.test/2025/glass-orchard-review",
        "https://longreads.test/essays/orchards-and-sisters",
    ]
    assert cards[0].score > cards[1].score
    first = cards[1]
    assert first.kind == "related"
    assert first.title == "Orchards, sisters and inheritance: reading The Glass Orchard"
    assert first.source == "longreads.test"
    assert first.subtitle == "Published 2025-06-18"
    assert first.snippet and len(first.snippet) <= SNIPPET_CHARS
    assert first.actions == [CardAction(label="Read", type="open_url", url=first.url)]
    assert all(c.kind == "related" for c in cards)


async def test_no_key_no_calls_one_local_event(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "")
    get_settings.cache_clear()
    server = Server()
    use(monkeypatch, server)
    job = jobs.create_job()

    cards = await exa.related([RELATED_Q], TOP_URL, job.job_id, ALLOW)

    assert cards == []
    assert server.requests == []
    assert egress.records() == []
    assert [(e.stage, e.local, e.message) for e in job.events] == [
        ("search", True, "Exa disabled (no key)")
    ]


async def test_no_related_query_is_a_silent_noop(monkeypatch):
    server = Server()
    use(monkeypatch, server)
    job = jobs.create_job()
    tickets = SearchQuery(text="Lumen Drift Boston tickets", purpose="tickets")
    assert await exa.related([tickets], TOP_URL, job.job_id, set()) == []
    assert server.requests == [] and job.events == []


async def test_without_top_url_only_search_runs(monkeypatch):
    server = Server()
    use(monkeypatch, server)
    cards = await exa.related([RELATED_Q], None, "", ALLOW)
    assert [r.url.path for r in server.exa_requests()] == ["/search"]
    assert [c.source for c in cards] == ["openshelf.test", "longreads.test"]


@pytest.mark.parametrize("status", [401, 429, 500])
async def test_http_errors_degrade_to_nothing(monkeypatch, status):
    use(monkeypatch, Server(exa_status=status))
    job = jobs.create_job()
    assert await exa.related([RELATED_Q], TOP_URL, job.job_id, ALLOW) == []
    errors = [e for e in job.events if e.status == "error" and e.stage == "search"]
    assert len(errors) == 1  # reported once, not per call
    assert EXA_KEY not in errors[0].model_dump_json()


async def test_http_402_reports_credits_exhausted(monkeypatch):
    # Live check: an account out of credits answered 402 NO_MORE_CREDITS on every call.
    use(monkeypatch, Server(exa_status=402))
    job = jobs.create_job()
    assert await exa.related([RELATED_Q], TOP_URL, job.job_id, ALLOW) == []
    errors = [e for e in job.events if e.status == "error" and e.stage == "search"]
    assert len(errors) == 1
    assert "credits exhausted (HTTP 402)" in errors[0].message


async def test_offline_blocks_and_records(monkeypatch):
    server = Server()
    use(monkeypatch, server)
    egress.set_offline(True)
    assert await exa.related([RELATED_Q], TOP_URL, "", ALLOW) == []
    assert server.requests == []
    assert {(r.host, r.blocked, r.reason) for r in egress.records()} == {
        ("api.exa.ai", True, "offline mode")
    }


async def test_pii_in_top_url_never_reaches_exa(monkeypatch):
    server = Server()
    use(monkeypatch, server)
    scrub_mod.warm_up()
    leaky = "https://example.test/call/617-555-0142"
    cards = await exa.related([RELATED_Q], leaky, "", ALLOW)
    # Checked on-device before any request is built: no /findSimilar attempt at all.
    assert not [r for r in egress.records() if r.path == "/findSimilar"]
    assert [r.url.path for r in server.exa_requests()] == ["/search"]
    assert all(b"555-0142" not in r.content for r in server.requests)
    assert cards  # /search still produced cards


@pytest.mark.parametrize(
    "url",
    [
        "https://example.test/report?email=alex%40example.com",
        "https://example.test/report?email=alex%2540example.com",  # double-encoded
        "https://example.test/report?to=alex+tran%40example.com",
        "https://example.test/u/alex%40example.com/profile",
        "https://example.test/call/617-555-0142",
        "https://example.test/call?n=617%2D555%2D0142",
        "https://alex:hunter2@example.test/report",
    ],
)
def test_safe_similar_url_rejects_private_data(url):
    scrub_mod.warm_up()
    assert exa.safe_similar_url(url, ALLOW) is None


def test_safe_similar_url_keeps_public_urls():
    scrub_mod.warm_up()
    assert exa.safe_similar_url(TOP_URL + "?utm_source=x", ALLOW) == TOP_URL
    assert exa.safe_similar_url("https://openshelf.test/works/glass-orchard", ALLOW)


def test_tavily_context_prefers_context_query():
    book_q = SearchQuery(text="b", purpose="book")
    ctx_q = SearchQuery(text="c", purpose="context")
    results = {
        "b": TavilyResponse(
            query="b", results=[{"title": "t", "url": "https://shop.test/x?utm_x=1", "score": 0.9}]
        ),
        "c": TavilyResponse(
            query="c",
            results=[
                {"title": "t", "url": "https://a.test/low", "score": 0.2},
                {"title": "t", "url": "https://a.test/high#frag", "score": 0.7},
            ],
        ),
    }
    top, seen = exa.tavily_context([book_q, ctx_q], results)
    assert top == "https://a.test/high"
    assert seen == {"https://shop.test/x", "https://a.test/low", "https://a.test/high"}
    assert exa.tavily_context([book_q], {}) == (None, set())


# --- merge ---------------------------------------------------------------------------


def card(kind: str, n: int) -> Card:
    url = f"https://{kind}.test/{n}"
    return Card(id=f"{kind}{n}", kind=kind, title="t", url=url, source=f"{kind}.test")


def test_merge_ranks_related_last_and_fills_free_slots():
    base = [card("book", 1), card("insight", 1), card("link", 1)]
    related = [card("related", 1), card("related", 2), card("related", 3)]
    out = exa.merge_cards(base, related)
    assert [c.id for c in out] == ["book1", "insight1", "link1", "related1", "related2"]


def test_merge_replaces_trailing_links_only_when_full():
    base = [card("book", i) for i in range(3)] + [card("insight", 1), card("link", 1)]
    base.append(card("link", 2))
    out = exa.merge_cards(base, [card("related", 1), card("related", 2)])
    assert len(out) == MAX_CARDS
    assert [c.id for c in out] == ["book0", "book1", "book2", "insight1", "related1", "related2"]

    no_links = [card("book", i) for i in range(3)] + [card("calendar", 1), card("place", 1)]
    no_links.append(card("insight", 1))
    assert exa.merge_cards(no_links, [card("related", 1)]) == no_links


def test_merge_skips_related_already_shown():
    base = [card("link", 1)]
    dup = Card(id="r", kind="related", title="t", url=base[0].url, source="link.test")
    assert exa.merge_cards(base, [dup]) == base


# --- runner -----------------------------------------------------------------------------


def png_bytes() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (64, 48), (230, 230, 230)).save(out, format="PNG")
    return out.getvalue()


async def fake_extract(image_bytes: bytes, emit) -> Intent:
    await emit("extract", "ok", "intent: book · 2 public entities")
    return BOOK


async def test_runner_book_gets_related_cards_concurrently(monkeypatch):
    scrub_mod.warm_up()
    server = Server(delay=0.2)
    use(monkeypatch, server)
    monkeypatch.setattr(runner, "extract_intent", fake_extract)
    job = jobs.create_job()

    await runner.run_job(job.job_id, png_bytes(), "book.png")

    result = job.result
    assert result.status == "done"
    related = [c for c in result.cards if c.kind == "related"]
    assert 1 <= len(related) <= 2
    assert result.cards[-len(related) :] == related  # ranked last
    assert len(result.cards) <= MAX_CARDS
    assert all(q.purpose != "related" for q in result.queries)

    # Exa /search starts before Tavily answers; findSimilar starts after it.
    log = server.log
    assert log.index("start api.exa.ai/search") < log.index("end api.tavily.com/search")
    last_tavily_end = max(i for i, x in enumerate(log) if x == "end api.tavily.com/search")
    assert log.index("start api.exa.ai/findSimilar") > last_tavily_end
    # the top Tavily URL (cleaned) is what findSimilar was asked about
    sim = next(r for r in server.exa_requests() if r.url.path == "/findSimilar")
    assert json.loads(sim.content)["url"] == TOP_URL

    hosts = {(r.host, r.path) for r in result.egress}
    assert ("api.exa.ai", "/search") in hosts and ("api.exa.ai", "/findSimilar") in hosts
    assert EXA_KEY not in result.model_dump_json()


async def test_runner_event_intent_never_calls_exa(monkeypatch):
    scrub_mod.warm_up()
    server = Server()
    use(monkeypatch, server)
    event = make_intent("event", ("performer", "Lumen Drift"), ("city", "Boston"))

    async def extract(image_bytes, emit):
        return event

    monkeypatch.setattr(runner, "extract_intent", extract)
    job = jobs.create_job()
    await runner.run_job(job.job_id, png_bytes(), "flyer.png")
    assert job.result.status == "done"
    assert server.exa_requests() == []
    assert not any("Exa" in e.message for e in job.events)


async def test_runner_no_exa_key_still_done(monkeypatch):
    scrub_mod.warm_up()
    monkeypatch.setenv("EXA_API_KEY", "")
    get_settings.cache_clear()
    server = Server()
    use(monkeypatch, server)
    monkeypatch.setattr(runner, "extract_intent", fake_extract)
    job = jobs.create_job()
    await runner.run_job(job.job_id, png_bytes(), "book.png")
    assert job.result.status == "done" and job.result.error is None
    assert server.exa_requests() == []
    assert not any(c.kind == "related" for c in job.result.cards)
    assert sum(e.message == "Exa disabled (no key)" for e in job.events) == 1


LEAKY_TOP = "https://example.test/report?email=alex%40example.com"


async def test_runner_never_forwards_encoded_email_url_to_exa(monkeypatch):
    scrub_mod.warm_up()
    server = Server(tavily_top=LEAKY_TOP)
    use(monkeypatch, server)
    monkeypatch.setattr(runner, "extract_intent", fake_extract)
    job = jobs.create_job()

    await runner.run_job(job.job_id, png_bytes(), "book.png")

    assert job.result.status == "done"
    # Transport level: no Exa request carries the URL, in any encoding.
    exa_bodies = [r.content.decode() for r in server.exa_requests()]
    assert [r.url.path for r in server.exa_requests()] == ["/search"]
    assert not any("alex" in b or "example.test" in b for b in exa_bodies)
    assert not [r for r in job.result.egress if r.path == "/findSimilar"]
    assert any(e.message == exa.UNSAFE_URL_MESSAGE and e.local for e in job.events)
    assert any(c.kind == "related" for c in job.result.cards)  # /search still counts


async def test_cancel_during_tavily_cancels_and_awaits_exa_search(monkeypatch):
    started = asyncio.Event()
    log: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        log.append(f"start {request.url.path}")
        started.set()
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            log.append(f"cancelled {request.url.path}")
            raise
        return httpx.Response(200, json=EXA["search"])

    monkeypatch.setattr(
        egress, "_internet", httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )
    tavily_pending: asyncio.Future = asyncio.get_running_loop().create_future()
    task = asyncio.create_task(exa.related_concurrent([RELATED_Q], tavily_pending, "", ALLOW))
    await asyncio.wait_for(started.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    # Cancelled *and awaited* before related_concurrent returned: no extra tick needed.
    assert log == ["start /search", "cancelled /search"]


async def test_runner_cancel_cancels_exa_while_tavily_pending(monkeypatch):
    scrub_mod.warm_up()
    server = Server(delays={"api.tavily.com/search": 30, "api.exa.ai/search": 30})
    use(monkeypatch, server)
    monkeypatch.setattr(runner, "extract_intent", fake_extract)
    job = jobs.create_job()
    run = asyncio.create_task(runner.run_job(job.job_id, png_bytes(), "book.png"))
    for _ in range(500):
        if "start api.exa.ai/search" in server.log:
            break
        await asyncio.sleep(0.01)
    assert "start api.exa.ai/search" in server.log
    run.cancel()
    with pytest.raises(asyncio.CancelledError):
        await run
    assert "cancelled api.exa.ai/search" in server.log
    assert "end api.exa.ai/search" not in server.log
    assert not any(x.startswith("start api.exa.ai/findSimilar") for x in server.log)


async def test_slow_find_similar_does_not_hold_tavily_cards(monkeypatch):
    scrub_mod.warm_up()
    server = Server(delays={"api.tavily.com/search": 0.03, "api.exa.ai/findSimilar": 1.2})
    use(monkeypatch, server)
    monkeypatch.setattr(runner, "extract_intent", fake_extract)
    job = jobs.create_job()

    await runner.run_job(job.job_id, png_bytes(), "book.png")

    result = job.result
    assert result.status == "done"
    budget_ms = exa.OPTIONAL_BUDGET_S * 1000
    assert result.timings_ms["search"] < 30 + budget_ms + 300  # not the 1.2 s findSimilar
    assert "cancelled api.exa.ai/findSimilar" in server.log
    assert "end api.exa.ai/findSimilar" not in server.log
    assert any(c.kind != "related" for c in result.cards)  # Tavily cards kept
    related = [c for c in result.cards if c.kind == "related"]
    assert related  # the /search results that arrived in time are kept
    assert all("findsimilar" not in (c.url or "").lower() for c in related)


async def test_budget_keeps_find_similar_that_arrives_in_time(monkeypatch):
    server = Server(delays={"api.exa.ai/findSimilar": 0.05})
    use(monkeypatch, server)

    async def tavily() -> exa.TavilyContext:
        return TOP_URL, frozenset({TOP_URL})

    scrub_mod.warm_up()
    cards = await exa.related_concurrent([RELATED_Q], tavily(), "", ALLOW, budget=0.5)
    assert "end api.exa.ai/findSimilar" in server.log
    sim_urls = {exa.clean_url(r["url"]) for r in EXA["findSimilar"]["results"]}
    assert any(c.url in sim_urls for c in cards)


# --- live ---------------------------------------------------------------------------

# Read before the autouse `_env` fixture swaps in the fake key; Settings() also reads .env.
LIVE_EXA_KEY = os.getenv("EXA_API_KEY") or Settings().exa_api_key


@pytest.mark.live
@pytest.mark.skipif(not LIVE_EXA_KEY, reason="needs EXA_API_KEY (env or .env)")
async def test_live_exa_related(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", LIVE_EXA_KEY)
    get_settings.cache_clear()
    book = make_intent("book", ("book_title", "Project Hail Mary"), ("author", "Andy Weir"))
    query = related_query(book, now=NOW)
    assert query is not None
    job = jobs.create_job()
    cards = await exa.related(
        [query], None, job.job_id, {"project", "hail", "mary", "andy", "weir"}
    )
    for c in cards:
        print(f"{c.kind:9} {c.title} | {c.url or ''}")
    assert all(c.kind == "related" and c.url for c in cards)
