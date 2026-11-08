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
from pydantic import BaseModel, ConfigDict, Field

from app.config import get_settings
from app.models import IntentType, JobResult

log = logging.getLogger(__name__)

THUMB_PX = 256
DEFAULT_LIMIT = 50
MAX_LIMIT = 200
DEFAULT_CACHE_POLICY_VERSION = "v1"
DEFAULT_PROFILE_SCOPE = "default"
DEFAULT_SOURCE_SCOPE = "public-web"
LOW_USE_THRESHOLD = 1
OLD_ENTRY_SECONDS = 30 * 60
TTL_BY_INTENT: dict[IntentType, int] = {
    "event": 60 * 60,
    "product": 10 * 60,
    "book": 6 * 60 * 60,
    "place": 6 * 60 * 60,
    "chart": 6 * 60 * 60,
    "document": 6 * 60 * 60,
    "other": 6 * 60 * 60,
}

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
CREATE TABLE IF NOT EXISTS cache_meta (
  id TEXT PRIMARY KEY REFERENCES intents(id) ON DELETE CASCADE,
  profile_scope TEXT NOT NULL DEFAULT 'default',
  source_scope TEXT NOT NULL DEFAULT 'public-web',
  cache_key TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  policy_version TEXT NOT NULL DEFAULT 'v1',
  fetched_at REAL NOT NULL,
  fresh_until REAL NOT NULL,
  expires_at REAL NOT NULL,
  last_used_at REAL NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  estimated_bytes INTEGER NOT NULL DEFAULT 0,
  saved INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0
 );
CREATE INDEX IF NOT EXISTS cache_meta_expires_at ON cache_meta (expires_at);
CREATE INDEX IF NOT EXISTS cache_meta_last_used_at ON cache_meta (last_used_at);
CREATE TABLE IF NOT EXISTS interests (
  topic_key TEXT PRIMARY KEY,
  display_topic TEXT NOT NULL,
  created_at REAL NOT NULL,
  last_interacted_at REAL NOT NULL,
  positive_signals INTEGER NOT NULL DEFAULT 0,
  negative_signals INTEGER NOT NULL DEFAULT 0,
  explicit_positive INTEGER NOT NULL DEFAULT 0,
  explicit_negative INTEGER NOT NULL DEFAULT 0,
  save_count INTEGER NOT NULL DEFAULT 0,
  open_count INTEGER NOT NULL DEFAULT 0,
  forgotten INTEGER NOT NULL DEFAULT 0
 );
CREATE INDEX IF NOT EXISTS interests_last_interacted_at ON interests (last_interacted_at DESC);
"""


class LibraryItem(BaseModel):
    """One row of `GET /api/library`."""

    model_config = ConfigDict(extra="forbid")

    id: str
    created_at: float
    intent_type: IntentType
    summary: str
    card_count: int


class CacheCleanupPreview(BaseModel):
    removable_entries: int
    removable_bytes: int
    kept_saved_items: int
    kept_interests: int
    candidate_ids: list[str] = Field(default_factory=list)


class CacheCleanupResult(BaseModel):
    removed_entries: int
    removed_bytes: int
    skipped_not_eligible: int
    kept_saved_items: int
    kept_interests: int
    deleted_ids: list[str] = Field(default_factory=list)


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
            _backfill_cache_meta(conn)
            _enable_fts_secure_delete(conn)
            conn.commit()
        finally:
            conn.close()
        _initialized.add(path)
    return path


def _fts_secure_delete_on(conn: sqlite3.Connection) -> bool:
    row = conn.execute("SELECT v FROM intents_fts_config WHERE k = 'secure-delete'").fetchone()
    return bool(row and row[0])


def _ttl_for_intent(intent_type: IntentType) -> int:
    return TTL_BY_INTENT.get(intent_type, 6 * 60 * 60)


def _normalize_topic(topic: str) -> str:
    words = re.findall(r"\w+", topic.lower())
    return " ".join(words).strip()


def _backfill_cache_meta(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        "SELECT intents.id, intents.created_at, intents.intent_type, intents.result_json"
        " FROM intents LEFT JOIN cache_meta ON cache_meta.id = intents.id"
        " WHERE cache_meta.id IS NULL"
    ).fetchall()
    for row in rows:
        intent_type = row["intent_type"] if isinstance(row, sqlite3.Row) else row[2]
        created_at = float(row["created_at"] if isinstance(row, sqlite3.Row) else row[1])
        ttl = _ttl_for_intent(intent_type)
        result_json = row["result_json"] if isinstance(row, sqlite3.Row) else row[3]
        est = len(result_json.encode()) if isinstance(result_json, str) else 0
        conn.execute(
            "INSERT OR REPLACE INTO cache_meta "
            "(id, fetched_at, fresh_until, expires_at, last_used_at, estimated_bytes, policy_version)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                row["id"] if isinstance(row, sqlite3.Row) else row[0],
                created_at,
                created_at + ttl,
                created_at + (ttl * 2),
                created_at,
                est,
                DEFAULT_CACHE_POLICY_VERSION,
            ),
        )


def _delete_fts_row(conn: sqlite3.Connection, job_id: str) -> None:
    """Remove a job's FTS row so its terms leave the index segments, not just search results."""
    conn.execute("DELETE FROM intents_fts WHERE id = ?", (job_id,))
    if not _fts_secure_delete_on(conn):
        conn.execute("INSERT INTO intents_fts (intents_fts) VALUES ('rebuild')")


