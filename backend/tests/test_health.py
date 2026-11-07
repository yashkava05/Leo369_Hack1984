import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("LATENT_MOCK", "1")  # no warm-up request during tests
    monkeypatch.setenv("OLLAMA_HOST", "http://127.0.0.1:9")  # nothing listens here
    monkeypatch.setenv("TAVILY_API_KEY", "")  # override any key in .env
    get_settings.cache_clear()
    with TestClient(app) as c:
        yield c
    get_settings.cache_clear()


def test_health_shape_when_ollama_unreachable(client) -> None:
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {
        "status": "degraded",
        "ollama": "down",
        "model": None,
        "model_loaded": False,
        "tavily_key": False,
    }


def test_health_allows_frontend_origin(client) -> None:
    res = client.get("/api/health", headers={"Origin": "http://localhost:5173"})
    assert res.headers["access-control-allow-origin"] == "http://localhost:5173"
