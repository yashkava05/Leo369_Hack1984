"""Muse feed: local evidence, privacy-safe discovery, feedback, and finite API."""

import json
import sqlite3

import httpx
from fastapi.testclient import TestClient

from app import egress, feed, library
from app.config import get_settings
from app.main import app
from app.models import Card, CardAction, Entity, Intent, JobResult
from app.pipeline.search import TavilyResponse, TavilyResult


def event(
    job_id: str,
    *,
    performer: str = "Nova Fields",
    city: str = "Port Aurora",
    summary: str = "Nova Fields festival in Port Aurora",
) -> JobResult:
    intent = Intent(
        intent_type="event",
        summary=summary,
        public_entities=[
            Entity(type="performer", value=performer),
            Entity(type="city", value=city),
            Entity(type="date", value="2026-11-14"),
        ],
        redaction_counts={},
        confidence=0.9,
    )
    calendar = Card(
        id=f"c_{job_id}",
        kind="calendar",
        title=f"Plan {performer}",
        source="local",
        actions=[
            CardAction(
                label="Add to calendar",
                type="download_ics",
                ics={
                    "title": performer,
                    "start": "2026-11-14T19:00:00-05:00",
                    "location": city,
                },
            )
        ],
    )
    return JobResult(
        job_id=job_id,
        status="done",
        intent=intent,
        cards=[calendar],
    )


async def fake_search(queries, job_id, allow_terms):
    del job_id, allow_terms
    return {
        query.text: TavilyResponse(
            query=query.text,
            answer="Three similar public events.",
            results=[
                TavilyResult(
                    title="Harbor Light Festival",
                    url="https://events.example/harbor-light",
                    content="A public live music festival in Port Aurora.",
                    score=0.92,
                )
            ],
        )
        for query in queries
    }


def table_names() -> set[str]:
    conn = sqlite3.connect(library.db_path())
    try:
        return {row[0] for row in conn.execute("SELECT name FROM sqlite_master")}
    finally:
        conn.close()


def test_feed_schema_shares_private_local_database():
    feed.list_items()
    assert {"feed_items", "feed_suppressions"} <= table_names()
    assert library.db_path().stat().st_mode & 0o777 == 0o600


async def test_refresh_builds_all_local_kinds_and_web_discovery(monkeypatch):
    for index in range(3):
        assert library.save(event(f"j_event_{index}"))
    monkeypatch.setattr(feed.search_mod, "search", fake_search)

    await feed.refresh()
    response = feed.list_items()
    kinds = {item.kind for item in response.items}
    assert kinds == {"discovery", "connection", "follow_up", "pattern"}
    assert response.next_cursor is None
    assert len(response.items) <= feed.MAX_FEED_ITEMS
    assert all(
        len({item.kind for item in response.items[index : index + 3]}) > 1
        for index in range(max(0, len(response.items) - 2))
    )

    discovery = next(item for item in response.items if item.kind == "discovery")
    assert discovery.provenance == "web"
    assert "Port Aurora" in discovery.title
    detail = feed.get_item(discovery.id)
    assert detail is not None
    result_card = next(card for card in detail.cards if card.url)
    assert result_card.url == "https://events.example/harbor-light"
    assert any(source.url == result_card.url for source in detail.sources)
    assert detail.source_job_ids
    assert detail.why

    local = next(item for item in response.items if item.kind == "connection")
    local_detail = feed.get_item(local.id)
    assert local_detail is not None
    assert local_detail.provenance == "local"
    assert len(local_detail.sources) == 3
    assert all(source.job_id for source in local_detail.sources)


async def test_negative_feedback_persists_and_suppresses_matching_refresh(monkeypatch):
    for index in range(3):
        library.save(event(f"j_suppress_{index}"))
    monkeypatch.setattr(feed.search_mod, "search", fake_search)
    await feed.refresh()
    item = next(
        row
        for row in feed.list_items().items
        if row.kind == "pattern" and "Nova Fields" in row.title
    )

    assert feed.feedback(item.id, "less_like_this")
    assert feed.get_item(item.id) is None
    await feed.refresh()
    assert all("Nova Fields" not in row.title for row in feed.list_items().items)

    conn = sqlite3.connect(library.db_path())
    try:
        suppressions = conn.execute("SELECT topic_key FROM feed_suppressions").fetchall()
    finally:
        conn.close()
    assert ("performer:nova fields",) in suppressions

    for index in range(3):
        assert library.delete(f"j_suppress_{index}")
    conn = sqlite3.connect(library.db_path())
    try:
        assert conn.execute("SELECT count(*) FROM feed_suppressions").fetchone()[0] == 0
    finally:
        conn.close()


async def test_dismiss_hides_item_but_useful_keeps_it(monkeypatch):
    library.save(event("j_feedback"))
    library.save(event("j_feedback_two", performer="Harbor Echo"))
    monkeypatch.setattr(feed.search_mod, "search", fake_search)
    await feed.refresh()
    items = feed.list_items().items
    useful = items[0]
    assert feed.feedback(useful.id, "useful")
    assert feed.feedback(useful.id, "save")
    reopened = feed.get_item(useful.id)
    assert reopened is not None
    assert set(reopened.feedback) == {"useful", "save"}
    listed = next(item for item in feed.list_items().items if item.id == useful.id)
    assert set(listed.feedback) == {"useful", "save"}

    dismissible = items[-1]
    assert feed.feedback(dismissible.id, "dismiss")
    assert feed.get_item(dismissible.id) is None
    not_useful = next(item for item in items if item.id not in {useful.id, dismissible.id})
    assert feed.feedback(not_useful.id, "not_useful")
    assert feed.get_item(not_useful.id) is None
    assert not feed.feedback("f_missing", "dismiss")


