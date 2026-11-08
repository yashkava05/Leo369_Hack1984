"""Opt-in folder watcher (issue #20): new, size-stable screenshots start jobs; nothing else does."""

import asyncio
import json
import os
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import jobs, watch
from app.config import get_settings
from app.main import app

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 4096


@pytest.fixture
def mock_env(monkeypatch):
    monkeypatch.setenv("LATENT_MOCK", "1")
    monkeypatch.delenv("LATENT_WATCH_DIR", raising=False)
    monkeypatch.setattr(jobs, "MOCK_DELAY_RANGE", (0.01, 0.02))
    get_settings.cache_clear()
    yield monkeypatch
    watch.stop()
    get_settings.cache_clear()


async def wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.05)
    return predicate()


def snapshot(folder: Path) -> dict[str, tuple[bytes, int]]:
    return {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in folder.iterdir()}


# --- unit pieces ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "ok"),
    [
        ("Screenshot 2026-11-07 at 10.00.00.png", True),
        ("flyer.JPG", True),
        ("a.jpeg", True),
        ("b.webp", True),
        (".Screenshot 2026-11-07 at 10.00.00.png", False),  # macOS hidden temp name
        ("~$draft.png", False),
        ("photo.png~", False),
        ("notes.txt", False),
        ("clip.mov", False),
        ("image.png.crdownload", False),
    ],
)
def test_is_candidate(name, ok):
    assert watch.is_candidate(Path("/x") / name) is ok


def test_display_dir_collapses_home():
    assert watch.display_dir(Path.home() / "Desktop") == "~/Desktop"
    assert watch.display_dir(Path("/srv/shots")) == "/srv/shots"


def test_unset_env_means_no_watcher(mock_env):
    assert watch.configured_dir() is None
    loop = asyncio.new_event_loop()
    try:
        assert watch.start(loop) is None
    finally:
        loop.close()
    assert watch.status() == {"enabled": False, "dir": None}


def test_missing_folder_means_no_watcher(mock_env, tmp_path):
    mock_env.setenv("LATENT_WATCH_DIR", str(tmp_path / "nope"))
    get_settings.cache_clear()
    assert watch.configured_dir() is None


async def test_partial_write_waits_until_size_is_stable(tmp_path):
    path = tmp_path / "shot.png"
    path.write_bytes(PNG[:100])
    finished_writing = 0.0

    async def slow_writer():
        nonlocal finished_writing
        for i in range(1, 5):  # keeps growing every 200 ms for 0.8 s
            await asyncio.sleep(0.2)
            with path.open("ab") as fh:
                fh.write(PNG[100 * i : 100 * (i + 1)])
        finished_writing = time.monotonic()

    writer = asyncio.create_task(slow_writer())
    size = await watch.wait_until_stable(path)
    await writer
    assert size == 500
    assert time.monotonic() - finished_writing >= watch.STABLE_SECONDS - 0.05


async def test_oversized_or_vanished_files_are_skipped(tmp_path):
    big = tmp_path / "big.png"
    with big.open("wb") as fh:
        fh.truncate(watch.MAX_IMAGE_BYTES + 1)
    assert await watch.wait_until_stable(big) is None
    assert await watch.wait_until_stable(tmp_path / "gone.png") is None


async def test_empty_file_never_settles(tmp_path):
    empty = tmp_path / "empty.png"
    empty.touch()
    assert await watch.wait_until_stable(empty, give_up_s=1.0) is None


# --- the real observer ------------------------------------------------------------------


async def test_new_screenshot_starts_a_job_and_is_broadcast(mock_env, tmp_path):
    existing = tmp_path / "old.png"
    existing.write_bytes(PNG)
    watcher = watch.start(asyncio.get_running_loop(), folder=tmp_path)
    assert watch.status() == {"enabled": True, "dir": watch.display_dir(tmp_path)}

    async with watch.broadcaster.subscribe() as queue:
        # macOS style: write under a hidden temp name, then rename into place.
        tmp = tmp_path / ".Screenshot 1.png"
        tmp.write_bytes(PNG)
        os.rename(tmp, tmp_path / "Screenshot 1.png")
        notice = await asyncio.wait_for(queue.get(), timeout=5)

    assert notice["filename"] == "Screenshot 1.png"
    assert notice["job_id"] in jobs.JOBS
    assert watcher.started == [notice]  # the pre-existing file was not imported
    job = jobs.JOBS[notice["job_id"]]
    assert await wait_for(lambda: job.finished)


