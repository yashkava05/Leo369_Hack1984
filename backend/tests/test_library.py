"""Local intent library (issue #21): save, FTS search, reopen, delete, wipe, thumbnails.

The DB lives in a per-test tmp file (see conftest.py), never the real ~/.latent.
"""

import io
import os
import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import egress, jobs, library
from app.config import get_settings
from app.main import app
from app.models import JobResult
from app.pipeline import runner
from app.pipeline import scrub as scrub_mod

CONCERT_FIXTURE = jobs.FIXTURES_DIR / "concert_flyer.result.json"


def concert(job_id: str = "j_concert01") -> JobResult:
    result = JobResult.model_validate_json(CONCERT_FIXTURE.read_text())
    return result.model_copy(update={"job_id": job_id})


def product(job_id: str = "j_product01") -> JobResult:
    return JobResult.model_validate(
        {
            "job_id": job_id,
            "status": "done",
            "intent": {
                "intent_type": "product",
                "summary": "Wireless headphones from Sonora Audio",
                "public_entities": [
                    {"type": "product", "value": "Aurora X2 Headphones"},
                    {"type": "brand", "value": "Sonora Audio"},
                ],
                "redaction_counts": {},
                "confidence": 0.8,
            },
            "cards": [],
            "egress": [],
        }
    )


