"""Local intent library (issue #21): finished jobs saved to SQLite with FTS5 search.

Everything lives in one file on this machine, `~/.latent/latent.db` by default
(`LATENT_DB_PATH` overrides it). Nothing here touches the network.

Only scrubbed data is stored: the `JobResult` from the `done` event (its intent was already
scrubbed by `scrub.py`) with the `egress` records removed, plus an FTS row holding the scrubbed
summary and the public entity values. A 256 px JPEG thumbnail is stored only when
`LATENT_KEEP_THUMBS=1`; otherwise `thumb` stays NULL and no pixels are ever written.

Every query takes user input as a bound `?` parameter; no SQL is built from user strings.
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from PIL import Image
from pydantic import BaseModel, ConfigDict

from app.config import get_settings
from app.models import IntentType, JobResult

log = logging.getLogger(__name__)

THUMB_PX = 256
DEFAULT_LIMIT = 50
MAX_LIMIT = 200

SCHEMA = """
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,            -- job_id
  created_at REAL NOT NULL,
  intent_type TEXT NOT NULL,
  summary TEXT NOT NULL,          -- already scrubbed
  result_json TEXT NOT NULL,      -- JobResult without egress records
  thumb BLOB                      -- 256 px JPEG, only if LATENT_KEEP_THUMBS=1
);
CREATE VIRTUAL TABLE IF NOT EXISTS intents_fts USING fts5(id UNINDEXED, summary, entities);
CREATE INDEX IF NOT EXISTS intents_created_at ON intents (created_at DESC);
"""


class LibraryItem(BaseModel):
    """One row of `GET /api/library`."""

    model_config = ConfigDict(extra="forbid")

    id: str
    created_at: float
    intent_type: IntentType
    summary: str
    card_count: int


class LibraryRecord(BaseModel):
    """A scrubbed saved result with its library timestamp, for local derived features."""

    model_config = ConfigDict(extra="forbid")

    created_at: float
    result: JobResult


_init_lock = threading.Lock()
_initialized: set[Path] = set()


def db_path() -> Path:
    configured = get_settings().latent_db_path.strip()
    return Path(configured).expanduser() if configured else Path.home() / ".latent" / "latent.db"


def keep_thumbs() -> bool:
    return get_settings().latent_keep_thumbs


def _make_private(path: Path) -> None:
    """Create the library folder (0700) and DB file (0600) so other local users can't read them.

    Folders this creates, and the default `~/.latent`, are set to 0700; an existing parent
    chosen through `LATENT_DB_PATH` is left alone. SQLite gives its `-wal` and `-shm` sidecars
    the DB file's own mode, so they are 0600 too.
    """
    parent = path.parent
    missing = [d for d in (parent, *parent.parents) if not d.exists()]
    for d in reversed(missing):
        d.mkdir(mode=0o700, exist_ok=True)
        d.chmod(0o700)  # mkdir's mode is narrowed by the umask but never widened; be exact
    if parent == Path.home() / ".latent":
        parent.chmod(0o700)
    os.close(os.open(path, os.O_CREAT | os.O_WRONLY, 0o600))
    for f in (path, path.with_name(path.name + "-wal"), path.with_name(path.name + "-shm")):
        if f.exists():  # also tightens files left 0644 by an older version
            f.chmod(0o600)


def _enable_fts_secure_delete(conn: sqlite3.Connection) -> None:
    """Make FTS5 remove a deleted row's terms from the index (SQLite >= 3.42).

    Without it FTS5 only appends a delete marker and the old terms stay in the stored segments.
    On an older SQLite, `delete` falls back to rebuilding the index instead.
    """
    try:
        conn.execute("INSERT INTO intents_fts (intents_fts, rank) VALUES ('secure-delete', 1)")
    except sqlite3.OperationalError:
        log.info("FTS5 secure-delete unsupported; deletes rebuild the index instead")


def init_db() -> Path:
    """Create the folder, the database and the schema (WAL mode). Safe to call repeatedly."""
    path = db_path()
    with _init_lock:
        if path in _initialized and path.exists():
            return path
        _make_private(path)
        conn = sqlite3.connect(path)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SCHEMA)
            _enable_fts_secure_delete(conn)
            conn.commit()
        finally:
            conn.close()
        _initialized.add(path)
    return path


def _fts_secure_delete_on(conn: sqlite3.Connection) -> bool:
    row = conn.execute("SELECT v FROM intents_fts_config WHERE k = 'secure-delete'").fetchone()
    return bool(row and row[0])


def _delete_fts_row(conn: sqlite3.Connection, job_id: str) -> None:
    """Remove a job's FTS row so its terms leave the index segments, not just search results."""
    conn.execute("DELETE FROM intents_fts WHERE id = ?", (job_id,))
    if not _fts_secure_delete_on(conn):
        conn.execute("INSERT INTO intents_fts (intents_fts) VALUES ('rebuild')")


