"""Private, finite Muse feed derived from scrubbed local-library records.

Local observations never leave the machine. Optional discovery uses one deterministic query
from ``query.feed_discovery_query`` and the existing Tavily path, so the egress guard still
checks and audits every attempted request. Feed rows contain only derived scrubbed text,
public source URLs, action cards, and source job IDs.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
import threading
import time
from collections import defaultdict
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass

from app import egress, library
from app.config import get_settings
from app.models import (
    Card,
    CardAction,
    FeedFeedbackAction,
    FeedItem,
    FeedItemDetail,
    FeedItemKind,
    FeedProvenance,
    FeedResponse,
    FeedSource,
    Intent,
    JobResult,
    SearchQuery,
)
from app.pipeline import cards as cards_mod
from app.pipeline import search as search_mod
from app.pipeline.query import allow_terms, feed_discovery_query

MAX_FEED_ITEMS = 20
MAX_DISCOVERIES = 4

SCHEMA = """
CREATE TABLE IF NOT EXISTS feed_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at REAL NOT NULL,
  score REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  feedback_json TEXT NOT NULL DEFAULT '[]',
  topic_keys_json TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_items_rank ON feed_items (status, score DESC, created_at DESC);
CREATE TABLE IF NOT EXISTS feed_suppressions (
  topic_key TEXT PRIMARY KEY,
  created_at REAL NOT NULL,
  source_job_ids_json TEXT NOT NULL DEFAULT '[]'
);
"""


@dataclass(frozen=True)
class _Candidate:
    detail: FeedItemDetail
    score: float
    topic_keys: frozenset[str]


_init_lock = threading.Lock()
_initialized: set[str] = set()
_refresh_lock = asyncio.Lock()


@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    path = library.init_db()
    key = str(path)
    with _init_lock:
        if key not in _initialized:
            conn = sqlite3.connect(path)
            try:
                conn.executescript(SCHEMA)
                columns = {row[1] for row in conn.execute("PRAGMA table_info(feed_suppressions)")}
                if "source_job_ids_json" not in columns:
                    conn.execute(
                        "ALTER TABLE feed_suppressions "
                        "ADD COLUMN source_job_ids_json TEXT NOT NULL DEFAULT '[]'"
                    )
                feed_columns = {row[1] for row in conn.execute("PRAGMA table_info(feed_items)")}
                if "feedback_json" not in feed_columns:
                    conn.execute(
                        "ALTER TABLE feed_items ADD COLUMN feedback_json TEXT NOT NULL DEFAULT '[]'"
                    )
                conn.commit()
            finally:
                conn.close()
            _initialized.add(key)
    conn = sqlite3.connect(path, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA secure_delete=ON")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def _norm(value: str) -> str:
    return " ".join(value.casefold().split())


def _stable_id(kind: FeedItemKind, *parts: str) -> str:
    digest = hashlib.sha256("\x1f".join((kind, *parts)).encode()).hexdigest()[:16]
    return f"f_{digest}"


def _entities(intent: Intent) -> dict[str, list[str]]:
    out: dict[str, list[str]] = defaultdict(list)
    for entity in intent.public_entities:
        value = " ".join(entity.value.split())
        if value and _norm(value) not in {_norm(v) for v in out[entity.type]}:
            out[entity.type].append(value)
    return dict(out)


def _topic_keys(intent: Intent) -> frozenset[str]:
    return frozenset(
        f"{entity.type}:{_norm(entity.value)}"
        for entity in intent.public_entities
        if entity.value.strip()
    )


def _label(intent: Intent) -> str:
    entities = _entities(intent)
    preferred = {
        "event": ("performer", "event_name"),
        "product": ("product", "brand"),
        "book": ("book_title", "author"),
        "place": ("place", "city"),
        "chart": ("topic", "public_org", "metric"),
        "document": ("topic", "public_org"),
        "other": ("topic", "product", "place"),
    }
    for entity_type in preferred[intent.intent_type]:
        if entities.get(entity_type):
            return entities[entity_type][0]
    return f"saved {intent.intent_type}"


def _dedupe_actions(cards: Iterable[Card], limit: int = 3) -> list[CardAction]:
    out: list[CardAction] = []
    seen: set[str] = set()
    for card in cards:
        for action in card.actions:
            key = action.model_dump_json()
            if key in seen:
                continue
            seen.add(key)
            out.append(action)
            if len(out) == limit:
                return out
    return out


def _sources(records: Iterable[library.LibraryRecord]) -> list[FeedSource]:
    out = []
    for record in records:
        intent = record.result.intent
        if intent is not None:
            out.append(
                FeedSource(
                    title=f"Saved {intent.intent_type}: {_label(intent)}",
                    job_id=record.result.job_id,
                )
            )
    return out


def _shared_entity_candidates(records: list[library.LibraryRecord]) -> list[_Candidate]:
    index: dict[tuple[str, str], list[library.LibraryRecord]] = defaultdict(list)
    display: dict[tuple[str, str], str] = {}
    for record in records:
        intent = record.result.intent
        if intent is None:
            continue
        for entity in intent.public_entities:
            key = (entity.type, _norm(entity.value))
            if not key[1]:
                continue
            display.setdefault(key, " ".join(entity.value.split()))
            if all(existing.result.job_id != record.result.job_id for existing in index[key]):
                index[key].append(record)

    candidates: list[_Candidate] = []
    for key, matched in index.items():
        if len(matched) < 2:
            continue
        matched.sort(key=lambda row: row.created_at, reverse=True)
        value = display[key]
        source_ids = [row.result.job_id for row in matched]
        shared_cards = [card for row in matched for card in row.result.cards]
        topic_key = f"{key[0]}:{key[1]}"
        detail = FeedItemDetail(
            id=_stable_id("connection", topic_key, *sorted(source_ids)),
            kind="connection",
            title=f"{value} keeps showing up",
            teaser=f"{len(matched)} saved memories connect through {value}.",
            source_job_ids=source_ids,
            why=f"Latent found the same public {key[0].replace('_', ' ')} in these saved items.",
            created_at=max(row.created_at for row in matched),
            provenance="local",
            actions=_dedupe_actions(shared_cards),
            body=(
                f"You saved {len(matched)} items that mention {value}. "
                "They may belong to the same idea, plan, or interest."
            ),
            sources=_sources(matched),
            cards=shared_cards[:4],
        )
        candidates.append(
            _Candidate(
                detail=detail,
                score=78 + min(len(matched), 5) * 4,
                topic_keys=frozenset({topic_key}),
            )
        )
        if len(matched) >= 3:
            pattern = detail.model_copy(
                update={
                    "id": _stable_id("pattern", topic_key),
                    "kind": "pattern",
                    "title": f"A pattern around {value}",
                    "teaser": f"{value} appears across {len(matched)} things you saved.",
                    "why": "This is a repeated public topic across at least three local memories.",
                    "body": (
                        f"{value} has appeared in {len(matched)} saved items. "
                        "Latent surfaced the pattern locally without sending anything out."
                    ),
                }
            )
            candidates.append(
                _Candidate(
                    detail=pattern,
                    score=84 + min(len(matched), 6) * 4,
                    topic_keys=frozenset({topic_key}),
                )
            )
    return candidates


def _follow_up_candidates(records: list[library.LibraryRecord]) -> list[_Candidate]:
    candidates = []
    for record in records:
        intent = record.result.intent
        if intent is None:
            continue
        useful = [
            card
            for card in record.result.cards
            if card.kind in {"calendar", "tickets", "shop", "book", "place"}
        ]
        if not useful:
            continue
        label = _label(intent)
        detail = FeedItemDetail(
            id=_stable_id("follow_up", record.result.job_id),
            kind="follow_up",
            title=f"Take the next step on {label}",
            teaser="The useful details from this saved item are ready when you are.",
            source_job_ids=[record.result.job_id],
            why="This saved memory already has a concrete action available.",
            created_at=record.created_at,
            provenance="local",
            actions=_dedupe_actions(useful),
            body=(
                "Latent is resurfacing an available action, not claiming that you have or "
                "have not completed it."
            ),
            sources=_sources([record]),
            cards=useful[:3],
        )
        candidates.append(
            _Candidate(
                detail=detail,
                score=62,
                topic_keys=_topic_keys(intent),
            )
        )
    return candidates[:6]


def _web_cards(
    intent: Intent,
    query_text: str,
    results: dict[str, search_mod.TavilyResponse],
    original: JobResult,
) -> list[Card]:
    query = feed_discovery_query(intent)
    if query is None or query.text != query_text:
        return []
    existing_urls = {card.url for card in original.cards if card.url}
    built = cards_mod.build_cards(intent, [query], results)
    return [
        card
        for card in built
        if card.kind not in {"calendar", "place"}
        and (card.url is None or card.url not in existing_urls)
    ][:3]


async def _one_discovery(
    record: library.LibraryRecord, intent: Intent, query: SearchQuery
) -> _Candidate:
    results = await search_mod.search([query], "", allow_terms(intent))
    cards = await asyncio.to_thread(_web_cards, intent, query.text, results, record.result)
    label = _label(intent)
    sources = [FeedSource(title=card.title, url=card.url) for card in cards if card.url is not None]
    unavailable = not cards
    if egress.is_offline():
        body = (
            "Discovery is paused while air-gap mode is on. The local memory remains "
            "available and no request left this device."
        )
    elif unavailable:
        body = (
            "No verified web suggestions are available right now. Your local memory "
            "remains available and no result has been invented."
        )
    else:
        body = (
            f"These public results are related to {label}. Open a source to verify details "
            "or booking availability with the original provider."
        )
    city = next(
        (e.value for e in intent.public_entities if e.type == "city" and e.value.strip()),
        None,
    )
    nearby = f" near {city}" if city and intent.intent_type in {"event", "place"} else ""
    detail = FeedItemDetail(
        id=_stable_id("discovery", query.text, record.result.job_id),
        kind="discovery",
        title=f"More ideas like {label}{nearby}",
        teaser=(
            "Fresh public suggestions based on one saved memory."
            if cards
            else "Web discovery is unavailable; your local context stays ready."
        ),
        source_job_ids=[record.result.job_id],
        why=(
            "Built only from public entities in one saved memory. "
            "Nearby uses only the public location in that saved item."
        ),
        created_at=record.created_at,
        provenance="web",
        actions=_dedupe_actions(cards),
        body=body,
        sources=[*_sources([record]), *sources],
        cards=cards,
    )
    return _Candidate(
        detail=detail,
        score=92 if cards else 52,
        topic_keys=_topic_keys(intent),
    )


async def _discovery_candidates(
    records: list[library.LibraryRecord],
) -> list[_Candidate]:
    selected: list[tuple[library.LibraryRecord, Intent, SearchQuery]] = []
    seen_queries: set[str] = set()
    for record in records:
        if len(selected) == MAX_DISCOVERIES:
            break
        intent = record.result.intent
        if intent is None:
            continue
        query = await asyncio.to_thread(feed_discovery_query, intent)
        if query is None or query.text.casefold() in seen_queries:
            continue
        seen_queries.add(query.text.casefold())
        selected.append((record, intent, query))
    return list(
        await asyncio.gather(
            *(_one_discovery(record, intent, query) for record, intent, query in selected)
        )
    )


def _mock_candidates() -> list[_Candidate]:
    now = time.time()
    source = FeedSource(title="Nova Fields festival in Port Aurora", job_id="j_mock_festival")
    action = CardAction(
        label="View details",
        type="open_url",
        url="https://events.example/nova-fields",
    )
    specs: list[tuple[FeedItemKind, str, str, FeedProvenance]] = [
        (
            "discovery",
            "A few more nights like Nova Fields",
            "Three public festival ideas near Port Aurora.",
            "web",
        ),
        (
            "connection",
            "Nova Fields connects two saved plans",
            "Your festival and travel saves share Port Aurora.",
            "local",
        ),
        (
            "follow_up",
            "Make a plan for Nova Fields",
            "The calendar and ticket details are ready when you are.",
            "local",
        ),
        (
            "pattern",
            "Live music keeps finding you",
            "Live music appears across three things you saved.",
            "local",
        ),
    ]
    out = []
    for index, (kind, title, teaser, provenance) in enumerate(specs):
        detail = FeedItemDetail(
            id=f"f_mock_{kind}",
            kind=kind,
            title=title,
            teaser=teaser,
            source_job_ids=["j_mock_festival"],
            why="Demo evidence from scrubbed public entities in local fixtures.",
            created_at=now - index,
            provenance=provenance,
            actions=[action] if kind in {"discovery", "follow_up"} else [],
            body="A deterministic mock detail for the Muse feed. No network request was made.",
            sources=[source],
            cards=[],
        )
        out.append(
            _Candidate(
                detail=detail,
                score=100 - index,
                topic_keys=frozenset({"topic:live music"}),
            )
        )
    return out


def _suppressed() -> set[str]:
    with _connect() as conn:
        return {row["topic_key"] for row in conn.execute("SELECT topic_key FROM feed_suppressions")}


def _rank(candidates: list[_Candidate], suppressed: set[str]) -> list[_Candidate]:
    unique: dict[str, _Candidate] = {}
    for candidate in candidates:
        if candidate.topic_keys & suppressed:
            continue
        current = unique.get(candidate.detail.id)
        if current is None or candidate.score > current.score:
            unique[candidate.detail.id] = candidate
    remaining = sorted(
        unique.values(),
        key=lambda item: (-item.score, -item.detail.created_at, item.detail.id),
    )
    ranked: list[_Candidate] = []
    while remaining and len(ranked) < MAX_FEED_ITEMS:
        pick = next(
            (
                index
                for index, candidate in enumerate(remaining)
                if len(ranked) < 2
                or candidate.detail.kind != ranked[-1].detail.kind
                or candidate.detail.kind != ranked[-2].detail.kind
            ),
            None,
        )
        if pick is None:
            break
        ranked.append(remaining.pop(pick))
    return ranked


def _replace(candidates: list[_Candidate], *, expected_generation: int) -> None:
    ids = [candidate.detail.id for candidate in candidates]
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        generation = conn.execute("SELECT generation FROM memory_state WHERE id = 1").fetchone()[0]
        if generation != expected_generation:
            return
        for index, candidate in enumerate(candidates):
            conn.execute(
                """
                INSERT INTO feed_items
                  (id, kind, created_at, score, status, topic_keys_json, detail_json)
                VALUES (?, ?, ?, ?, 'active', ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  kind=excluded.kind,
                  created_at=excluded.created_at,
                  score=excluded.score,
                  topic_keys_json=excluded.topic_keys_json,
                  detail_json=excluded.detail_json
                """,
                (
                    candidate.detail.id,
                    candidate.detail.kind,
                    candidate.detail.created_at,
                    MAX_FEED_ITEMS - index,
                    json.dumps(sorted(candidate.topic_keys)),
                    candidate.detail.model_dump_json(),
                ),
            )
        if ids:
            marks = ",".join("?" for _ in ids)
            conn.execute(
                f"DELETE FROM feed_items WHERE status = 'active' AND id NOT IN ({marks})",
                ids,
            )
        else:
            conn.execute("DELETE FROM feed_items WHERE status = 'active'")


async def refresh() -> None:
    """Regenerate the finite feed from the current scrubbed local library."""
    async with _refresh_lock:
        generation = await asyncio.to_thread(library.current_generation)
        if get_settings().latent_mock:
            candidates = _mock_candidates()
        else:
            records = await asyncio.to_thread(library.records)
            local = await asyncio.to_thread(
                lambda: [
                    *_shared_entity_candidates(records),
                    *_follow_up_candidates(records),
                ]
            )
            discoveries = await _discovery_candidates(records)
            candidates = [*discoveries, *local]
        suppressed = await asyncio.to_thread(_suppressed)
        ranked = _rank(candidates, suppressed)
        await asyncio.to_thread(_replace, ranked, expected_generation=generation)


def list_items(limit: int = MAX_FEED_ITEMS) -> FeedResponse:
    limit = max(1, min(int(limit), MAX_FEED_ITEMS))
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT detail_json, feedback_json FROM feed_items
            WHERE status = 'active'
            ORDER BY score DESC, created_at DESC, id
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    details = [
        FeedItemDetail.model_validate_json(row["detail_json"]).model_copy(
            update={"feedback": json.loads(row["feedback_json"])}
        )
        for row in rows
    ]
    return FeedResponse(
        items=[
            FeedItem.model_validate(detail.model_dump(exclude={"body", "sources", "cards"}))
            for detail in details
        ],
        generated_at=time.time(),
    )


def get_item(item_id: str) -> FeedItemDetail | None:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT detail_json, feedback_json FROM feed_items
            WHERE id = ? AND status = 'active'
            """,
            (item_id,),
        ).fetchone()
    if row is None:
        return None
    return FeedItemDetail.model_validate_json(row["detail_json"]).model_copy(
        update={"feedback": json.loads(row["feedback_json"])}
    )


