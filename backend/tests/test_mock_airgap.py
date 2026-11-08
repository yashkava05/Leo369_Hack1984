"""Mock mode honours the air-gap switch: local stages finish, every search request is blocked."""

import pytest
from fastapi.testclient import TestClient

from app import egress, jobs
from app.config import get_settings
from app.main import app
from app.models import JobResult, StageEvent

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.delenv("LATENT_OFFLINE", raising=False)
    monkeypatch.setenv("LATENT_MOCK", "1")
    monkeypatch.setattr(egress, "LOG_PATH", tmp_path / "egress.log")
    monkeypatch.setattr(jobs, "MOCK_DELAY_RANGE", (0.01, 0.02))
    get_settings.cache_clear()
    egress.set_offline(None)
    jobs.EGRESS_LOG.clear()
    with TestClient(app) as c:
        yield c
    egress.set_offline(None)
    jobs.EGRESS_LOG.clear()
    get_settings.cache_clear()


def run(client, filename):
    resp = client.post("/api/analyze", files={"image": (filename, PNG, "image/png")})
    events = []
    with client.stream("GET", f"/api/jobs/{resp.json()['job_id']}/events") as stream:
        for line in stream.iter_lines():
            if line.startswith("data:"):
                events.append(StageEvent.model_validate_json(line.split(":", 1)[1].strip()))
    return events


def test_offline_blocks_search_then_finishes(client):
    client.post("/api/offline", json={"offline": True})
    events = run(client, "doc_internal_email.png")

    assert [e.seq for e in events] == list(range(len(events)))
    stages = [e.stage for e in events]
    assert stages[0] == "ingest" and stages[-1] == "done"
    assert {"extract", "scrub", "query"} <= set(stages)  # local work still completes
    blocked = [e for e in events if e.data and e.data.get("blocked")]
    assert len(blocked) == 2
    assert all(
        e.stage == "search" and not e.local and e.data["reason"] == "offline mode" for e in blocked
    )

    result = JobResult.model_validate(events[-1].data)
    assert result.status == "done" and result.cards == []
    assert result.egress and all(r.blocked and r.reason == "offline mode" for r in result.egress)
    audit = client.get("/api/egress").json()
    assert {r["id"] for r in audit} >= {r.id for r in result.egress}


def test_online_replays_fixture_unchanged(client):
    client.post("/api/offline", json={"offline": False})
    result = JobResult.model_validate(run(client, "flyer.png")[-1].data)
    assert result.cards and result.egress and not any(r.blocked for r in result.egress)