@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(init_db(), timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA secure_delete=ON")  # deleted rows are zeroed, not left in free pages
    try:
        with conn:  # commit on success, roll back on error
            yield conn
    finally:
        conn.close()


def make_thumb(image_bytes: bytes) -> bytes | None:
    """A <= 256 px JPEG of the screenshot, built in memory. None if the image can't be read."""
    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            img.thumbnail((THUMB_PX, THUMB_PX))
            out = io.BytesIO()
            img.convert("RGB").save(out, format="JPEG", quality=80)
            return out.getvalue()
    except Exception as exc:  # a thumbnail is optional; never fail the job over it
        log.info("thumbnail skipped: %s", type(exc).__name__)
        return None


def save(result: JobResult, thumb: bytes | None = None) -> bool:
    """Store a finished job. Returns False (and stores nothing) unless it is `done` with an intent.

    `egress` is stripped from the saved JSON, and `thumb` is dropped unless thumbnails are on.
    """
    if result.status != "done" or result.intent is None:
        return False
    intent = result.intent
    stored = result.model_copy(update={"egress": []})
    entities = " ".join(e.value for e in intent.public_entities)
    with _connect() as conn:
        _delete_fts_row(conn, result.job_id)
        conn.execute(
            "INSERT OR REPLACE INTO intents"
            " (id, created_at, intent_type, summary, result_json, thumb)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (
                result.job_id,
                time.time(),
                intent.intent_type,
                intent.summary,
                stored.model_dump_json(),
                thumb if keep_thumbs() else None,
            ),
        )
        conn.execute(
            "INSERT INTO intents_fts (id, summary, entities) VALUES (?, ?, ?)",
            (result.job_id, intent.summary, entities),
        )
    return True


def save_quietly(result: JobResult, thumb: bytes | None = None) -> None:
    """`save`, but a library failure is logged and never breaks the job that produced it."""
    try:
        save(result, thumb)
    except Exception as exc:
        log.warning("library save failed for %s: %s", result.job_id, type(exc).__name__)


def fts_query(q: str) -> str | None:
    """Turn free user text into a safe FTS5 expression: every word a quoted prefix term.

    Quoting means FTS5 operators typed by the user (AND, NEAR, `"`, `*`, `:`) are matched as
    plain words instead of raising a syntax error. The result is still bound as a parameter.
    """
    words = re.findall(r"\w+", q)
    if not words:
        return None
    return " ".join('"' + w.replace('"', '""') + '"*' for w in words)


_CARD_COUNT = "json_array_length(intents.result_json, '$.cards')"


def search(
    q: str = "", intent_type: str | None = None, limit: int = DEFAULT_LIMIT
) -> list[LibraryItem]:
    """List saved intents: newest first, or by bm25 relevance when `q` is given."""
    limit = max(1, min(int(limit), MAX_LIMIT))
    params: list[object] = []
    if q.strip():
        match = fts_query(q)
        if match is None:
            return []
        sql = (
            "SELECT intents.id, intents.created_at, intents.intent_type, intents.summary,"
            f" {_CARD_COUNT} AS card_count"
            " FROM intents_fts JOIN intents ON intents.id = intents_fts.id"
            " WHERE intents_fts MATCH ?"
        )
        params.append(match)
        if intent_type:
            sql += " AND intents.intent_type = ?"
            params.append(intent_type)
        sql += " ORDER BY bm25(intents_fts), intents.created_at DESC LIMIT ?"
    else:
        sql = (
            "SELECT intents.id, intents.created_at, intents.intent_type, intents.summary,"
            f" {_CARD_COUNT} AS card_count FROM intents"
        )
        if intent_type:
            sql += " WHERE intents.intent_type = ?"
            params.append(intent_type)
        sql += " ORDER BY intents.created_at DESC LIMIT ?"
    params.append(limit)
    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [LibraryItem(**dict(row)) for row in rows]


def get(job_id: str) -> JobResult | None:
    with _connect() as conn:
        row = conn.execute("SELECT result_json FROM intents WHERE id = ?", (job_id,)).fetchone()
    return JobResult.model_validate(json.loads(row["result_json"])) if row else None


def records(limit: int = MAX_LIMIT) -> list[LibraryRecord]:
    """Return recent scrubbed records for on-device derivation.

    This deliberately exposes neither thumbnails nor FTS internals. Stored results already
    have their egress records removed by ``save``.
    """
    limit = max(1, min(int(limit), MAX_LIMIT))
    with _connect() as conn:
        rows = conn.execute(
            "SELECT created_at, result_json FROM intents ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [
        LibraryRecord(
            created_at=row["created_at"],
            result=JobResult.model_validate(json.loads(row["result_json"])),
        )
        for row in rows
    ]


def delete(job_id: str) -> bool:
    """Delete one intent and its FTS row, leaving none of its text in the file. Returns whether
    it existed.

    `secure_delete` zeroes the ordinary rows; FTS5 secure-delete (or, without it, a rebuild)
    takes the terms out of the index segments; the checkpoint flushes old pages out of the WAL.
    """
    with _connect() as conn:
        _delete_fts_row(conn, job_id)
        cur = conn.execute("DELETE FROM intents WHERE id = ?", (job_id,))
        existed = cur.rowcount > 0
    if existed:
        from app import feed  # local import: feed reads library records

        feed.remove_source(job_id)
    _checkpoint()
    return existed


def _checkpoint() -> None:
    conn = sqlite3.connect(init_db(), timeout=5)
    try:
        busy = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]
    finally:
        conn.close()
    if busy:  # a reader held the WAL; the old pages leave it at the next checkpoint
        log.warning("library WAL checkpoint was busy; deleted pages remain in the WAL for now")


def wipe() -> None:
    """Delete every saved intent, then VACUUM so the freed pages leave the file too."""
    with _connect() as conn:
        conn.execute("DELETE FROM intents_fts")
        conn.execute("DELETE FROM intents")
    from app import feed  # local import: feed stores derived rows in this same private DB

    feed.wipe()
    conn = sqlite3.connect(init_db(), timeout=5)
    try:
        conn.execute("INSERT INTO intents_fts (intents_fts) VALUES ('optimize')")
        conn.commit()
        conn.execute("VACUUM")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        conn.close()
