"""Every fixture must load through the Pydantic contract, and the frontend copies must match."""

import json
from pathlib import Path

import pytest

from app.models import FeedItem, FeedItemDetail, FeedResponse, JobResult, StageEvent

BACKEND = Path(__file__).resolve().parent.parent
FIXTURES = BACKEND / "fixtures"
FRONTEND_FIXTURES = BACKEND.parent / "frontend" / "src" / "api" / "fixtures"
NAMES = ["concert_flyer", "sensitive_doc"]


def load(name: str, kind: str):
    return json.loads((FIXTURES / f"{name}.{kind}.json").read_text())


@pytest.mark.parametrize("name", NAMES)
def test_events_validate(name):
    events = [StageEvent.model_validate(e) for e in load(name, "events")]
    assert [e.seq for e in events] == list(range(len(events)))
    assert len({e.job_id for e in events}) == 1
    assert events[-1].stage == "done" and events[-1].status == "ok"
    assert all(e.stage not in ("done", "error") for e in events[:-1])
    assert [e.ts for e in events] == sorted(e.ts for e in events)


@pytest.mark.parametrize("name", NAMES)
def test_result_validates_and_matches_done_event(name):
    result = JobResult.model_validate(load(name, "result"))
    assert result.status == "done"
    assert result.intent is not None
    assert len(result.intent.summary) <= 140
    assert 0 <= result.intent.confidence <= 1
    assert all(len(c.snippet or "") <= 240 for c in result.cards)
    assert all(len(r.payload_preview) <= 300 for r in result.egress)
    done = StageEvent.model_validate(load(name, "events")[-1])
    assert JobResult.model_validate(done.data) == result
    assert result.job_id == done.job_id


def test_scenario_shapes():
    concert = JobResult.model_validate(load("concert_flyer", "result"))
    assert concert.intent.intent_type == "event"
    assert [c.kind for c in concert.cards] == [
        "tickets",
        "calendar",
        "place",
        "insight",
    ]
    doc = JobResult.model_validate(load("sensitive_doc", "result"))
    assert doc.intent.intent_type == "document"
    assert sum(doc.intent.redaction_counts.values()) >= 10
    assert {c.kind for c in doc.cards} <= {"insight", "link"}


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize("kind", ["events", "result"])
def test_frontend_copy_matches(name, kind):
    copy = FRONTEND_FIXTURES / f"{name}.{kind}.json"
    assert json.loads(copy.read_text()) == load(name, kind)


def test_models_forbid_extra_fields():
    data = load("concert_flyer", "result")
    data["unexpected"] = 1
    with pytest.raises(ValueError):
        JobResult.model_validate(data)


def test_feed_contract_fixture_matches_frontend_copy():
    backend = json.loads((FIXTURES / "feed.result.json").read_text())
    frontend = json.loads((FRONTEND_FIXTURES / "feed.result.json").read_text())
    assert frontend == backend

    details = [FeedItemDetail.model_validate(item) for item in backend]
    response = FeedResponse(
        items=[
            FeedItem.model_validate(detail.model_dump(exclude={"body", "sources", "cards"}))
            for detail in details
        ],
        generated_at=1794088800,
    )
    assert {item.kind for item in response.items} == {
        "discovery",
        "connection",
        "follow_up",
        "pattern",
    }
    assert response.next_cursor is None


def test_feed_contract_forbids_extra_fields():
    data = json.loads((FIXTURES / "feed.result.json").read_text())[0]
    data["unexpected"] = 1
    with pytest.raises(ValueError):
        FeedItemDetail.model_validate(data)
