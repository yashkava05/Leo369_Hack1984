"""Shared test setup: keep the local intent library (issue #21) out of the real ~/.latent."""

import pytest

from app.config import get_settings


@pytest.fixture(autouse=True)
def _isolated_library_db(tmp_path_factory, monkeypatch):
    # Own directory, not tmp_path: tests that watch or list tmp_path must not see the DB file.
    db_dir = tmp_path_factory.mktemp("library")
    monkeypatch.setenv("LATENT_DB_PATH", str(db_dir / "latent.db"))
    monkeypatch.setenv("LATENT_KEEP_THUMBS", "0")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
