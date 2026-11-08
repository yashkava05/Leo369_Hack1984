"""Phase 1 regressions use only temporary databases and fabricated public data."""

import asyncio
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
        cards=[
            {
                "id": "sample-card",
                "kind": "link",
                "title": "Lumen Festival",
                "source": "example.test",
                "url": "https://example.test/festival",
            }
        ],
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


async def test_reset_cancels_old_jobs_but_keeps_jobs_created_after_the_reset(monkeypatch):
    old_job = jobs.create_job()
    old_job.task = asyncio.create_task(asyncio.Event().wait())
    reset = library.delete_all_local_data
    created = []

    def reset_then_create(**kwargs):
        response = reset(**kwargs)
        created.append(jobs.create_job())
        return response

    monkeypatch.setattr(library, "delete_all_local_data", reset_then_create)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.delete("/api/memory?confirm=DELETE_ALL_LOCAL_DATA")
    assert response.status_code == 200
    assert old_job.task.cancelled()
    assert old_job.job_id not in jobs.JOBS
    assert created[0].job_id in jobs.JOBS
    jobs.JOBS.pop(created[0].job_id)


def test_tombstones_are_pruned_after_ttl_but_recent_ones_still_block_reimport():
    library.import_saved_items([saved("old"), saved("recent")], client_epoch=None)
    library.delete_saved_item("old", client_epoch=0)
    library.delete_saved_item("recent", client_epoch=0)
    with library._connect() as conn:
        conn.execute(
            "UPDATE saved_item_tombstones SET deleted_at = ? WHERE id = 'old'",
            (library.time.time() - library.TOMBSTONE_TTL_S - 60,),
        )
    # Compaction must invalidate even very old offline imports before dropping markers.
    epoch, statuses, stale = library.import_saved_items(
        [saved("old"), saved("recent")], client_epoch=0
    )
    assert (epoch, statuses, stale) == (1, [], True)
    assert library.list_saved_items() == (1, [])
    assert library.import_saved_items([saved("old")], client_epoch=None)[2]
    # A current client still cannot replay the retained recent tombstone.
    assert library.import_saved_items([saved("recent")], client_epoch=1)[1] == [
        {"id": "recent", "status": "tombstoned"}
    ]
    with library._connect() as conn:
        ids = {r[0] for r in conn.execute("SELECT id FROM saved_item_tombstones")}
    assert ids == {"recent"}


async def test_import_rejects_oversized_batches_and_card_lists():
    from app.routes.memory import MAX_CARDS_PER_ITEM, MAX_IMPORT_ITEMS

    card = {"id": "c1", "kind": "link", "title": "Lumen Festival", "source": "example.com"}

    def item(i, cards):
        return {
            "id": f"i{i}",
            "label": "Lumen Festival",
            "intent_type": "event",
            "saved_at": 1,
            "cards": cards,
        }

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        too_many_cards = {"memory_epoch": 0, "items": [item(0, [card] * (MAX_CARDS_PER_ITEM + 1))]}
        assert (await client.post("/api/saved/import", json=too_many_cards)).status_code == 422
        too_many_items = {
            "memory_epoch": 0,
            "items": [item(i, []) for i in range(MAX_IMPORT_ITEMS + 1)],
        }
        assert (await client.post("/api/saved/import", json=too_many_items)).status_code == 422
        ok = {"memory_epoch": 0, "items": [item(0, [card] * MAX_CARDS_PER_ITEM)]}
        assert (await client.post("/api/saved/import", json=ok)).status_code == 200
    (only,) = library.list_saved_items()[1]
    assert only.id == "i0" and len(only.cards) == MAX_CARDS_PER_ITEM


async def test_delete_all_clears_muse_items_feedback_and_suppressions(monkeypatch):
    from app import feed
    from app.config import get_settings

    monkeypatch.setenv("LATENT_MOCK", "1")
    get_settings.cache_clear()
    library.save(result())
    library.import_saved_items([saved()], client_epoch=0)
    await feed.refresh()
    items = feed.list_items().items
    assert items
    assert feed.feedback(items[0].id, "less_like_this")
    with feed._connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM feed_suppressions").fetchone()[0] > 0
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        assert (await client.delete("/api/memory?confirm=DELETE_ALL_LOCAL_DATA")).status_code == 200
        assert (await client.get("/api/feed")).json()["items"] == []
    with feed._connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM feed_items").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM feed_suppressions").fetchone()[0] == 0
    assert library.search() == []
    assert library.list_saved_items() == (1, [])