async def test_library_delete_and_wipe_remove_derived_feed_data(monkeypatch):
    library.save(event("j_delete_one"))
    library.save(event("j_keep_one", performer="Harbor Echo"))
    monkeypatch.setattr(feed.search_mod, "search", fake_search)
    await feed.refresh()
    assert any("j_delete_one" in item.source_job_ids for item in feed.list_items().items)

    assert library.delete("j_delete_one")
    assert all("j_delete_one" not in item.source_job_ids for item in feed.list_items().items)

    library.wipe()
    assert feed.list_items().items == []
    conn = sqlite3.connect(library.db_path())
    try:
        assert conn.execute("SELECT count(*) FROM feed_suppressions").fetchone()[0] == 0
    finally:
        conn.close()


async def test_air_gap_blocks_discovery_without_leaking_summary(monkeypatch):
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-fake-feed-key")
    get_settings.cache_clear()
    library.save(event("j_private", summary="zebrasecret private local summary"))
    egress.clear_records()
    egress.set_offline(True)
    monkeypatch.setattr(
        egress,
        "_internet_client",
        lambda: (_ for _ in ()).throw(AssertionError("network client must not be opened")),
    )
    try:
        await feed.refresh()
    finally:
        egress.set_offline(None)
        get_settings.cache_clear()

    attempts = egress.records()
    assert attempts and all(record.blocked for record in attempts)
    assert all(record.reason == "offline mode" for record in attempts)
    assert all("zebrasecret" not in record.payload_preview for record in attempts)
    conn = sqlite3.connect(library.db_path())
    try:
        persisted_feed = " ".join(
            row[0] for row in conn.execute("SELECT detail_json FROM feed_items").fetchall()
        )
    finally:
        conn.close()
    assert "zebrasecret" not in persisted_feed
    discovery = next(item for item in feed.list_items().items if item.kind == "discovery")
    detail = feed.get_item(discovery.id)
    assert detail is not None
    assert detail.cards == []
    assert "air-gap" in detail.body.lower()
    assert any(item.kind == "follow_up" for item in feed.list_items().items)


async def test_online_discovery_uses_exact_query_and_creates_audit(monkeypatch, tmp_path):
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-fake-feed-key")
    monkeypatch.setattr(egress, "LOG_PATH", tmp_path / "egress.log")
    get_settings.cache_clear()
    egress.clear_records()
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "answer": "A related public festival.",
                "results": [
                    {
                        "title": "Harbor Light Festival",
                        "url": "https://events.example/harbor-light",
                        "content": "A public live music festival in Port Aurora.",
                        "score": 0.92,
                    }
                ],
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(egress, "_internet", client)
    library.save(event("j_audited", summary="zebrasecret private local summary"))
    try:
        await feed.refresh()
    finally:
        await client.aclose()
        get_settings.cache_clear()

    assert seen == [
        {
            "query": "Nova Fields similar events near Port Aurora",
            "topic": "general",
            "search_depth": "basic",
            "max_results": 5,
            "include_answer": True,
        }
    ]
    (record,) = egress.records()
    assert not record.blocked
    assert record.payload_preview == json.dumps(seen[0])
    assert "zebrasecret" not in record.payload_preview


async def test_mock_refresh_has_all_four_kinds_without_search(monkeypatch):
    monkeypatch.setenv("LATENT_MOCK", "1")
    get_settings.cache_clear()

    async def forbidden(*args, **kwargs):
        raise AssertionError("mock feed must not search")

    monkeypatch.setattr(feed.search_mod, "search", forbidden)
    try:
        await feed.refresh()
    finally:
        get_settings.cache_clear()
    assert {item.kind for item in feed.list_items().items} == {
        "discovery",
        "connection",
        "follow_up",
        "pattern",
    }


async def test_feed_api_refresh_detail_and_feedback(monkeypatch):
    library.save(event("j_api"))
    monkeypatch.setattr(feed.search_mod, "search", fake_search)
    client = TestClient(app)

    refreshed = client.post("/api/feed/refresh")
    assert refreshed.status_code == 202
    assert refreshed.json() == {"accepted": True}

    listed = client.get("/api/feed?limit=20")
    assert listed.status_code == 200
    payload = listed.json()
    assert payload["next_cursor"] is None
    assert len(payload["items"]) <= 20

    item_id = payload["items"][0]["id"]
    detail = client.get(f"/api/feed/{item_id}")
    assert detail.status_code == 200
    assert detail.json()["why"]

    assert (
        client.post(f"/api/feed/{item_id}/feedback", json={"action": "dismiss"}).status_code == 204
    )
    assert client.get(f"/api/feed/{item_id}").status_code == 404
    assert (
        client.post("/api/feed/f_missing/feedback", json={"action": "dismiss"}).status_code == 404
    )
    assert (
        client.post(
            f"/api/feed/{payload['items'][-1]['id']}/feedback",
            json={"action": "invalid"},
        ).status_code
        == 422
    )
