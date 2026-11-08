"""DEMO_FALLBACK (issue #17): failed Tavily calls are answered from recorded responses, labelled."""

import importlib.util
import json
from pathlib import Path

import httpx
import pytest

from app import egress, jobs
from app.models import Intent, SearchQuery
from app.pipeline import search as search_mod
from app.pipeline.search import load_recorded, query_slug, search

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(__file__).resolve().parent / "data"
KEY = "tvly-TESTkey0000000000000000"


def scenario():
    raw = json.loads((DATA / "tavily_concert.json").read_text())
    intent = Intent.model_validate(raw["intent"])
    queries = [SearchQuery.model_validate(q) for q in raw["queries"]]
    allow = {e.value for e in intent.public_entities if e.type in ("performer", "author")}
    return queries, raw["responses"], allow


def save(directory: Path, query: str, response: dict) -> None:
    saved = {"query": query, "recorded_at": "2026-11-07T12:00:00Z", "response": response}
    (directory / f"{query_slug(query)}.json").write_text(json.dumps(saved))


def messages(job) -> list[str]:
    return [e.message for e in job.events]


@pytest.fixture(autouse=True)
def guard(monkeypatch, tmp_path):
    monkeypatch.delenv("LATENT_OFFLINE", raising=False)
    monkeypatch.setattr(egress, "LOG_PATH", tmp_path / "egress.log")
    monkeypatch.setattr(egress, "_pii_checker", lambda: egress._fallback_contains_pii)
    monkeypatch.setattr(search_mod, "RECORDED_DIR", tmp_path / "recorded")
    (tmp_path / "recorded").mkdir()
    monkeypatch.setenv("TAVILY_API_KEY", KEY)
    monkeypatch.setenv("DEMO_FALLBACK", "1")
    egress.set_offline(None)
    egress.clear_records()
    yield tmp_path / "recorded"
    egress.set_offline(None)
    egress.clear_records()
    monkeypatch.setattr(egress, "_internet", None)


def network(monkeypatch, handler) -> list[httpx.Request]:
    seen: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    monkeypatch.setattr(
        egress, "_internet", httpx.AsyncClient(transport=httpx.MockTransport(wrapped))
    )
    return seen