async def test_reset_is_atomic_when_clearing_feed_fails(monkeypatch):
    from app import feed
    from app.config import get_settings

    monkeypatch.setenv("LATENT_MOCK", "1")
    get_settings.cache_clear()
    library.save(result())
    library.import_saved_items([saved()], client_epoch=0)
    await feed.refresh()
    item_id = feed.list_items().items[0].id
    feed.feedback(item_id, "less_like_this")
    with feed._connect() as conn:
        conn.execute(
            "CREATE TRIGGER fail_reset BEFORE DELETE ON feed_suppressions"
            " BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END"
        )
    with pytest.raises(sqlite3.IntegrityError):
        library.delete_all_local_data(confirm="DELETE_ALL_LOCAL_DATA")
    assert library.current_generation() == 0
    assert library.current_memory_epoch() == 0
    assert library.get(result().job_id) is not None
    assert len(library.list_saved_items()[1]) == 1
    with feed._connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM feed_items").fetchone()[0] > 0
        assert conn.execute("SELECT COUNT(*) FROM feed_suppressions").fetchone()[0] > 0


async def test_feed_refresh_started_before_reset_cannot_restore_deleted_memories(monkeypatch):
    from app import feed
    from app.config import get_settings

    monkeypatch.setenv("LATENT_MOCK", "0")
    get_settings.cache_clear()
    started, release = asyncio.Event(), asyncio.Event()

    async def paused_discovery(_records):
        started.set()
        await release.wait()
        return feed._mock_candidates()

    monkeypatch.setattr(feed, "_discovery_candidates", paused_discovery)
    task = asyncio.create_task(feed.refresh())
    await asyncio.wait_for(started.wait(), timeout=5)
    library.delete_all_local_data(confirm="DELETE_ALL_LOCAL_DATA")
    release.set()
    await task
    assert feed.list_items().items == []


@pytest.mark.parametrize("action", ["save", "explore"])
async def test_merged_voice_save_paths_keep_job_generation_fence(monkeypatch, action):
    from app.pipeline import voice_runner

    monkeypatch.setattr(jobs, "MOCK_DELAY_RANGE", (0, 0))
    job = jobs.create_job()
    library.delete_all_local_data(confirm="DELETE_ALL_LOCAL_DATA")
    await voice_runner._mock_voice(job, action, None)
    assert library.get(job.job_id) is None
    if action == "save":
        assert job.result.error == "local_save_unavailable"
    jobs.JOBS.pop(job.job_id, None)


def test_feed_feedback_serializes_with_delete_all(monkeypatch):
    from contextlib import contextmanager

    from app import feed

    feed._replace(feed._mock_candidates(), expected_generation=0)
    item_id = feed.list_items().items[0].id
    reading, release = threading.Event(), threading.Event()
    connect = feed._connect

    @contextmanager
    def paused_connect():
        with connect() as conn:

            def trace(statement):
                if (
                    threading.current_thread().name.startswith("feedback")
                    and "SELECT topic_keys_json" in statement
                ):
                    reading.set()
                    assert release.wait(5)

            conn.set_trace_callback(trace)
            yield conn

    monkeypatch.setattr(feed, "_connect", paused_connect)
    with (
        ThreadPoolExecutor(1, thread_name_prefix="feedback") as feedback_writer,
        ThreadPoolExecutor(1) as resetter,
    ):
        feedback = feedback_writer.submit(feed.feedback, item_id, "less_like_this")
        assert reading.wait(5)
        reset = resetter.submit(library.delete_all_local_data, confirm="DELETE_ALL_LOCAL_DATA")
        with sqlite3.connect(library.db_path(), timeout=0) as probe:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                probe.execute("BEGIN IMMEDIATE")
        release.set()
        assert feedback.result(5)
        assert reset.result(5) == (True, 1)
    assert feed.list_items().items == []
    with connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM feed_suppressions").fetchone()[0] == 0
    assert not feed.feedback(item_id, "less_like_this")
