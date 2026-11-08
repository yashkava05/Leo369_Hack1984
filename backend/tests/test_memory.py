"""Phase 1 regressions use only temporary databases and fabricated public data."""

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest

from app import jobs, library
from app.main import app
from app.models import Intent, JobResult


def result():
    return JobResult(
        job_id="j_sample",
        status="done",
        intent=Intent(
            intent_type="event",
            summary="Lumen Festival",
            public_entities=[],
            redaction_counts={},
            confidence=1,
        ),
        cards=[],
        egress=[],
    )


def saved(item_id="sample"):
    return library.SavedItem(
        id=item_id,
        created_at=1,
        updated_at=1,
        label="Lumen Festival",
        intent_type="event",
        cards=[],
    )


def test_legacy_schema_migration_preserves_history_and_is_idempotent():
    path = library.db_path()
    path.parent.mkdir(exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.executescript(library.SCHEMA)
        conn.execute(
            "INSERT INTO intents VALUES (?, ?, ?, ?, ?, NULL)",
            ("j_sample", 1, "event", "Lumen Festival", result().model_dump_json()),
        )
        conn.execute(
            "INSERT INTO intents_fts VALUES (?, ?, ?)", ("j_sample", "Lumen Festival", "Lumen")
        )
    library.init_db()
    library._initialized.discard(path)
    library.init_db()
    assert library.get("j_sample") == result()
    assert len(library.search("Lumen")) == 1
    assert library.list_saved_items() == (0, [])
    with sqlite3.connect(path) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 1


def test_phase1_migration_rolls_back_schema_and_version_on_failure():
    with sqlite3.connect(":memory:") as conn:

        def deny_version(action, name, value, *_):
            return (
                sqlite3.SQLITE_DENY
                if action == sqlite3.SQLITE_PRAGMA and name == "user_version" and value
                else sqlite3.SQLITE_OK
            )

        conn.set_authorizer(deny_version)
        with pytest.raises(sqlite3.DatabaseError):
            library._migrate_phase1(conn)
        conn.rollback()
        conn.set_authorizer(None)
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
        assert (
            conn.execute("SELECT name FROM sqlite_master WHERE name = 'saved_items'").fetchone()
            is None
        )


def test_import_is_idempotent_and_individual_delete_cannot_be_replayed():
    assert library.import_saved_items([saved()], client_epoch=None)[1][0]["status"] == "saved"
    assert library.import_saved_items([saved()], client_epoch=0)[1][0]["status"] == "exists"
    library.delete_saved_item("sample", client_epoch=0)
    assert library.import_saved_items([saved()], client_epoch=0)[1][0]["status"] == "tombstoned"
    assert library.list_saved_items()[1] == []


def test_reset_fence_survives_reopen_and_rejects_legacy_and_old_tabs():
    library.import_saved_items([saved()], client_epoch=None)
    assert library.delete_all_local_data(confirm="DELETE_ALL_LOCAL_DATA") == (True, 1)
    library._initialized.discard(library.db_path())
    for epoch in (None, 0):
        assert library.import_saved_items([saved()], client_epoch=epoch)[2]
    assert library.list_saved_items() == (1, [])
    assert not library.import_saved_items([saved("new")], client_epoch=1)[2]


def test_history_wipe_preserves_durable_saved_snapshots_and_invalidates_jobs():
    library.save(result())
    library.import_saved_items([saved()], client_epoch=0)
    generation = library.current_generation()
    library.wipe()
    assert library.search() == []
    assert library.list_saved_items()[1] == [
        saved().model_copy(update={"updated_at": library.list_saved_items()[1][0].updated_at})
    ]
    assert not library.save(result(), expected_generation=generation)


@pytest.mark.parametrize("operation", ["import", "save", "pin", "delete"])
def test_reset_serializes_with_epoch_check_and_write(monkeypatch, operation):
    library.import_saved_items([saved()], client_epoch=0)
    checked, release, resetting = threading.Event(), threading.Event(), threading.Event()
    original = library._read_state

    def pause(conn):
        state = original(conn)
        if threading.current_thread().name.startswith("writer"):
            checked.set()
            assert release.wait(5)
        return state

    monkeypatch.setattr(library, "_read_state", pause)

    def write():
        if operation == "import":
            return library.import_saved_items([saved("second")], client_epoch=0)
        if operation == "save":
            return library.save(result(), expected_generation=0)
        if operation == "pin":
            return library.set_saved_item_pin("sample", pinned=True, client_epoch=0)
        return library.delete_saved_item("sample", client_epoch=0)

    def reset():
        resetting.set()
        return library.delete_all_local_data(confirm="DELETE_ALL_LOCAL_DATA")

    with (
        ThreadPoolExecutor(1, thread_name_prefix="writer") as writer,
        ThreadPoolExecutor(1) as resetter,
    ):
        pending_write = writer.submit(write)
        assert checked.wait(5)
        pending_reset = resetter.submit(reset)
        assert resetting.wait(5)
        # The epoch-check connection owns SQLite's writer lock until its write commits.
        with sqlite3.connect(library.db_path(), timeout=0) as probe:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                probe.execute("BEGIN IMMEDIATE")
        release.set()
        pending_write.result(5)
        assert pending_reset.result(5) == (True, 1)
    assert library.list_saved_items() == (1, [])
    assert library.search() == []


def test_import_rolls_back_entire_batch_on_storage_error(monkeypatch):
    library.init_db()
    with sqlite3.connect(library.db_path()) as conn:
        conn.execute(
            "CREATE TRIGGER fail_second BEFORE INSERT ON saved_items"
            " WHEN NEW.id = 'bad' BEGIN SELECT RAISE(ABORT, 'test failure'); END"
        )
    with pytest.raises(sqlite3.IntegrityError):
        library.import_saved_items([saved("good"), saved("bad")], client_epoch=0)
    assert library.list_saved_items()[1] == []


async def test_mock_job_created_before_reset_does_not_restore_history(monkeypatch):
    monkeypatch.setattr(jobs, "MOCK_DELAY_RANGE", (0, 0))
    job = jobs.create_job()
    library.delete_all_local_data(confirm="DELETE_ALL_LOCAL_DATA")
    await jobs.run_mock(job, "concert_flyer")
    assert job.result.status == "done"
    assert library.get(job.job_id) is None
    jobs.JOBS.pop(job.job_id, None)


async def test_real_pipeline_paused_before_save_cannot_restore_history(monkeypatch):
    from types import SimpleNamespace

    from app.pipeline import runner

    job = jobs.create_job()

    async def extract(*_):
        library.delete_all_local_data(confirm="DELETE_ALL_LOCAL_DATA")
        return result().intent

    async def search(*_):
        return {}

    monkeypatch.setattr(runner, "_verify_image", lambda _: ("PNG", 0))
    monkeypatch.setattr(runner, "extract_intent", extract)
    monkeypatch.setattr(
        runner, "scrub_intent", lambda intent: (intent, SimpleNamespace(removed={}, kept=0))
    )
    monkeypatch.setattr(runner.search_mod, "search", search)
    await runner.run_job(job.job_id, b"in-memory-placeholder", "sample.png")
    assert job.result.status == "done"
    assert library.get(job.job_id) is None
    jobs.JOBS.pop(job.job_id, None)


def test_storage_unavailable_at_job_creation_fails_closed(monkeypatch):
    def unavailable():
        raise sqlite3.OperationalError("test failure")

    monkeypatch.setattr(library, "current_generation", unavailable)
    job = jobs.create_job()
    assert job.memory_generation == -1
    assert not library.save(result(), expected_generation=job.memory_generation)
    jobs.JOBS.pop(job.job_id, None)


async def test_saved_api_validation_and_confirmed_reset():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        body = {
            "memory_epoch": 0,
            "items": [
                {
                    "id": "sample",
                    "label": "Lumen Festival",
                    "intent_type": "event",
                    "saved_at": 1,
                    "cards": [],
                }
            ],
        }
        assert (await client.post("/api/saved/import", json=body)).status_code == 200
        assert (await client.get("/api/saved")).json()["items"][0]["id"] == "sample"
        assert (await client.delete("/api/memory")).status_code == 400
        assert (await client.delete("/api/memory?confirm=DELETE_ALL_LOCAL_DATA")).status_code == 200
        assert (await client.post("/api/saved/import", json=body)).status_code == 409
        body["items"][0]["cards"] = [{"private_transcript": "fabricated private value"}]
        assert (await client.post("/api/saved/import", json=body)).status_code == 422
