"""The real pipeline runner: event order, local flags, timings, degradation and the semaphore.

`extract_intent` is monkeypatched (no Ollama) and Tavily is served by an httpx.MockTransport
(no network key), so these tests are fully offline. The scrub/query/cards stages run for real.
"""

import asyncio
import io

import httpx
import pytest
from PIL import Image

from app import egress, jobs
from app.config import get_settings
from app.models import Intent, JobResult
from app.pipeline import runner
from app.pipeline import scrub as scrub_mod

INTENT = Intent(
    intent_type="event",
    summary="Tame Impala at TD Garden in Boston",
    public_entities=[
        {"type": "performer", "value": "Tame Impala"},
        {"type": "venue", "value": "TD Garden"},
        {"type": "city", "value": "Boston"},
        {"type": "date", "value": "2026-11-15"},
    ],
    redaction_counts={"handle": 2, "name": 1},
    confidence=0.9,
)


def png_bytes(size=(400, 300)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, (230, 230, 230)).save(out, format="PNG")
    return out.getvalue()


def tavily_response(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "query": "q",
            "answer": "Tickets are on sale now.",
            "results": [
                {
                    "title": "Tame Impala Tickets",
                    "url": "https://www.ticketmaster.com/event/12345",
                    "content": "Tickets from $89",
                    "score": 0.95,
                }
            ],
        },
    )


async def fake_extract(image_bytes: bytes, emit) -> Intent:
    await emit("extract", "start", "Reading image on-device")
    await emit("extract", "progress", "Running qwen2.5vl:3b locally…")
    await emit("extract", "ok", "intent: event · 4 public entities")
    return INTENT


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("LATENT_MOCK", "0")
    monkeypatch.setenv("OLLAMA_HOST", "http://127.0.0.1:11434")
    get_settings.cache_clear()
    # Build the Presidio analyzer on the main thread (as app startup does) so the runner's
    # asyncio.to_thread scrub call does not leave the shared singleton in a cold state for
    # the rest of the suite. Matches main.py's lifespan warm-up.
    scrub_mod.warm_up()
    egress.set_offline(None)
    egress.clear_records()
    jobs.JOBS.clear()
    yield
    egress.set_offline(None)
    get_settings.cache_clear()


@pytest.fixture
def tavily(monkeypatch):
    """Serve Tavily via a MockTransport and provide a key so search runs."""
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-testkey0123456789")
    get_settings.cache_clear()
    client = httpx.AsyncClient(transport=httpx.MockTransport(tavily_response))
    monkeypatch.setattr(egress, "_internet", client)
    yield client


def stages(events):
    return [(e.stage, e.status) for e in events]


async def test_success_event_order_and_flags(monkeypatch, tavily):
    monkeypatch.setattr(runner, "extract_intent", fake_extract)
    job = jobs.create_job()
    await runner.run_job(job.job_id, png_bytes(), "concert.png")

    events = job.events
    seq = [e.seq for e in events]
    assert seq == list(range(len(events)))  # contiguous, in order

    st = stages(events)
    assert st[:2] == [("ingest", "start"), ("ingest", "ok")]
    assert ("extract", "ok") in st
    assert st.index(("scrub", "start")) > st.index(("extract", "ok"))
    assert st.index(("scrub", "ok")) < st.index(("query", "ok"))
    assert st.index(("query", "ok")) < st.index(("search", "ok"))
    assert st.index(("search", "ok")) < st.index(("cards", "ok"))
    assert st[-1] == ("done", "ok")

    # local flag: everything on-device except the search (network) stage.
    for e in events:
        assert e.local is (e.stage != "search"), (e.stage, e.local)

    done = events[-1]
    result = JobResult.model_validate(done.data)
    assert result.status == "done"
    assert result.error is None
    assert result.job_id == job.job_id
    assert result.queries, "expected queries from an event intent"
    assert result.cards, "expected at least one card"
    assert set(result.timings_ms) >= {"ingest", "extract", "scrub", "query", "search", "cards"}
    assert job.result.model_dump(mode="json") == done.data


async def test_query_and_cards_event_data(monkeypatch, tavily):
    monkeypatch.setattr(runner, "extract_intent", fake_extract)
    job = jobs.create_job()
    await runner.run_job(job.job_id, png_bytes(), "concert.png")

    query_ok = next(e for e in job.events if e.stage == "query" and e.status == "ok")
    assert isinstance(query_ok.data["queries"], list) and query_ok.data["queries"]
    cards_ok = next(e for e in job.events if e.stage == "cards" and e.status == "ok")
    assert cards_ok.data["count"] == len(job.result.cards)


async def test_extraction_failure_yields_error(monkeypatch):
    async def boom(image_bytes, emit):
        await emit("extract", "error", "Local model unavailable")
        raise httpx.ConnectError("no ollama")

    monkeypatch.setattr(runner, "extract_intent", boom)
    job = jobs.create_job()
    await runner.run_job(job.job_id, png_bytes(), "concert.png")

    assert job.events[-1].stage == "error"
    assert job.result.status == "error"
    assert job.result.error and "extraction failed" in job.result.error
    assert job.result.cards == []


async def test_bad_image_yields_error_only(monkeypatch):
    monkeypatch.setattr(runner, "extract_intent", fake_extract)
    job = jobs.create_job()
    await runner.run_job(job.job_id, b"\x89PNG not a real image", "fake.png")
    assert stages(job.events) == [("error", "error")]
    assert job.result.status == "error"


async def test_search_failure_degrades_to_local_cards(monkeypatch):
    monkeypatch.setattr(runner, "extract_intent", fake_extract)
    egress.set_offline(True)  # every outbound request is blocked
    job = jobs.create_job()
    await runner.run_job(job.job_id, png_bytes(), "concert.png")

    assert job.result.status == "done"
    assert job.result.error == runner.SEARCH_DEGRADED_NOTE
    # Local-only: the on-device calendar card still blooms with no network results.
    assert any(c.kind == "calendar" for c in job.result.cards)
    assert all(c.source != "ticketmaster.com" for c in job.result.cards)


async def test_two_jobs_second_waits_for_the_model(monkeypatch):
    release = asyncio.Event()
    first_started = asyncio.Event()
    calls = {"n": 0}

    async def gated(image_bytes, emit):
        calls["n"] += 1
        await emit("extract", "start", "Reading image on-device")
        if calls["n"] == 1:
            first_started.set()
            await release.wait()
        await emit("extract", "ok", "intent: event")
        return INTENT

    monkeypatch.setattr(runner, "extract_intent", gated)
    job1 = jobs.create_job()
    job2 = jobs.create_job()

    t1 = asyncio.create_task(runner.run_job(job1.job_id, png_bytes(), "a.png"))
    await asyncio.wait_for(first_started.wait(), timeout=2)
    t2 = asyncio.create_task(runner.run_job(job2.job_id, png_bytes(), "b.png"))
    await asyncio.sleep(0.05)  # let job2 reach the busy semaphore

    waiting = [e for e in job2.events if "Waiting for the local model" in e.message]
    assert waiting and waiting[0].stage == "extract"

    release.set()
    await asyncio.wait_for(asyncio.gather(t1, t2), timeout=5)
    assert job1.result.status == "done"
    assert job2.result.status == "done"


def test_cleanup_drops_old_finished_jobs():
    old = jobs.create_job()
    old.result = old.result.model_copy(update={"status": "done"})
    old.events.append(
        runner.StageEvent(
            job_id=old.job_id, seq=0, ts=0.0, stage="done", status="ok", message="done", local=True
        )
    )
    jobs.cleanup_finished()
    assert jobs.get_job(old.job_id) is None
