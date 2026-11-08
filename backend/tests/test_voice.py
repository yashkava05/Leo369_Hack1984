"""Reviewed voice actions reuse screenshot contracts without persisting raw text/audio."""

import io
import json
import wave
from datetime import date

import httpx
import pytest
from fastapi.testclient import TestClient

from app import egress, jobs, library
from app.config import get_settings
from app.main import app
from app.models import Intent, JobResult
from app.pipeline import voice_runner
from app.pipeline.query import (
    build_queries,
    build_voice_queries,
    provenance_ok,
    related_voice_query,
)

RAW = "private-reviewed-instruction never log or save this"
PUBLIC = Intent(
    intent_type="event",
    summary=RAW,
    public_entities=[
        {"type": "topic", "value": "AI events"},
        {"type": "city", "value": "Boston"},
        {"type": "date", "value": "2026-11-14"},
    ],
    redaction_counts={},
    confidence=0.9,
)


def wav_bytes():
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\x01\x00" * 1600)
    return output.getvalue()


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.setenv("LATENT_MOCK", "0")
    monkeypatch.setenv("EXA_API_KEY", "")
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-fake-voice-key")
    get_settings.cache_clear()
    jobs.JOBS.clear()
    egress.set_offline(False)
    egress.clear_records()
    yield
    egress.set_offline(None)
    get_settings.cache_clear()


def test_voice_templates_are_additive_and_provenance_valid():
    day = date(2026, 11, 7)
    queries = build_voice_queries(PUBLIC, day)
    assert [q.text for q in queries] == ["AI events Boston Nov 14 tickets"]
    assert all(provenance_ok(q, PUBLIC) for q in queries)
    without_date = PUBLIC.model_copy(update={"public_entities": PUBLIC.public_entities[:2]})
    assert build_voice_queries(without_date, day)[0].text == "AI events Boston tickets"
    # Existing screenshot templates are unchanged: unknown performer remains no ticket query.
    assert build_queries(PUBLIC, day) == []
    related = related_voice_query(PUBLIC, day)
    assert related and related.purpose == "related" and provenance_ok(related, PUBLIC)
    product = Intent(
        intent_type="product",
        summary="",
        public_entities=[{"type": "product", "value": "headphones"}],
        redaction_counts={},
        confidence=1,
    )
    assert related_voice_query(product, day).text == "headphones review"


@pytest.mark.parametrize(
    "body",
    [
        {"text": " ", "action": "explore"},
        {"text": "x" * 1001, "action": "save"},
        {"text": "x", "action": "related"},
        {"text": "x", "action": "related", "context_library_id": " "},
        {"text": "x", "action": "explore", "context_library_id": "j_context"},
        {"text": "x", "action": "save", "context_library_id": ""},
        {"text": "x", "action": "unknown"},
    ],
)
def test_analyze_rejects_invalid_combinations(body):
    response = TestClient(app).post("/api/voice/analyze", json=body)
    assert response.status_code == 422
    assert jobs.JOBS == {}


def test_unknown_context_is_404():
    response = TestClient(app).post(
        "/api/voice/analyze",
        json={"text": "More like this", "action": "related", "context_library_id": "missing"},
    )
    assert response.status_code == 404
    assert not jobs.JOBS


def test_transcribe_is_memory_only_and_mock_does_not_load_model(monkeypatch):
    from app import voice

    monkeypatch.setenv("LATENT_MOCK", "1")
    get_settings.cache_clear()
    monkeypatch.setattr(voice, "_load_model", lambda: pytest.fail("mock loaded Whisper"))
    response = TestClient(app).post(
        "/api/voice/transcribe",
        files={"audio": ("event.wav", wav_bytes(), "audio/wav; codecs=pcm")},
    )
    assert response.status_code == 200
    assert response.json()["language"] == "en"
    assert response.json()["duration_ms"] == 100
    assert 1 <= len(response.json()["transcript"]) <= 1000


@pytest.mark.parametrize(
    ("mime", "content", "status"),
    [
        ("audio/ogg", b"RIFFxxxxWAVE", 415),
        ("application/octet-stream", b"OggSxxxx", 415),
        ("audio/wav", b"", 415),
        ("audio/wav", b"x" * (8 * 1024 * 1024 + 1), 413),
    ],
)
def test_transcribe_rejects_bad_uploads(mime, content, status):
    response = TestClient(app).post(
        "/api/voice/transcribe", files={"audio": ("test.wav", content, mime)}
    )
    assert response.status_code == status


def test_missing_model_returns_503(monkeypatch, tmp_path):
    from app import voice

    monkeypatch.setenv("LATENT_STT_MODEL_PATH", str(tmp_path / "missing-model"))
    get_settings.cache_clear()
    monkeypatch.setattr(voice, "_model", None)
    # Duration decoding is tested separately; isolate missing-model status from optional AV.
    monkeypatch.setattr(voice, "_decode_audio", lambda data: ([], 1600))
    response = TestClient(app).post(
        "/api/voice/transcribe", files={"audio": ("event.wav", wav_bytes(), "audio/wav")}
    )
    assert response.status_code == 503
    assert response.json()["detail"] == "voice_model_unavailable"


def test_malformed_multipart_is_rejected_without_spooling(monkeypatch):
    import tempfile

    monkeypatch.setattr(
        tempfile, "SpooledTemporaryFile", lambda *args, **kwargs: pytest.fail("audio spooled")
    )
    client = TestClient(app)
    assert (
        client.post(
            "/api/voice/transcribe",
            content=b"bad",
            headers={"content-type": "multipart/form-data; boundary=x"},
        ).status_code
        == 415
    )
    assert (
        client.post(
            "/api/voice/transcribe", files={"not_audio": ("bad.wav", wav_bytes(), "audio/wav")}
        ).status_code
        == 415
    )


