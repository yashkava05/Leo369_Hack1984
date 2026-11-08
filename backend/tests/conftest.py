"""Shared test setup: keep the local intent library (issue #21) out of the real ~/.latent."""

import pytest

from app.config import get_settings


@pytest.fixture(autouse=True)
def _isolated_library_db(tmp_path, monkeypatch):
    monkeypatch.setenv("LATENT_DB_PATH", str(tmp_path / "latent.db"))
    monkeypatch.setenv("LATENT_KEEP_THUMBS", "0")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
