"""Egress guard: the six rules, audit records, events, offline switch and local client."""

import base64
import json
import os

import httpx
import pytest
from fastapi.testclient import TestClient

from app import egress, jobs
from app.egress import EgressBlocked, LocalHostRefused

TAVILY = "https://api.tavily.com/search"
KEY = "tvly-SECRETkey1234567890"
CLEAN = {
    "query": "tame impala boston tickets",
    "topic": "general",
    "max_results": 5,
    "include_domains": ["ticketmaster.com"],
}


def fake_contains_pii(text, allow=frozenset()):
    # Stand-in for app.pipeline.scrub.contains_pii: emails only, honouring the allow-list.
    words = [w for w in text.split() if "@" in w and "." in w and w not in allow]
    return ["EMAIL_ADDRESS"] if words else []


@pytest.fixture(autouse=True)
def guard(monkeypatch, tmp_path):
    # Offline-mode tests set LATENT_OFFLINE themselves so they also pass under
    # `LATENT_OFFLINE=1 pytest -k offline`; everything else runs online.
    if "offline" not in os.environ.get("PYTEST_CURRENT_TEST", ""):
        monkeypatch.delenv("LATENT_OFFLINE", raising=False)
    monkeypatch.setattr(egress, "LOG_PATH", tmp_path / "egress.log")
    monkeypatch.setattr(egress, "_pii_checker", lambda: fake_contains_pii)
    monkeypatch.setenv("TAVILY_API_KEY", KEY)
    egress.set_offline(None)
    egress.clear_records()
    yield tmp_path / "egress.log"
    egress.set_offline(None)
    egress.clear_records()


@pytest.fixture
def sent(monkeypatch):
    """Mock transport for the internet client; collects every request that left."""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"results": []})

    monkeypatch.setattr(
        egress, "_internet", httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )
    yield requests
    monkeypatch.setattr(egress, "_internet", None)


def auth():
    return {"Authorization": f"Bearer {KEY}"}


async def blocked(url=TAVILY, body=CLEAN, **kw) -> EgressBlocked:
    with pytest.raises(EgressBlocked) as exc:
        await egress.internet_post(url, body, auth(), job_id=None, **kw)
    return exc.value


# --- rule 1: offline ----------------------------------------------------------------


async def test_offline_env_blocks_everything(monkeypatch, sent):
    monkeypatch.setenv("LATENT_OFFLINE", "1")
    err = await blocked()
    assert err.reason == "offline mode"
    assert sent == []
    assert egress.records()[0].blocked and egress.records()[0].reason == "offline mode"


async def test_offline_switch_overrides_env(monkeypatch, sent):
    monkeypatch.delenv("LATENT_OFFLINE", raising=False)
    egress.set_offline(True)
    assert (await blocked()).reason == "offline mode"
    egress.set_offline(False)
    await egress.internet_post(TAVILY, CLEAN, auth(), job_id=None)
    assert len(sent) == 1


# --- rule 2: host + scheme ------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example.com/collect",
        "http://api.tavily.com/search",
        "https://api.tavily.com.evil.com/search",
        "https://api.tavily.com:8443/search",
        "https://user@api.tavily.com/search",
    ],
)
async def test_disallowed_host_or_scheme_blocked(url, sent):
    err = await blocked(url)
    assert "not allowed" in err.reason or "not in allow-list" in err.reason
    assert sent == []


# --- rule 3: size ---------------------------------------------------------------------


async def test_body_over_4kb_blocked(sent):
    body = {"query": "word " * 1024}  # ~5 KB of plain text
    err = await blocked(body=body)
    assert "exceeds 4096" in err.reason
    assert egress.records()[0].bytes_out == len(json.dumps(body).encode()) > 4096
    assert sent == []


# --- rule 4: base64 -------------------------------------------------------------------


async def test_base64_blob_blocked(sent):
    blob = base64.b64encode(bytes(range(256)) * 2).decode()  # ~680 chars, < 4 KB
    err = await blocked(body={"query": "tickets", "image": blob})
    assert err.reason == "base64-like blob in body"
    assert sent == []


# --- rule 5: PII ----------------------------------------------------------------------


async def test_email_in_query_blocked(sent):
    err = await blocked(body={"query": "email jane.doe@acme.com about tickets"})
    assert err.reason == "pii in body: EMAIL_ADDRESS"
    assert sent == []


async def test_pii_checked_in_nested_strings(sent):
    err = await blocked(body={"query": "tickets", "include_domains": ["x", {"y": "a@b.co"}]})
    assert "EMAIL_ADDRESS" in err.reason


async def test_allow_terms_pass_through(sent):
    body = {"query": "fan@band.com tour"}
    await egress.internet_post(TAVILY, body, auth(), job_id=None, allow_terms={"fan@band.com"})
    assert len(sent) == 1


def test_fallback_pii_check_until_scrubber_lands():
    check = egress._fallback_contains_pii
    assert check("tame impala boston tickets") == []
    assert check("email jane.doe@acme.com") == ["EMAIL_ADDRESS"]
    assert "PHONE_NUMBER" in check("call me at 617-555-0134")
    assert "HANDLE" in check("dm @nish_k")
    assert check("concert 2026-11-07 at 8pm $89") == []
    assert check("@nish_k", allow={"@nish_k"}) == []


# --- rule 6: API keys -----------------------------------------------------------------