async def interpret(text, emit):
    await emit("extract", "ok", "Reviewed text interpreted on-device")
    return PUBLIC


async def test_save_is_local_scrubbed_and_retrievable(monkeypatch, caplog):
    monkeypatch.setattr(voice_runner, "extract_text_intent", interpret)
    monkeypatch.setattr(
        egress, "internet_post", lambda *args, **kwargs: pytest.fail("save opened internet")
    )
    job = jobs.create_job()
    await voice_runner.run_voice_job(job.job_id, RAW, "save", None)
    assert job.result.status == "done"
    saved = library.get(job.job_id)
    assert saved is not None and saved.intent.public_entities
    assert saved.queries == saved.cards == saved.egress == []
    assert RAW not in saved.model_dump_json()
    assert RAW not in json.dumps([e.model_dump(mode="json") for e in job.events])
    assert RAW not in caplog.text
    assert all(e.local for e in job.events)
    assert all(e.stage not in ("query", "search", "cards") for e in job.events)


async def test_explore_uses_shared_search_and_blocks_offline(monkeypatch):
    monkeypatch.setattr(voice_runner, "extract_text_intent", interpret)
    seen = []

    def transport(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"results": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        monkeypatch.setattr(egress, "_internet", client)
        first = jobs.create_job()
        await voice_runner.run_voice_job(first.job_id, RAW, "explore", None)
        assert first.result.status == "done" and first.result.queries
        assert first.events[0].stage == "extract"
        assert seen and all(RAW not in json.dumps(body) for body in seen)
        egress.set_offline(True)
        count = len(seen)
        second = jobs.create_job()
        await voice_runner.run_voice_job(second.job_id, RAW, "explore", None)
        assert len(seen) == count
        assert second.result.status == "done" and second.result.egress
        assert all(record.blocked for record in second.result.egress)


async def test_related_uses_only_the_selected_intent(monkeypatch):
    monkeypatch.setattr(
        voice_runner,
        "extract_text_intent",
        lambda *a: pytest.fail("related interpreted raw instruction"),
    )
    selected = JobResult(job_id="j_context", status="done", intent=PUBLIC)
    seen = []

    def transport(request):
        seen.append(json.loads(request.content)["query"])
        return httpx.Response(200, json={"results": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        monkeypatch.setattr(egress, "_internet", client)
        job = jobs.create_job()
        await voice_runner.run_voice_job(
            job.job_id, "private other interest unrelated to context", "related", selected
        )
        assert job.result.status == "done" and seen == ["AI events Boston Nov 14 tickets"]
        assert all(q.purpose == "related" and provenance_ok(q, PUBLIC) for q in job.result.queries)


def test_analyze_starts_existing_job_stream_without_persisting_request(monkeypatch):
    captured = []
    monkeypatch.setattr(jobs, "start_voice_job", lambda *args: captured.append(args))
    response = TestClient(app).post(
        "/api/voice/analyze", json={"text": "  Find AI events  ", "action": "explore"}
    )
    assert response.status_code == 202
    assert captured[0][1] == "Find AI events"
    job = jobs.get_job(response.json()["job_id"])
    assert job and RAW not in job.result.model_dump_json()


@pytest.mark.parametrize("mode", ["exception", "rejected"])
async def test_save_failure_is_a_safe_error_not_false_success(monkeypatch, caplog, mode):
    monkeypatch.setattr(voice_runner, "extract_text_intent", interpret)

    def fail_save(*args, **kwargs):
        if mode == "exception":
            raise OSError(RAW)
        return False

    monkeypatch.setattr(library, "save", fail_save)
    job = jobs.create_job()
    await voice_runner.run_voice_job(job.job_id, RAW, "save", None)
    assert job.result.status == "error"
    assert job.result.error == "local_save_unavailable"
    assert job.events[-1].stage == "error"
    assert all(event.stage != "done" for event in job.events)
    assert not job.result.queries and not job.result.egress
    assert RAW not in caplog.text + job.result.model_dump_json()


@pytest.mark.parametrize("entity_type", ["public_org", "performer", "event_name", "topic"])
def test_voice_named_event_search_does_not_require_an_invented_city(entity_type):
    intent = Intent(
        intent_type="event",
        summary="",
        public_entities=[{"type": entity_type, "value": "Dover Comets"}],
        redaction_counts={},
        confidence=1,
    )
    queries = build_voice_queries(intent, date(2026, 11, 8))
    assert [query.text for query in queries] == ["Dover Comets tickets"]
    assert all(provenance_ok(query, intent) for query in queries)
    assert related_voice_query(intent).text == "Dover Comets tickets"
    assert build_queries(intent) == []


def test_voice_city_alone_still_cannot_become_a_search():
    city_only = Intent.model_validate(
        {**PUBLIC.model_dump(), "public_entities": [{"type": "city", "value": "Boston"}]}
    )
    assert build_voice_queries(city_only) == []


def test_named_voice_team_takes_priority_over_a_generic_games_topic():
    intent = Intent(
        intent_type="event",
        summary="",
        public_entities=[
            {"type": "topic", "value": "games"},
            {"type": "public_org", "value": "Dover Comets"},
        ],
        redaction_counts={},
        confidence=1,
    )
    queries = build_voice_queries(intent)
    assert [query.text for query in queries] == ["Dover Comets tickets"]
    assert provenance_ok(queries[0], intent)
