import json
import logging

import httpx
import pytest
from fastapi.testclient import TestClient

from app import egress, ollama
from app.config import get_settings
from app.main import app

MODEL = "qwen2.5vl:3b"
SECRET = "tvly-super-secret-value"


def fake_ollama(*, pulled=True, loaded=True, calls=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(request)
        path = request.url.path
        if path == "/api/version":
            return httpx.Response(200, json={"version": "0.12.0"})
        if path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": MODEL}] if pulled else []})
        if path == "/api/ps":
            return httpx.Response(
                200, json={"models": [{"name": MODEL, "model": MODEL}] if loaded else []}
            )
        if path == "/api/chat":
            return httpx.Response(200, json={"message": {"role": "assistant", "content": "Hello"}})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def ollama_down():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    return httpx.MockTransport(handler)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("LATENT_MOCK", "1")  # no real warm-up request during tests
    monkeypatch.setenv("LATENT_MODEL", MODEL)
    monkeypatch.setenv("TAVILY_API_KEY", SECRET)
    monkeypatch.setattr(egress, "local_client", lambda: _fake["http"])
    get_settings.cache_clear()
    with TestClient(app) as c:
        yield c
    get_settings.cache_clear()


_fake: dict[str, httpx.AsyncClient] = {}


def use_transport(transport):
    """Point the health endpoint's egress.local_client() at a fake Ollama."""
    _fake["http"] = httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:11434")


def test_health_ok_when_model_pulled_and_loaded(client):
    use_transport(fake_ollama())
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {
        "status": "ok",
        "ollama": "up",
        "model": MODEL,
        "model_loaded": True,
        "tavily_key": True,
    }


def test_health_model_not_loaded_yet(client):
    use_transport(fake_ollama(loaded=False))
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["model_loaded"] is False


def test_health_degraded_when_model_not_pulled(client):
    use_transport(fake_ollama(pulled=False, loaded=False))
    body = client.get("/api/health").json()
    assert body["status"] == "degraded"
    assert body["ollama"] == "up"
    assert body["model"] is None


def test_health_degraded_when_ollama_down(client, caplog):
    use_transport(ollama_down())
    with caplog.at_level(logging.DEBUG):
        resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {
        "status": "degraded",
        "ollama": "down",
        "model": None,
        "model_loaded": False,
        "tavily_key": True,
    }
    assert SECRET not in resp.text
    assert SECRET not in caplog.text


def test_tavily_key_absent(client, monkeypatch):
    monkeypatch.setenv("TAVILY_API_KEY", "")
    get_settings.cache_clear()
    use_transport(fake_ollama())
    assert client.get("/api/health").json()["tavily_key"] is False


def test_untagged_model_name_matches_latest():
    assert ollama._has_model({"models": [{"name": "llava:latest"}]}, "llava")


async def test_warm_up_posts_keep_alive():
    calls = []
    async with httpx.AsyncClient(
        transport=fake_ollama(calls=calls), base_url="http://127.0.0.1:11434"
    ) as http:
        assert await ollama.warm_up(http, MODEL)
    body = json.loads(calls[0].content)
    assert calls[0].url.path == "/api/chat"
    assert body["model"] == MODEL
    assert body["keep_alive"] == "30m"
    assert body["stream"] is False


async def test_warm_up_survives_ollama_down():
    async with httpx.AsyncClient(
        transport=ollama_down(), base_url="http://127.0.0.1:11434"
    ) as http:
        assert await ollama.warm_up(http, MODEL) is False