def _upsert_cache_meta(
    conn: sqlite3.Connection,
    *,
    job_id: str,
    intent_type: IntentType,
    fetched_at: float,
    cache_key: str,
    estimated_bytes: int,
) -> None:
    ttl = _ttl_for_intent(intent_type)
    conn.execute(
        "INSERT INTO cache_meta "
        "(id, profile_scope, source_scope, cache_key, policy_version, fetched_at, fresh_until,"
        " expires_at, last_used_at, access_count, estimated_bytes, saved, pinned)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?,"
        " COALESCE((SELECT saved FROM cache_meta WHERE id = ?), 0),"
        " COALESCE((SELECT pinned FROM cache_meta WHERE id = ?), 0))"
        " ON CONFLICT(id) DO UPDATE SET"
        " cache_key = excluded.cache_key,"
        " fetched_at = excluded.fetched_at,"
        " fresh_until = excluded.fresh_until,"
        " expires_at = excluded.expires_at,"
        " estimated_bytes = excluded.estimated_bytes,"
        " policy_version = excluded.policy_version",
        (
            job_id,
            DEFAULT_PROFILE_SCOPE,
            DEFAULT_SOURCE_SCOPE,
            cache_key,
            DEFAULT_CACHE_POLICY_VERSION,
            fetched_at,
            fetched_at + ttl,
            fetched_at + (ttl * 2),
            fetched_at,
            estimated_bytes,
            job_id,
            job_id,
        ),
    )


def _bump_interest(
    conn: sqlite3.Connection,
    topic: str,
    *,
    now: float,
    positive: int = 0,
    negative: int = 0,
    explicit_positive: bool = False,
    explicit_negative: bool = False,
    save_delta: int = 0,
    open_delta: int = 0,
) -> None:
    topic_key = _normalize_topic(topic)
    if not topic_key:
        return
    existing = conn.execute(
        "SELECT forgotten FROM interests WHERE topic_key = ?",
        (topic_key,),
    ).fetchone()
    if existing and existing["forgotten"] and not (explicit_positive or explicit_negative):
        return
    conn.execute(
        "INSERT INTO interests "
        "(topic_key, display_topic, created_at, last_interacted_at, positive_signals, negative_signals,"
        " explicit_positive, explicit_negative, save_count, open_count, forgotten)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        " ON CONFLICT(topic_key) DO UPDATE SET"
        " display_topic = excluded.display_topic,"
        " last_interacted_at = excluded.last_interacted_at,"
        " positive_signals = MIN(100, interests.positive_signals + excluded.positive_signals),"
        " negative_signals = MIN(100, interests.negative_signals + excluded.negative_signals),"
        " explicit_positive = MAX(interests.explicit_positive, excluded.explicit_positive),"
        " explicit_negative = MAX(interests.explicit_negative, excluded.explicit_negative),"
        " save_count = MIN(100, interests.save_count + excluded.save_count),"
        " open_count = MIN(100, interests.open_count + excluded.open_count),"
        " forgotten = CASE"
        "   WHEN excluded.explicit_positive = 1 THEN 0"
        "   WHEN excluded.explicit_negative = 1 THEN 1"
        "   ELSE interests.forgotten"
        " END",
        (
            topic_key,
            topic.strip()[:200] or topic_key,
            now,
            now,
            max(0, positive),
            max(0, negative),
            1 if explicit_positive else 0,
            1 if explicit_negative else 0,
            max(0, save_delta),
            max(0, open_delta),
            1 if explicit_negative else 0,
        ),
    )


