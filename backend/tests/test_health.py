from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_returns_static_body() -> None:
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "ollama": "unchecked", "model": None, "tavily_key": False}


def test_health_allows_frontend_origin() -> None:
    res = client.get("/api/health", headers={"Origin": "http://localhost:5173"})
    assert res.headers["access-control-allow-origin"] == "http://localhost:5173"
