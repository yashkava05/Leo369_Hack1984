"""Tavily search through the egress guard, and card building from recorded responses."""

import json
import os
from datetime import datetime
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app import egress, jobs
from app.config import Settings, get_settings
from app.main import app
from app.models import Card, Intent, SearchQuery
from app.pipeline import cards as cards_mod
from app.pipeline.cards import build_cards, clean_url, lowest_price, parse_event_start
from app.pipeline.search import TavilyResponse, request_body, search

DATA = Path(__file__).resolve().parent / "data"
KEY = "tvly-TESTkey0000000000000000"
NOW = datetime(2026, 11, 7, 12, 0)
TRACKING = ("utm_", "fbclid", "gclid")


def scenario(name: str):
    raw = json.loads((DATA / f"tavily_{name}.json").read_text())
    intent = Intent.model_validate(raw["intent"])
    queries = [SearchQuery.model_validate(q) for q in raw["queries"]]
    return intent, queries, raw["responses"]


def allow_terms(intent: Intent) -> set[str]:
    return {e.value for e in intent.public_entities}


@pytest.fixture(autouse=True)
def guard(monkeypatch, tmp_path):
    monkeypatch.delenv("LATENT_OFFLINE", raising=False)
    monkeypatch.setattr(egress, "LOG_PATH", tmp_path / "egress.log")
    # Deterministic PII rules regardless of whether the scrubber (#5) is installed.
    monkeypatch.setattr(egress, "_pii_checker", lambda: egress._fallback_contains_pii)
    egress.set_offline(None)
    egress.clear_records()
    yield
    egress.set_offline(None)
    egress.clear_records()


@pytest.fixture
def tavily(monkeypatch):
    """Mock Tavily: replies from a {query: (status, json)} table and records requests."""
    monkeypatch.setenv("TAVILY_API_KEY", KEY)
    state = {"replies": {}, "default": (500, {"detail": "server error"}), "requests": []}

    def handler(request: httpx.Request) -> httpx.Response:
        state["requests"].append(request)
        body = json.loads(request.content)
        status, payload = state["replies"].get(body["query"], state["default"])
        return httpx.Response(status, json=payload)

    monkeypatch.setattr(
        egress, "_internet", httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )
    yield state
    monkeypatch.setattr(egress, "_internet", None)


def load_replies(state, responses: dict):
    state["replies"] = {q: (200, payload) for q, payload in responses.items()}


def error_messages(job) -> list[str]:
    return [e.message for e in job.events if e.status == "error"]


def assert_card_hygiene(cards: list[Card]):
    assert len(cards) <= 6
    urls = [c.url for c in cards if c.url]
    assert len(urls) == len(set(urls)), urls
    for url in urls:
        assert not any(t in url for t in TRACKING), url
    ids = [c.id for c in cards]
    assert len(ids) == len(set(ids))


# --- search -----------------------------------------------------------------------


async def test_request_shape_key_in_header_only(tavily):
    intent, queries, responses = scenario("concert")
    load_replies(tavily, responses)
    out = await search(queries, job_id="j_none", allow_terms=allow_terms(intent))

    assert set(out) == {q.text for q in queries}
    sent = {json.loads(r.content)["query"]: r for r in tavily["requests"]}
    tickets = json.loads(sent[queries[0].text].content)
    assert tickets == {
        "query": queries[0].text,
        "topic": "general",
        "search_depth": "basic",
        "max_results": 5,
        "include_answer": True,
        "include_domains": ["ticketmaster.com", "axs.com", "dice.fm"],
    }
    assert "include_domains" not in json.loads(sent[queries[1].text].content)
    for r in tavily["requests"]:
        assert r.url == "https://api.tavily.com/search"
        assert r.headers["authorization"] == f"Bearer {KEY}"
        assert KEY not in r.content.decode()


async def test_every_request_is_audited_without_the_key(monkeypatch, tavily):
    monkeypatch.setattr(jobs, "EGRESS_LOG", [])  # drop replayed mock-mode records
    intent, queries, responses = scenario("concert")
    load_replies(tavily, responses)
    await search(queries, job_id="j_none", allow_terms=allow_terms(intent))

    with TestClient(app) as client:
        records = client.get("/api/egress").json()
    real = [r for r in records if r["host"] == "api.tavily.com" and not r["blocked"]]
    assert len(real) == len(queries)
    blob = json.dumps(records)
    assert KEY not in blob and "Bearer" not in blob
    assert {json.loads(r["payload_preview"])["query"] for r in real} == {q.text for q in queries}