def _interest_topics_from_result(result: JobResult) -> set[str]:
    if result.intent is None:
        return set()
    return {entity.value for entity in result.intent.public_entities if entity.value.strip()}


def _touch_usage(conn: sqlite3.Connection, job_id: str, now: float) -> None:
    conn.execute(
        "UPDATE cache_meta"
        " SET last_used_at = ?, access_count = MIN(1000, access_count + 1)"
        " WHERE id = ?",
        (now, job_id),
    )


def _protected_counts(conn: sqlite3.Connection) -> tuple[int, int]:
    saved = conn.execute("SELECT COUNT(*) FROM cache_meta WHERE saved = 1 OR pinned = 1").fetchone()[0]
    interests = conn.execute("SELECT COUNT(*) FROM interests WHERE forgotten = 0").fetchone()[0]
    return int(saved), int(interests)


def _eligible_cleanup_ids(conn: sqlite3.Connection, now: float) -> list[str]:
    rows = conn.execute(
        "SELECT id FROM cache_meta WHERE (saved = 0 AND pinned = 0) AND ("
        " expires_at <= ?"
        " OR (fresh_until <= ? AND access_count <= ? AND last_used_at <= ?)"
        ") ORDER BY expires_at ASC, last_used_at ASC",
        (now, now, LOW_USE_THRESHOLD, now - OLD_ENTRY_SECONDS),
    ).fetchall()
    return [str(row[0]) for row in rows]


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
    fetched_at = time.time()
    cache_key = f"{intent.intent_type}:{_normalize_topic(intent.summary)}"
    estimated_bytes = len(stored.model_dump_json().encode()) + len(entities.encode())
    with _connect() as conn:
        _delete_fts_row(conn, result.job_id)
        conn.execute(
            "INSERT OR REPLACE INTO intents"
            " (id, created_at, intent_type, summary, result_json, thumb)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (
                result.job_id,
                fetched_at,
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
        _upsert_cache_meta(
            conn,
            job_id=result.job_id,
            intent_type=intent.intent_type,
            fetched_at=fetched_at,
            cache_key=cache_key,
            estimated_bytes=estimated_bytes,
        )
        for topic in _interest_topics_from_result(stored):
            _bump_interest(conn, topic, now=fetched_at, positive=1)
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
        if row:
            _touch_usage(conn, job_id, now=time.time())
    return JobResult.model_validate(json.loads(row["result_json"])) if row else None


def delete(job_id: str) -> bool:
    """Delete one intent and its FTS row, leaving none of its text in the file. Returns whether
    it existed.

    `secure_delete` zeroes the ordinary rows; FTS5 secure-delete (or, without it, a rebuild)
    takes the terms out of the index segments; the checkpoint flushes old pages out of the WAL.
    """
    with _connect() as conn:
        _delete_fts_row(conn, job_id)
        conn.execute("DELETE FROM cache_meta WHERE id = ?", (job_id,))
        cur = conn.execute("DELETE FROM intents WHERE id = ?", (job_id,))
        existed = cur.rowcount > 0
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
        conn.execute("DELETE FROM cache_meta")
        conn.execute("DELETE FROM intents_fts")
        conn.execute("DELETE FROM intents")
        conn.execute("DELETE FROM interests")
    conn = sqlite3.connect(init_db(), timeout=5)
    try:
        conn.execute("INSERT INTO intents_fts (intents_fts) VALUES ('optimize')")
        conn.commit()
        conn.execute("VACUUM")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        conn.close()


def mark_saved(job_id: str, *, saved: bool, pinned: bool = False) -> bool:
    now = time.time()
    with _connect() as conn:
        row = conn.execute("SELECT result_json FROM intents WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            return False
        conn.execute(
            "UPDATE cache_meta SET saved = ?, pinned = ?, last_used_at = ? WHERE id = ?",
            (1 if saved else 0, 1 if pinned else 0, now, job_id),
        )
        result = JobResult.model_validate(json.loads(row["result_json"]))
        for topic in _interest_topics_from_result(result):
            _bump_interest(
                conn,
                topic,
                now=now,
                explicit_positive=saved or pinned,
                save_delta=1 if saved else 0,
            )
    return True


def forget_interest(topic: str) -> None:
    now = time.time()
    with _connect() as conn:
        _bump_interest(conn, topic, now=now, negative=1, explicit_negative=True)
        topic_key = _normalize_topic(topic)
        if topic_key:
            rows = conn.execute(
                "SELECT intents.id, intents.result_json FROM intents"
                " JOIN cache_meta ON cache_meta.id = intents.id"
                " WHERE cache_meta.saved = 0 AND cache_meta.pinned = 0"
            ).fetchall()
            for row in rows:
                result = JobResult.model_validate(json.loads(row["result_json"]))
                topics = {_normalize_topic(t) for t in _interest_topics_from_result(result)}
                if topic_key in topics:
                    _delete_fts_row(conn, row["id"])
                    conn.execute("DELETE FROM cache_meta WHERE id = ?", (row["id"],))
                    conn.execute("DELETE FROM intents WHERE id = ?", (row["id"],))
    _checkpoint()


def cleanup_preview(now: float | None = None) -> CacheCleanupPreview:
    now = time.time() if now is None else now
    with _connect() as conn:
        ids = _eligible_cleanup_ids(conn, now)
        removable_bytes = conn.execute(
            "SELECT COALESCE(SUM(estimated_bytes), 0) FROM cache_meta WHERE id IN ("
            + ",".join("?" for _ in ids)
            + ")",
            ids,
        ).fetchone()[0] if ids else 0
        saved_count, interests_count = _protected_counts(conn)
    return CacheCleanupPreview(
        removable_entries=len(ids),
        removable_bytes=int(removable_bytes or 0),
        kept_saved_items=saved_count,
        kept_interests=interests_count,
        candidate_ids=ids,
    )


def execute_cleanup(candidate_ids: list[str] | None = None, now: float | None = None) -> CacheCleanupResult:
    now = time.time() if now is None else now
    with _connect() as conn:
        eligible = set(_eligible_cleanup_ids(conn, now))
        if candidate_ids is None:
            selected = eligible
            skipped = 0
        else:
            selected = eligible.intersection(candidate_ids)
            skipped = len(set(candidate_ids) - selected)
        deleted = sorted(selected)
        removed_bytes = 0
        if deleted:
            placeholders = ",".join("?" for _ in deleted)
            removed_bytes = conn.execute(
                f"SELECT COALESCE(SUM(estimated_bytes), 0) FROM cache_meta WHERE id IN ({placeholders})",
                deleted,
            ).fetchone()[0]
            for job_id in deleted:
                _delete_fts_row(conn, job_id)
            conn.execute(f"DELETE FROM cache_meta WHERE id IN ({placeholders})", deleted)
            conn.execute(f"DELETE FROM intents WHERE id IN ({placeholders})", deleted)
        saved_count, interests_count = _protected_counts(conn)
    if deleted:
        _checkpoint()
    return CacheCleanupResult(
        removed_entries=len(deleted),
        removed_bytes=int(removed_bytes or 0),
        skipped_not_eligible=skipped,
        kept_saved_items=saved_count,
        kept_interests=interests_count,
        deleted_ids=deleted,
    )


def wipe_all_local_data(confirm: str) -> bool:
    if confirm != "DELETE_ALL_LOCAL_DATA":
        return False
    wipe()
    return True
