import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app


@pytest.fixture
def mock_flag(monkeypatch):
    def set_mock(value: str) -> TestClient:
        monkeypatch.setenv("LATENT_MOCK", value)
        get_settings.cache_clear()
        return TestClient(app)

    yield set_mock
    get_settings.cache_clear()


def test_mode_reports_mock(mock_flag) -> None:
    client = mock_flag("1")
    assert client.get("/api/mode").json() == {"mock": True}


def test_mode_reports_real(mock_flag) -> None:
    # No `with` block: the lifespan (model warm-up) does not run, so nothing is contacted.
    client = mock_flag("0")
    assert client.get("/api/mode").json() == {"mock": False}