async def test_parses_and_ignores_unknown_fields(tavily):
    intent, queries, responses = scenario("concert")
    load_replies(tavily, responses)
    out = await search(queries, job_id="j_none", allow_terms=allow_terms(intent))
    resp = out[queries[0].text]
    assert isinstance(resp, TavilyResponse)
    assert resp.answer and resp.answer.startswith("Lumen Drift")
    assert len(resp.results) == 4 and resp.results[0].score == 0.94


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (401, "Tavily key rejected"),
        (429, "Tavily usage limit reached (HTTP 429)"),
        (432, "Tavily usage limit reached (HTTP 432)"),
        (433, "Tavily usage limit reached (HTTP 433)"),
        (500, "Tavily error (HTTP 500)"),
    ],
)
async def test_http_errors_become_one_error_event(tavily, status, expected):
    intent, queries, _ = scenario("concert")
    tavily["default"] = (status, {"detail": "nope"})
    job = jobs.create_job()
    out = await search(queries, job_id=job.job_id, allow_terms=allow_terms(intent))
    assert out == {}
    msgs = error_messages(job)
    assert msgs == [f"search ✕ {expected}"]
    assert all(KEY not in e.model_dump_json() for e in job.events)


async def test_partial_failure_keeps_the_other_queries(tavily):
    intent, queries, responses = scenario("concert")
    load_replies(tavily, responses)
    tavily["replies"][queries[1].text] = (429, {"detail": "rate limited"})
    job = jobs.create_job()
    out = await search(queries, job_id=job.job_id, allow_terms=allow_terms(intent))
    assert list(out) == [queries[0].text]
    assert any("HTTP 429" in m for m in error_messages(job))


async def test_timeout_is_reported(monkeypatch, tavily):
    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)

    monkeypatch.setattr(
        egress, "_internet", httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )
    intent, queries, _ = scenario("concert")
    job = jobs.create_job()
    assert await search(queries, job_id=job.job_id, allow_terms=allow_terms(intent)) == {}
    assert "search ✕ Tavily timed out" in error_messages(job)


async def test_offline_blocks_and_reports_reason(tavily):
    intent, queries, _ = scenario("concert")
    egress.set_offline(True)
    job = jobs.create_job()
    out = await search(queries, job_id=job.job_id, allow_terms=allow_terms(intent))
    assert out == {} and tavily["requests"] == []
    assert any("offline mode" in m for m in error_messages(job))
    assert all(r.blocked for r in egress.records())


async def test_missing_key_skips_search(monkeypatch, tavily):
    monkeypatch.setenv("TAVILY_API_KEY", "")
    monkeypatch.setattr(
        "app.pipeline.search.get_settings", lambda: type("S", (), {"tavily_api_key": ""})()
    )
    intent, queries, _ = scenario("concert")
    job = jobs.create_job()
    assert await search(queries, job_id=job.job_id, allow_terms=allow_terms(intent)) == {}
    assert tavily["requests"] == []
    assert any("TAVILY_API_KEY not set" in m for m in error_messages(job))


def test_request_body_omits_empty_domains():
    q = SearchQuery(text="x y", purpose="context")
    assert "include_domains" not in request_body(q)


# --- cards from recorded responses ------------------------------------------------


async def run_scenario(name: str, tavily) -> list[Card]:
    intent, queries, responses = scenario(name)
    load_replies(tavily, responses)
    results = await search(queries, job_id="j_none", allow_terms=allow_terms(intent))
    cards = build_cards(intent, queries, results, now=NOW)
    assert_card_hygiene(cards)
    return cards


async def test_concert_cards(tavily):
    cards = await run_scenario("concert", tavily)
    kinds = [c.kind for c in cards]
    print("\n" + "\n".join(f"{c.kind:9} {c.title} | {c.price} | {c.url}" for c in cards))

    tickets = [c for c in cards if c.kind == "tickets"]
    assert len(tickets) >= 2
    tm = tickets[0]
    assert tm.url == "https://www.ticketmaster.com/event/lumen-drift-paradise-rock-club"
    assert tm.price == "from $45" and tm.source == "ticketmaster.com"
    assert tm.actions[0].label == "Buy tickets" and tm.actions[0].type == "open_url"
    assert next(c for c in tickets if c.source == "axs.com").price == "from $49.50"

    cal = next(c for c in cards if c.kind == "calendar")
    ics = cal.actions[0].ics
    assert cal.actions[0].type == "download_ics" and cal.actions[0].label == "Add to calendar"
    assert ics.title == "Lumen Drift"
    assert ics.start == "2026-12-05T20:00:00" and ics.end == "2026-12-05T23:00:00"
    assert ics.location == "Paradise Rock Club, Boston"
    assert ics.url == tm.url

    place = next(c for c in cards if c.kind == "place")
    assert place.url == "https://www.google.com/maps/search/?api=1&query=Paradise+Rock+Club+Boston"
    assert place.actions[0].label == "Open in Maps"

    # Ranking: tickets first, then calendar, place, insight, link.
    order = [cards_mod.RANK[k] for k in kinds]
    assert order == sorted(order)
    assert kinds.index("calendar") < kinds.index("place")