def wifi_off(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("network is unreachable", request=request)


def test_query_slug():
    assert query_slug("Lumen Drift Paradise Rock Club Boston tickets") == (
        "lumen-drift-paradise-rock-club-boston-tickets"
    )
    assert query_slug("  ¿?  ") == "query"
    assert len(query_slug("word " * 50)) <= 80


async def test_network_down_serves_recorded_with_label(monkeypatch, guard):
    queries, responses, allow = scenario()
    for q in queries:
        save(guard, q.text, responses[q.text])
    network(monkeypatch, wifi_off)
    job = jobs.create_job()

    out = await search(queries, job_id=job.job_id, allow_terms=allow)

    assert set(out) == {q.text for q in queries}
    assert out[queries[0].text].results[0].score == 0.94
    recorded = [e for e in job.events if "(recorded result)" in e.message]
    assert len(recorded) == len(queries)
    assert all(e.local and e.stage == "search" and e.data["recorded"] for e in recorded)
    # The failure is still reported: the demo never pretends the call was live.
    assert "search ✕ Tavily unreachable (ConnectError)" in messages(job)


async def test_timeout_and_http_errors_fall_back(monkeypatch, guard):
    queries, responses, allow = scenario()
    for q in queries:
        save(guard, q.text, responses[q.text])

    def flaky(request: httpx.Request) -> httpx.Response:
        if json.loads(request.content)["query"] == queries[0].text:
            raise httpx.ReadTimeout("slow", request=request)
        return httpx.Response(432, json={"detail": "plan limit"})

    network(monkeypatch, flaky)
    job = jobs.create_job()
    out = await search(queries, job_id=job.job_id, allow_terms=allow)
    assert set(out) == {q.text for q in queries}
    assert sum("(recorded result)" in m for m in messages(job)) == len(queries)


async def test_live_success_is_not_replaced(monkeypatch, guard):
    queries, responses, allow = scenario()
    save(guard, queries[0].text, {"results": [{"title": "old", "url": "https://x.example"}]})
    network(
        monkeypatch,
        lambda r: httpx.Response(200, json=responses[json.loads(r.content)["query"]]),
    )
    job = jobs.create_job()
    out = await search(queries, job_id=job.job_id, allow_terms=allow)
    assert out[queries[0].text].results[0].title != "old"
    assert not any("(recorded result)" in m for m in messages(job))


async def test_air_gap_block_is_never_replaced(monkeypatch, guard):
    queries, responses, allow = scenario()
    for q in queries:
        save(guard, q.text, responses[q.text])
    seen = network(monkeypatch, wifi_off)
    egress.set_offline(True)
    job = jobs.create_job()
    out = await search(queries, job_id=job.job_id, allow_terms=allow)
    assert out == {} and seen == []
    assert not any("(recorded result)" in m for m in messages(job))
    assert any("offline mode" in m for m in messages(job))


async def test_off_by_default(monkeypatch, guard):
    monkeypatch.delenv("DEMO_FALLBACK")
    monkeypatch.setattr(
        "app.pipeline.search.get_settings",
        lambda: type("S", (), {"tavily_api_key": "", "demo_fallback": False})(),
    )
    queries, responses, allow = scenario()
    for q in queries:
        save(guard, q.text, responses[q.text])
    network(monkeypatch, wifi_off)
    job = jobs.create_job()
    assert await search(queries, job_id=job.job_id, allow_terms=allow) == {}
    assert not any("(recorded result)" in m for m in messages(job))


async def test_missing_recording_reports_and_skips(monkeypatch, guard):
    queries, _, allow = scenario()
    network(monkeypatch, wifi_off)
    job = jobs.create_job()
    assert await search(queries, job_id=job.job_id, allow_terms=allow) == {}
    assert any(m.startswith("search ✕ no recorded result for") for m in messages(job))


def test_recording_for_another_query_is_ignored(guard):
    path = guard / f"{query_slug('Lumen Drift tickets')}.json"
    path.write_text(json.dumps({"query": "Lumen-Drift tickets", "response": {"results": []}}))
    assert load_recorded("Lumen Drift tickets") is None
    path.write_text("not json")
    assert load_recorded("Lumen Drift tickets") is None


# --- scripts/record_tavily.py -----------------------------------------------------


def load_script():
    spec = importlib.util.spec_from_file_location(
        "record_tavily", ROOT / "scripts" / "record_tavily.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def test_record_script_round_trip(monkeypatch, guard, capsys):
    script = load_script()
    queries, responses, allow = scenario()
    seen = network(
        monkeypatch,
        lambda r: httpx.Response(200, json=responses[json.loads(r.content)["query"]]),
    )
    args = [queries[1].text, *(a for term in allow for a in ("--allow", term))]
    assert await script.main(args) == 0

    saved = json.loads((guard / f"{query_slug(queries[1].text)}.json").read_text())
    assert saved["query"] == queries[1].text and saved["request"]["query"] == queries[1].text
    assert KEY not in json.dumps(saved) and KEY not in capsys.readouterr().out
    assert seen[0].headers["authorization"] == f"Bearer {KEY}"
    assert load_recorded(queries[1].text).results  # what the fallback will serve
    assert [r.host for r in egress.records()] == ["api.tavily.com"]  # audited like the pipeline


def test_record_script_reads_sent_queries_from_egress_log(tmp_path):
    script = load_script()
    body = {"query": "Lumen Drift tickets", "topic": "general", "include_domains": ["dice.fm"]}
    lines = [
        {"host": "api.tavily.com", "blocked": False, "payload_preview": json.dumps(body)},
        {"host": "api.tavily.com", "blocked": True, "payload_preview": json.dumps({"query": "x"})},
        {"host": "api.exa.ai", "blocked": False, "payload_preview": json.dumps({"query": "y"})},
        {"host": "api.tavily.com", "blocked": False, "payload_preview": '{"query": "cut off'},
    ]
    log = tmp_path / "egress.log"
    log.write_text("\n".join(json.dumps(line) for line in lines) + "\nnot json\n")
    queries = script.queries_from_egress_log(log)
    assert [(q.text, q.include_domains) for q in queries] == [("Lumen Drift tickets", ["dice.fm"])]


# --- whole pipeline with the Wi-Fi off ----------------------------------------------


async def test_pipeline_with_wifi_off_completes_on_recorded_results(monkeypatch, guard):
    """`DEMO_FALLBACK=1` + no network: the job ends `done` with web cards and honest labels."""
    from app.config import get_settings
    from app.pipeline import runner
    from app.pipeline import scrub as scrub_mod
    from app.pipeline.query import build_queries
    from tests.test_runner import INTENT, fake_extract, png_bytes, tavily_response

    monkeypatch.setenv("LATENT_MOCK", "0")
    monkeypatch.setenv("OLLAMA_HOST", "http://127.0.0.1:11434")
    get_settings.cache_clear()
    monkeypatch.setattr(egress, "_pii_checker", lambda: scrub_mod.contains_pii)
    scrub_mod.warm_up()
    monkeypatch.setattr(runner, "extract_intent", fake_extract)
    recorded = tavily_response(httpx.Request("POST", search_mod.TAVILY_URL)).json()
    queries = build_queries(scrub_mod.scrub_intent(INTENT)[0])
    assert queries
    for q in queries:
        save(guard, q.text, recorded)
    network(monkeypatch, wifi_off)

    job = jobs.create_job()
    await runner.run_job(job.job_id, png_bytes(), "concert_ig.png")

    assert job.result.status == "done"
    assert job.result.error is None  # not degraded: the recorded results stood in
    assert any(c.source == "ticketmaster.com" for c in job.result.cards)
    lines = messages(job)
    assert sum("(recorded result)" in m for m in lines) == len(queries)
    assert any(m.startswith("search ✕ Tavily unreachable") for m in lines)

    # Same run with the air-gap on: blocked, nothing recorded is served.
    egress.set_offline(True)
    job = jobs.create_job()
    await runner.run_job(job.job_id, png_bytes(), "concert_ig.png")
    assert job.result.status == "done"
    assert job.result.error == runner.SEARCH_DEGRADED_NOTE
    assert not any("(recorded result)" in m for m in messages(job))