def rows(sql: str, params=()) -> list[tuple]:
    conn = sqlite3.connect(library.db_path())
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def png_bytes(size=(800, 600)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(out, format="PNG")
    return out.getvalue()


# --- store ------------------------------------------------------------------------


def test_db_created_with_schema_and_wal():
    path = library.init_db()
    assert path.exists() and path.name == "latent.db"
    tables = {r[0] for r in rows("SELECT name FROM sqlite_master")}
    assert {"intents", "intents_fts"} <= tables
    assert rows("PRAGMA journal_mode")[0][0] == "wal"


def test_default_path_is_home_latent(monkeypatch):
    monkeypatch.setenv("LATENT_DB_PATH", "")
    get_settings.cache_clear()
    assert library.db_path() == library.Path.home() / ".latent" / "latent.db"


def test_save_stores_scrubbed_result_without_egress():
    result = concert()
    assert result.egress, "fixture should carry egress records"
    assert library.save(result)

    (row,) = rows("SELECT id, intent_type, summary, result_json, thumb FROM intents")
    assert row[0] == "j_concert01"
    assert row[1] == "event"
    assert row[2] == result.intent.summary
    assert '"egress":[]' in row[3]
    assert "api.tavily.com" not in row[3]
    assert row[4] is None

    reopened = library.get("j_concert01")
    assert reopened == result.model_copy(update={"egress": []})
    assert reopened.cards == result.cards


def test_error_or_running_jobs_are_not_saved():
    failed = JobResult(job_id="j_err", status="error", error="extraction failed")
    running = JobResult(job_id="j_run", status="running")
    assert not library.save(failed)
    assert not library.save(running)
    assert library.search() == []


def test_list_newest_first_with_card_count():
    library.save(concert("j_old"))
    library.save(product("j_new"))
    items = library.search()
    assert [i.id for i in items] == ["j_new", "j_old"]
    assert items[1].card_count == len(concert().cards)
    assert items[0].card_count == 0


def test_search_by_performer_and_product_name():
    library.save(concert())
    library.save(product())
    performer = concert().intent.public_entities[0].value  # e.g. "Tame Impala"

    found = library.search(performer)
    assert [i.id for i in found] == ["j_concert01"]
    # Prefix match on a product name, case-insensitive.
    assert [i.id for i in library.search("auro")] == ["j_product01"]
    assert [i.id for i in library.search("SONORA")] == ["j_product01"]
    assert library.search("nonexistentword") == []


def test_type_filter():
    library.save(concert())
    library.save(product())
    assert [i.id for i in library.search(intent_type="product")] == ["j_product01"]
    assert [i.id for i in library.search("sonora", "event")] == []


def test_resave_replaces_row_and_fts():
    library.save(concert("j_same"))
    library.save(product("j_same"))
    assert len(rows("SELECT * FROM intents")) == 1
    assert len(rows("SELECT * FROM intents_fts")) == 1
    assert library.search(concert().intent.public_entities[0].value) == []


@pytest.mark.parametrize(
    "q",
    [
        "'; DROP TABLE intents; --",
        '"',
        "NEAR(",
        "*",
        "summary:x OR 1=1",
        "AND OR NOT",
        "%",
    ],
)
def test_hostile_search_input_is_inert(q):
    library.save(concert())
    library.search(q)  # must not raise
    assert len(rows("SELECT * FROM intents")) == 1


def test_fts_query_quotes_every_word():
    assert library.fts_query('tame "impala') == '"tame"* "impala"*'
    assert library.fts_query("  ;; ") is None


def test_delete_one_removes_row_and_fts():
    library.save(concert())
    library.save(product())
    assert library.delete("j_concert01")
    assert library.get("j_concert01") is None
    assert rows("SELECT id FROM intents_fts") == [("j_product01",)]
    assert not library.delete("j_concert01")


MARKER = "Qzxvmarkerqzxv"


def stored_bytes() -> bytes:
    """Every byte the library keeps on disk: the DB file and any WAL/SHM sidecars."""
    path = library.db_path()
    return b"".join(f.read_bytes() for f in path.parent.glob(path.name + "*"))


def marked(job_id: str) -> JobResult:
    result = concert(job_id)
    intent = result.intent.model_copy(update={"summary": f"{MARKER} live at The Echo Lounge"})
    return result.model_copy(update={"intent": intent})


def assert_marker_gone():
    data = stored_bytes()
    # FTS5 stores tokens lowercased; the content row keeps the original casing.
    assert MARKER.encode() not in data
    assert MARKER.lower().encode() not in data


def test_delete_leaves_no_text_in_stored_bytes():
    library.save(marked("j_marked01"))
    library.save(product())
    assert MARKER.lower().encode() in stored_bytes()  # the check below can see it
    assert library.delete("j_marked01")
    assert library.search(MARKER) == []
    assert_marker_gone()
    assert [i.id for i in library.search("Sonora")] == ["j_product01"]


def test_delete_without_fts_secure_delete_rebuilds_index():
    library.init_db()
    conn = sqlite3.connect(library.db_path())
    conn.execute("INSERT INTO intents_fts (intents_fts, rank) VALUES ('secure-delete', 0)")
    conn.commit()
    conn.close()
    library.save(marked("j_marked01"))
    library.save(product())
    assert library.delete("j_marked01")
    assert_marker_gone()
    assert [i.id for i in library.search("Sonora")] == ["j_product01"]


def test_resave_leaves_no_old_text_in_stored_bytes():
    library.save(marked("j_marked01"))
    library.save(concert("j_marked01"))
    assert library.search(MARKER) == []
    assert_marker_gone()


def mode(p) -> int:
    return p.stat().st_mode & 0o777


def test_library_files_are_private(tmp_path_factory, monkeypatch):
    old = os.umask(0o022)
    try:
        path = tmp_path_factory.mktemp("private") / "nested" / "lib" / "latent.db"
        monkeypatch.setenv("LATENT_DB_PATH", str(path))
        get_settings.cache_clear()
        conn = None
        library.save(concert())
        conn = sqlite3.connect(path)  # hold a connection so the WAL/SHM sidecars stay on disk
        conn.execute("INSERT INTO intents_fts (intents_fts) VALUES ('optimize')")
        conn.commit()
        assert mode(path.parent) == 0o700
        assert mode(path.parent.parent) == 0o700
        sidecars = [path.with_name("latent.db-wal"), path.with_name("latent.db-shm")]
        assert all(p.exists() for p in sidecars)
        for p in (path, *sidecars):
            assert mode(p) == 0o600, p
    finally:
        if conn is not None:
            conn.close()
        os.umask(old)


def test_existing_world_readable_db_is_tightened(tmp_path_factory, monkeypatch):
    path = tmp_path_factory.mktemp("legacy") / "latent.db"
    sqlite3.connect(path).close()
    path.chmod(0o644)
    parent_mode = mode(path.parent)
    monkeypatch.setenv("LATENT_DB_PATH", str(path))
    get_settings.cache_clear()
    library.init_db()
    assert mode(path) == 0o600
    assert mode(path.parent) == parent_mode  # a parent the user chose is not changed


def test_wipe_removes_everything():
    library.save(concert())
    library.save(product())
    library.wipe()
    assert rows("SELECT count(*) FROM intents") == [(0,)]
    assert rows("SELECT count(*) FROM intents_fts") == [(0,)]
    assert library.search() == []


# --- thumbnails -------------------------------------------------------------------


def test_no_thumbnail_unless_opted_in():
    thumb = library.make_thumb(png_bytes())
    library.save(concert(), thumb)
    assert rows("SELECT thumb FROM intents") == [(None,)]


def test_thumbnail_stored_when_keep_thumbs(monkeypatch):
    monkeypatch.setenv("LATENT_KEEP_THUMBS", "1")
    get_settings.cache_clear()
    thumb = library.make_thumb(png_bytes())
    library.save(concert(), thumb)
    (blob,) = rows("SELECT thumb FROM intents")[0]
    with Image.open(io.BytesIO(blob)) as img:
        assert img.format == "JPEG"
        assert max(img.size) <= library.THUMB_PX


def test_make_thumb_on_garbage_is_none():
    assert library.make_thumb(b"not an image") is None


# --- HTTP ---------------------------------------------------------------------------


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("LATENT_MOCK", "1")
    get_settings.cache_clear()
    monkeypatch.setattr(jobs, "MOCK_DELAY_RANGE", (0.01, 0.02))
    with TestClient(app) as c:
        yield c


def test_routes_list_get_delete_wipe(client):
    library.save(concert())
    library.save(product())

    listed = client.get("/api/library").json()
    assert [i["id"] for i in listed] == ["j_product01", "j_concert01"]
    assert set(listed[0]) == {"id", "created_at", "intent_type", "summary", "card_count"}

    performer = concert().intent.public_entities[0].value
    assert [i["id"] for i in client.get("/api/library", params={"q": performer}).json()] == [
        "j_concert01"
    ]
    assert [i["id"] for i in client.get("/api/library?type=product").json()] == ["j_product01"]
    assert len(client.get("/api/library?limit=1").json()) == 1
    assert client.get("/api/library?type=nope").status_code == 422

    got = client.get("/api/library/j_concert01")
    assert got.status_code == 200
    assert JobResult.model_validate(got.json()).cards == concert().cards
    assert client.get("/api/library/j_missing").status_code == 404

    assert client.delete("/api/library/j_concert01").status_code == 204
    assert client.get("/api/library/j_concert01").status_code == 404

    assert client.delete("/api/library").status_code == 204
    assert client.get("/api/library").json() == []


def test_mock_job_is_saved_to_library(client):
    resp = client.post("/api/analyze", files={"image": ("flyer.png", png_bytes(), "image/png")})
    job_id = resp.json()["job_id"]
    with client.stream("GET", f"/api/jobs/{job_id}/events") as stream:
        for _ in stream.iter_lines():
            pass
    item = client.get(f"/api/library/{job_id}").json()
    assert item["job_id"] == job_id and item["egress"] == []
    assert item["cards"] == client.get(f"/api/jobs/{job_id}").json()["cards"]


# --- runner -------------------------------------------------------------------------


async def test_real_runner_saves_finished_job(monkeypatch):
    intent = concert().intent

    async def fake_extract(image_bytes, emit):
        await emit("extract", "ok", "intent: event")
        return intent

    def tavily_response(request):
        return httpx.Response(200, json={"query": "q", "results": []})

    monkeypatch.setenv("LATENT_MOCK", "0")
    monkeypatch.setenv("OLLAMA_HOST", "http://127.0.0.1:11434")
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-testkey0123456789")
    get_settings.cache_clear()
    scrub_mod.warm_up()
    egress.set_offline(None)
    monkeypatch.setattr(
        egress, "_internet", httpx.AsyncClient(transport=httpx.MockTransport(tavily_response))
    )
    monkeypatch.setattr(runner, "extract_intent", fake_extract)

    job = jobs.create_job()
    await runner.run_job(job.job_id, png_bytes(), "concert.png")
    assert job.result.status == "done"

    saved = library.get(job.job_id)
    assert saved is not None
    assert saved.cards == job.result.cards and saved.egress == []
    assert [i.id for i in library.search(intent.public_entities[0].value)] == [job.job_id]
    assert rows("SELECT thumb FROM intents") == [(None,)]