async def test_product_cards(tavily):
    cards = await run_scenario("product", tavily)
    shop = [c for c in cards if c.kind == "shop"]
    assert [c.price for c in shop] == ["$199.99", "$189.00"]
    assert all(c.actions[0].label == "View price" for c in shop)
    assert shop[0].url == "https://www.shopmart.test/p/aurelo-pulse-x2"
    # No price in content -> plain link, not a shop card.
    assert any(c.kind == "link" and c.source == "aurelo.test" for c in cards)
    assert not any(c.kind in ("calendar", "place") for c in cards)


async def test_book_cards(tavily):
    cards = await run_scenario("book", tavily)
    books = [c for c in cards if c.kind == "book"]
    assert len(books) == 2
    assert all(c.actions[0].label == "Get the book" for c in books)
    assert books[0].source == "bookbarn.test" and "utm_" not in books[0].url
    assert any(c.kind == "insight" for c in cards)


async def test_document_cards(tavily):
    cards = await run_scenario("document", tavily)
    insight = next(c for c in cards if c.kind == "insight")
    assert len(insight.snippet) <= 240
    assert insight.actions[0].type == "copy" and insight.actions[0].text == insight.snippet
    links = [c for c in cards if c.kind == "link"]
    assert len(links) >= 2 and all(c.actions[0].label == "Open" for c in links)
    assert links[0].url == "https://news.test/northwind-q3?ref=home"


async def test_tavily_down_still_gives_local_cards(tavily):
    intent, queries, _ = scenario("concert")
    job = jobs.create_job()
    results = await search(queries, job_id=job.job_id, allow_terms=allow_terms(intent))
    cards = build_cards(intent, queries, results, now=NOW)
    assert [c.kind for c in cards] == ["calendar", "place"]
    assert cards[0].actions[0].ics.url is None
    assert error_messages(job) == ["search ✕ Tavily error (HTTP 500)"]


def test_cap_and_dedupe_with_many_results():
    intent, queries, responses = scenario("concert")
    big = responses[queries[0].text] | {
        "results": [
            {
                "title": f"Show {i}",
                "url": f"https://www.stubhub.com/e/{i}?utm_source=x",
                "content": f"from ${20 + i}",
                "score": 0.5 + i / 100,
            }
            for i in range(10)
        ]
    }
    results = {queries[0].text: TavilyResponse.model_validate(big)}
    cards = build_cards(intent, queries, results, now=NOW)
    assert_card_hygiene(cards)
    assert len(cards) == 6
    assert {"calendar", "place"} <= {c.kind for c in cards}


# --- helpers ----------------------------------------------------------------------


def test_clean_url():
    assert clean_url("https://a.test/p?utm_source=x&id=3&fbclid=1&gclid=2&UTM_Medium=m#frag") == (
        "https://a.test/p?id=3"
    )


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Tickets $55.00, GA $45 and $ 39", "$39"),
        ("$1,299.99 or $0 or $0.00 or $899", "$899"),
        ("Now $199.99. Free shipping over $35, save $30, $10 off today", "$199.99"),
        ("no price here", None),
    ],
)
def test_lowest_price(text, expected):
    assert lowest_price(text) == expected


def test_event_date_rolls_to_next_year_only_without_year():
    assert parse_event_start("Mar 3", None, NOW) == datetime(2027, 3, 3, 20, 0)
    assert parse_event_start("Dec 5", "9:30 pm", NOW) == datetime(2026, 12, 5, 21, 30)
    assert parse_event_start("2026-12-05", "20:00", NOW) == datetime(2026, 12, 5, 20, 0)
    assert parse_event_start("not a date", None, NOW) is None


def test_bad_date_skips_calendar_card():
    intent, queries, _ = scenario("concert")
    ents = [
        e if e.type != "date" else e.model_copy(update={"value": "soon"})
        for e in intent.public_entities
    ]
    intent = intent.model_copy(update={"public_entities": ents})
    cards = build_cards(intent, queries, {}, now=NOW)
    assert [c.kind for c in cards] == ["place"]


# --- live -------------------------------------------------------------------------


@pytest.mark.live
@pytest.mark.skipif(
    not (os.getenv("TAVILY_API_KEY") or Settings().tavily_api_key),
    reason="needs TAVILY_API_KEY (env or .env)",
)
async def test_live_concert_fixture():
    get_settings.cache_clear()
    raw = json.loads(
        (
            Path(__file__).resolve().parent.parent / "fixtures" / "concert_flyer.result.json"
        ).read_text()
    )
    intent = Intent.model_validate(raw["intent"])
    queries = [SearchQuery.model_validate(q) for q in raw["queries"]]
    results = await search(queries, job_id="j_live", allow_terms=allow_terms(intent))
    cards = build_cards(intent, queries, results)
    for c in cards:
        print(f"{c.kind:9} {c.title} | {c.price or ''} | {c.url or ''}")
    assert results, "Tavily returned nothing"
    assert_card_hygiene(cards)
    assert any(c.kind == "calendar" for c in cards)