def feedback(item_id: str, action: FeedFeedbackAction) -> bool:
    """Persist feedback. Negative feedback hides this item; less-like also suppresses topics."""
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT topic_keys_json, detail_json, feedback_json
            FROM feed_items WHERE id = ?
            """,
            (item_id,),
        ).fetchone()
        if row is None:
            return False
        hidden = action in {"not_useful", "dismiss", "less_like_this"}
        states = set(json.loads(row["feedback_json"]))
        states.add(action)
        conn.execute(
            "UPDATE feed_items SET feedback_json = ?, status = ? WHERE id = ?",
            (json.dumps(sorted(states)), "hidden" if hidden else "active", item_id),
        )
        if action == "less_like_this":
            item_sources = set(
                FeedItemDetail.model_validate_json(row["detail_json"]).source_job_ids
            )
            for topic_key in json.loads(row["topic_keys_json"]):
                sources = set(item_sources)
                existing = conn.execute(
                    "SELECT source_job_ids_json FROM feed_suppressions WHERE topic_key = ?",
                    (topic_key,),
                ).fetchone()
                if existing:
                    sources.update(json.loads(existing["source_job_ids_json"]))
                conn.execute(
                    """
                    INSERT INTO feed_suppressions
                      (topic_key, created_at, source_job_ids_json)
                    VALUES (?, ?, ?)
                    ON CONFLICT(topic_key) DO UPDATE SET
                      created_at=excluded.created_at,
                      source_job_ids_json=excluded.source_job_ids_json
                    """,
                    (topic_key, time.time(), json.dumps(sorted(sources))),
                )
    return True


def remove_source(job_id: str) -> None:
    """Remove derived items that cite a library record which has been deleted."""
    with _connect() as conn:
        rows = conn.execute("SELECT id, detail_json FROM feed_items").fetchall()
        ids = [
            row["id"]
            for row in rows
            if job_id in FeedItemDetail.model_validate_json(row["detail_json"]).source_job_ids
        ]
        if ids:
            marks = ",".join("?" for _ in ids)
            conn.execute(f"DELETE FROM feed_items WHERE id IN ({marks})", ids)
        suppressions = conn.execute(
            "SELECT topic_key, source_job_ids_json FROM feed_suppressions"
        ).fetchall()
        for suppression in suppressions:
            sources = set(json.loads(suppression["source_job_ids_json"]))
            sources.discard(job_id)
            if sources:
                conn.execute(
                    "UPDATE feed_suppressions SET source_job_ids_json = ? WHERE topic_key = ?",
                    (json.dumps(sorted(sources)), suppression["topic_key"]),
                )
            else:
                conn.execute(
                    "DELETE FROM feed_suppressions WHERE topic_key = ?",
                    (suppression["topic_key"],),
                )


def wipe(conn: sqlite3.Connection | None = None) -> None:
    """Remove derived data, optionally inside the caller's atomic memory reset."""
    if conn is None:
        with _connect() as own_conn:
            wipe(own_conn)
        return
    # A first-run reset must work before the optional feed schema has been initialized.
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "feed_items" in tables:
        conn.execute("DELETE FROM feed_items")
    if "feed_suppressions" in tables:
        conn.execute("DELETE FROM feed_suppressions")
