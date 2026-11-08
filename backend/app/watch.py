"""Opt-in auto-ingest: new screenshots in `LATENT_WATCH_DIR` start jobs automatically (issue #20).

A `watchdog` observer watches one folder (not recursive). Each new image, created directly or
renamed into place (macOS writes screenshots under a hidden temp name, then renames them), is
waited on until its size has been stable for 500 ms, read once, and handed to the normal job
pipeline. Every started job is broadcast to `/api/watch/events` subscribers so the open UI can
follow it.

Privacy and safety: files are only ever opened for reading — never moved, edited or deleted.
The bytes live in memory only for as long as the job needs them, exactly like an upload, and
are never logged. Existing files are not imported. No network is involved.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from collections.abc import AsyncIterator
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from app import jobs
from app.config import get_settings

log = logging.getLogger(__name__)

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
MAX_IMAGE_BYTES = 10 * 1024 * 1024
# A file counts as fully written once its size and mtime are unchanged for this long.
STABLE_SECONDS = 0.5
POLL_SECONDS = 0.1
# Give up on a file that is still changing (or still empty) after this long.
GIVE_UP_SECONDS = 30.0
_MAGIC = (b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff")


def is_candidate(path: Path) -> bool:
    """An image name we accept: right suffix, not hidden, not an editor/OS temp file."""
    name = path.name
    if name.startswith((".", "~", "#")) or name.endswith("~"):
        return False
    return path.suffix.lower() in IMAGE_SUFFIXES


def _looks_like_image(head: bytes) -> bool:
    is_webp = head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    return is_webp or head.startswith(_MAGIC)


def display_dir(path: Path) -> str:
    """The folder as shown in the UI, with the home directory collapsed to `~`."""
    home = Path.home()
    try:
        rel = path.relative_to(home)
    except ValueError:
        return str(path)
    return "~" if str(rel) == "." else f"~/{rel.as_posix()}"


def configured_dir() -> Path | None:
    """The folder named by LATENT_WATCH_DIR if it is set and exists, else None."""
    raw = (get_settings().latent_watch_dir or "").strip()
    if not raw:
        return None
    path = Path(os.path.expanduser(raw)).resolve()
    if not path.is_dir():
        log.warning("LATENT_WATCH_DIR is set but is not a folder; the watcher stays off")
        return None
    return path


async def wait_until_stable(
    path: Path,
    *,
    stable_s: float = STABLE_SECONDS,
    poll_s: float = POLL_SECONDS,
    give_up_s: float = GIVE_UP_SECONDS,
) -> int | None:
    """Wait until the file's size and mtime stop changing for `stable_s`. Returns the size,
    or None if it vanished, stayed empty, grew past 10 MB or never settled."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + give_up_s
    last: tuple[int, int] | None = None
    since = loop.time()
    while loop.time() < deadline:
        try:
            st = path.stat()
        except FileNotFoundError:
            return None
        if st.st_size > MAX_IMAGE_BYTES:
            return None
        sig = (st.st_size, st.st_mtime_ns)
        now = loop.time()
        if sig != last:
            last, since = sig, now
        elif st.st_size > 0 and now - since >= stable_s:
            return st.st_size
        await asyncio.sleep(poll_s)
    return None


class Broadcaster:
    """Fan-out of new-job notices to every open `/api/watch/events` stream."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[dict]] = set()

    def publish(self, item: dict) -> None:
        for queue in list(self._subscribers):
            with contextlib.suppress(asyncio.QueueFull):  # a stuck client just misses one
                queue.put_nowait(item)

    @contextlib.asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[dict]]:
        queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=100)
        self._subscribers.add(queue)
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)


broadcaster = Broadcaster()


class _Handler(FileSystemEventHandler):
    """Runs on watchdog's thread: hand each candidate path over to the asyncio loop."""

    def __init__(self, watcher: FolderWatcher) -> None:
        self._watcher = watcher

    def on_created(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._watcher.notify(str(event.src_path))

    def on_moved(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        src = Path(str(event.src_path))
        if src.parent == self._watcher.folder and is_candidate(src):
            return  # the user renamed an image already in the folder: not a new screenshot
        self._watcher.notify(str(event.dest_path))


class FolderWatcher:
    def __init__(self, folder: Path, loop: asyncio.AbstractEventLoop) -> None:
        self.folder = folder
        self.loop = loop
        self._observer = Observer()
        self._pending: set[Path] = set()  # paths currently waiting to settle
        self._seen: set[tuple[Path, int, int]] = set()  # (path, size, mtime) already ingested
        self.started: list[dict] = []  # {job_id, filename} for every job this watcher began

    def start(self) -> None:
        self._observer.schedule(_Handler(self), str(self.folder), recursive=False)
        self._observer.daemon = True
        self._observer.start()

    def stop(self) -> None:
        self._observer.stop()
        self._observer.join(timeout=2)

    def notify(self, raw_path: str) -> None:
        """Thread-safe entry point from watchdog callbacks."""
        path = Path(raw_path)
        if path.parent != self.folder or not is_candidate(path):
            return
        try:
            future = asyncio.run_coroutine_threadsafe(self.handle(path), self.loop)
        except RuntimeError:  # loop already closed during shutdown
            return
        future.add_done_callback(_log_failure)

    async def handle(self, path: Path) -> str | None:
        """Wait for the file to settle, then start a job for it. Returns the job id."""
        if path in self._pending:
            return None
        self._pending.add(path)
        try:
            size = await wait_until_stable(path)
            if size is None:
                return None
            try:
                st = path.stat()
                key = (path, st.st_size, st.st_mtime_ns)
                if key in self._seen:
                    return None
                data = await asyncio.to_thread(_read_image, path)  # read-only
            except OSError:
                return None
            if data is None:
                return None
            self._seen.add(key)
            job = jobs.create_job()
            jobs.start_job(job, path.name, data)
            notice = {"job_id": job.job_id, "filename": path.name}
            self.started.append(notice)
            broadcaster.publish(notice)
            return job.job_id
        finally:
            self._pending.discard(path)


def _log_failure(future) -> None:
    if not future.cancelled() and future.exception() is not None:
        log.warning("folder watcher could not start a job: %s", type(future.exception()).__name__)


def _read_image(path: Path) -> bytes | None:
    with path.open("rb") as fh:  # read-only; the user's file is never modified
        data = fh.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES or not _looks_like_image(data[:12]):
        return None
    return data


_watcher: FolderWatcher | None = None


def start(loop: asyncio.AbstractEventLoop, folder: Path | None = None) -> FolderWatcher | None:
    """Start the watcher if LATENT_WATCH_DIR names an existing folder (or `folder` is given)."""
    global _watcher
    stop()
    folder = folder if folder is not None else configured_dir()
    if folder is None:
        return None
    watcher = FolderWatcher(folder, loop)
    try:
        watcher.start()
    except OSError as exc:  # e.g. inotify watch limit or no permission: stay off, keep serving
        log.warning("folder watcher could not start (%s); it stays off", type(exc).__name__)
        return None
    _watcher = watcher
    log.info("watching a folder for new screenshots")
    return watcher


def stop() -> None:
    global _watcher
    if _watcher is not None:
        _watcher.stop()
        _watcher = None


def status() -> dict:
    """The `/api/watch` body: {"enabled": bool, "dir": str | None}."""
    if _watcher is None:
        return {"enabled": False, "dir": None}
    return {"enabled": True, "dir": display_dir(_watcher.folder)}