async def test_half_written_file_does_not_trigger_early(mock_env, tmp_path):
    watcher = watch.start(asyncio.get_running_loop(), folder=tmp_path)
    path = tmp_path / "flyer.png"
    with path.open("wb") as fh:
        fh.write(PNG[:10])
        fh.flush()
        for i in range(1, 6):  # still being written for ~1 s
            await asyncio.sleep(0.2)
            assert watcher.started == [], "a job started before the file finished writing"
            fh.write(PNG[10 * i : 10 * (i + 1)])
            fh.flush()
        fh.write(PNG[60:])
    assert await wait_for(lambda: len(watcher.started) == 1)
    await asyncio.sleep(0.8)
    assert len(watcher.started) == 1  # one file, one job


async def test_ignored_files_start_nothing(mock_env, tmp_path):
    watcher = watch.start(asyncio.get_running_loop(), folder=tmp_path)
    (tmp_path / "notes.txt").write_text("hello")
    (tmp_path / ".hidden.png").write_bytes(PNG)
    (tmp_path / "fake.png").write_bytes(b"not really an image" * 10)
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "nested.png").write_bytes(PNG)
    await asyncio.sleep(1.2)
    assert watcher.started == []


async def test_renaming_an_existing_image_is_not_a_new_screenshot(mock_env, tmp_path):
    (tmp_path / "Screenshot old.png").write_bytes(PNG)
    watcher = watch.start(asyncio.get_running_loop(), folder=tmp_path)
    os.rename(tmp_path / "Screenshot old.png", tmp_path / "flyer.png")
    await asyncio.sleep(1.2)
    assert watcher.started == []


def test_observer_failure_leaves_watcher_off(mock_env, tmp_path, monkeypatch):
    def boom(self):
        raise OSError("inotify watch limit reached")

    monkeypatch.setattr(watch.FolderWatcher, "start", boom)
    loop = asyncio.new_event_loop()
    try:
        assert watch.start(loop, folder=tmp_path) is None
    finally:
        loop.close()
    assert watch.status() == {"enabled": False, "dir": None}


async def test_files_are_never_modified_moved_or_deleted(mock_env, tmp_path):
    watcher = watch.start(asyncio.get_running_loop(), folder=tmp_path)
    (tmp_path / "a.png").write_bytes(PNG)
    (tmp_path / "b.jpg").write_bytes(b"\xff\xd8\xff" + b"\x01" * 2048)
    before = snapshot(tmp_path)
    assert await wait_for(lambda: len(watcher.started) == 2)
    for notice in watcher.started:
        await wait_for(lambda n=notice: jobs.JOBS[n["job_id"]].finished)
    assert snapshot(tmp_path) == before


# --- HTTP surface through the real lifespan ---------------------------------------------


def test_routes_report_disabled_when_unset(mock_env):
    with TestClient(app) as client:
        assert client.get("/api/watch").json() == {"enabled": False, "dir": None}


def test_lifespan_starts_watcher_and_streams_new_jobs(mock_env, tmp_path):
    mock_env.setenv("LATENT_WATCH_DIR", str(tmp_path))
    get_settings.cache_clear()
    with TestClient(app) as client:
        assert client.get("/api/watch").json() == {
            "enabled": True,
            "dir": watch.display_dir(tmp_path.resolve()),
        }

        def drop_screenshot():
            deadline = time.monotonic() + 5
            while watch.broadcaster.subscriber_count == 0 and time.monotonic() < deadline:
                time.sleep(0.02)
            (tmp_path / "poster.png").write_bytes(PNG)

        threading.Thread(target=drop_screenshot, daemon=True).start()
        notice = None
        with client.stream("GET", "/api/watch/events") as resp:
            assert resp.headers["content-type"].startswith("text/event-stream")
            name = None
            for line in resp.iter_lines():
                if line.startswith("event:"):
                    name = line.split(":", 1)[1].strip()
                elif line.startswith("data:") and name == "job":
                    notice = json.loads(line.split(":", 1)[1])
                    break
        assert notice["filename"] == "poster.png"
        assert client.get(f"/api/jobs/{notice['job_id']}").status_code == 200
    assert watch.status() == {"enabled": False, "dir": None}  # stopped on shutdown