async def test_api_key_field_blocked_and_stripped(guard, sent):
    err = await blocked(body={**CLEAN, "api_key": KEY})
    assert err.reason.startswith("api key in body")
    rec = egress.records()[0]
    assert "api_key" not in rec.payload_preview
    assert KEY not in rec.model_dump_json()
    assert KEY not in guard.read_text()
    assert sent == []


async def test_api_key_value_under_other_name_blocked_and_redacted(guard, sent):
    err = await blocked(body={**CLEAN, "token": KEY})
    assert err.reason.startswith("api key in body")
    assert KEY not in egress.records()[0].model_dump_json()
    assert "[redacted]" in egress.records()[0].payload_preview
    assert KEY not in guard.read_text()


# --- allowed request + record fields ------------------------------------------------


async def test_clean_tavily_body_is_sent_and_recorded(guard, sent):
    resp = await egress.internet_post(TAVILY, CLEAN, auth(), job_id=None)
    assert resp.status_code == 200
    [req] = sent
    assert req.url == httpx.URL(TAVILY)
    assert req.headers["authorization"] == f"Bearer {KEY}"
    assert json.loads(req.content) == CLEAN

    [rec] = egress.records()
    assert rec.method == "POST"
    assert rec.host == "api.tavily.com"
    assert rec.path == "/search"
    assert rec.bytes_out == len(req.content) == len(json.dumps(CLEAN).encode())
    assert rec.payload_preview == json.dumps(CLEAN)[:300]
    assert rec.blocked is False and rec.reason is None
    assert rec.id.startswith("e_") and rec.ts > 0

    [line] = guard.read_text().splitlines()
    assert json.loads(line) == rec.model_dump(mode="json")
    assert KEY not in guard.read_text()


async def test_preview_truncated_to_300_chars(sent):
    body = {"query": "tickets " + "x " * 400}
    await egress.internet_post(TAVILY, body, auth(), job_id=None)
    assert len(egress.records()[0].payload_preview) == 300


async def test_records_newest_first_and_capped(sent, monkeypatch):
    monkeypatch.setenv("LATENT_OFFLINE", "1")
    for _ in range(egress.MAX_RECORDS + 5):
        with pytest.raises(EgressBlocked):
            await egress.internet_post(TAVILY, CLEAN, auth(), job_id=None)
    recs = egress.records()
    assert len(recs) == egress.MAX_RECORDS
    assert [r.ts for r in recs] == sorted((r.ts for r in recs), reverse=True)


# --- events ---------------------------------------------------------------------------


async def test_attempts_emit_search_events_without_keys(sent):
    job = jobs.create_job()
    await egress.internet_post(TAVILY, CLEAN, auth(), job_id=job.job_id)
    with pytest.raises(EgressBlocked):
        await egress.internet_post("https://evil.example.com/x", CLEAN, auth(), job_id=job.job_id)
    ok, bad = job.events
    size = len(json.dumps(CLEAN).encode())
    assert ok.stage == bad.stage == "search"
    assert ok.local is False and bad.local is False
    assert [ok.seq, bad.seq] == [0, 1]
    expected = f"network → POST api.tavily.com/search · {size} bytes · image data: 0 bytes"
    assert ok.message == expected
    assert ok.data == {
        "host": "api.tavily.com",
        "path": "/search",
        "bytes_out": size,
        "blocked": False,
        "reason": None,
    }
    assert bad.data["blocked"] is True and "allow-list" in bad.data["reason"]
    assert bad.status == "error"
    assert [r.blocked for r in job.result.egress] == [False, True]
    assert KEY not in ok.model_dump_json() + bad.model_dump_json()


# --- GET /api/egress ------------------------------------------------------------------


async def test_get_egress_lists_every_attempt(sent):
    await egress.internet_post(TAVILY, CLEAN, auth(), job_id=None)
    with pytest.raises(EgressBlocked):
        await egress.internet_post(TAVILY, {"query": "x" * 5000}, auth(), job_id=None)
    from app.main import app

    with TestClient(app) as client:
        body = client.get("/api/egress").json()
    mine = [r for r in body if r["id"] in {rec.id for rec in egress.records()}]
    assert [r["blocked"] for r in mine] == [True, False]
    assert mine[0]["bytes_out"] == len(json.dumps({"query": "x" * 5000}).encode())
    assert mine[1]["bytes_out"] == len(json.dumps(CLEAN).encode())
    assert KEY not in json.dumps(body)


# --- local client ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "host",
    ["http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434", "127.0.0.1:11434"],
)
async def test_local_client_accepts_loopback(monkeypatch, host):
    monkeypatch.setenv("OLLAMA_HOST", host)
    client = egress.local_client()
    assert client.base_url.host in egress.LOOPBACK_HOSTS
    await egress.aclose()


@pytest.mark.parametrize(
    "host",
    ["http://192.168.1.20:11434", "https://ollama.example.com", "http://10.0.0.5", "file:///x"],
)
def test_local_client_refuses_non_loopback(monkeypatch, host):
    monkeypatch.setenv("OLLAMA_HOST", host)
    with pytest.raises(LocalHostRefused):
        egress.local_client()


def test_startup_refuses_non_loopback_ollama(monkeypatch):
    monkeypatch.setenv("OLLAMA_HOST", "http://192.168.1.20:11434")
    from app.main import app

    with pytest.raises(LocalHostRefused), TestClient(app):
        pass
