"""Issue #16: the runtime air-gap toggle endpoints and their effect on egress.

GET /api/offline  -> {"offline": bool}
POST /api/offline -> {"offline": bool}

Toggling on must block the next internet_post (rule 1, "offline mode"); off must let it
through. The network is always mocked here — no real socket is opened.
"""

import os

import httpx
import pytest
from fastapi.testclient import TestClient

from app import egress
from app.egress import EgressBlocked
from app.main import app

TAVILY = "https://api.tavily.com/search"
KEY = "tvly-SECRETkey1234567890"
CLEAN = {"query": "tame impala boston tickets", "topic": "general"}


def fake_contains_pii(text, allow=frozenset()):
    words = [w for w in text.split() if "@" in w and "." in w and w not in allow]
    return ["EMAIL_ADDRESS"] if words else []


@pytest.fixture(autouse=True)
def guard(monkeypatch, tmp_path):
    monkeypatch.delenv("LATENT_OFFLINE", raising=False)
    monkeypatch.setattr(egress, "LOG_PATH", tmp_path / "egress.log")
    monkeypatch.setattr(egress, "_pii_checker", lambda: fake_contains_pii)
    monkeypatch.setenv("TAVILY_API_KEY", KEY)
    egress.set_offline(None)
    egress.clear_records()
    yield
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


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def auth():
    return {"Authorization": f"Bearer {KEY}"}


# --- endpoints ----------------------------------------------------------------------


def test_get_offline_defaults_false(client):
    assert client.get("/api/offline").json() == {"offline": False}


def test_post_offline_roundtrip(client):
    assert client.post("/api/offline", json={"offline": True}).json() == {"offline": True}
    assert client.get("/api/offline").json() == {"offline": True}
    assert egress.is_offline() is True

    assert client.post("/api/offline", json={"offline": False}).json() == {"offline": False}
    assert client.get("/api/offline").json() == {"offline": False}
    assert egress.is_offline() is False


def test_post_offline_reflects_env_default(client, monkeypatch):
    monkeypatch.setenv("LATENT_OFFLINE", "1")
    egress.set_offline(None)  # fall back to env
    assert client.get("/api/offline").json() == {"offline": True}


def test_post_offline_rejects_unknown_fields(client):
    assert client.post("/api/offline", json={"offline": True, "evil": 1}).status_code == 422


# --- effect on egress ---------------------------------------------------------------


async def test_toggle_on_blocks_next_request(client, sent):
    client.post("/api/offline", json={"offline": True})

    with pytest.raises(EgressBlocked) as exc:
        await egress.internet_post(TAVILY, CLEAN, auth(), job_id=None)

    assert exc.value.reason == "offline mode"
    assert sent == []  # nothing left the device
    record = egress.records()[0]
    assert record.blocked is True and record.reason == "offline mode"


async def test_toggle_off_lets_request_through(client, sent):
    client.post("/api/offline", json={"offline": False})

    response = await egress.internet_post(TAVILY, CLEAN, auth(), job_id=None)

    assert response.status_code == 200
    assert len(sent) == 1
    record = egress.records()[0]
    assert record.blocked is False and record.reason is None


async def test_no_api_key_in_offline_records(client, sent):
    client.post("/api/offline", json={"offline": True})
    with pytest.raises(EgressBlocked):
        await egress.internet_post(TAVILY, CLEAN, auth(), job_id=None)
    # The blocked attempt is recorded without any secret leaking into the preview.
    assert KEY not in os.linesep.join(r.payload_preview for r in egress.records())
