"""Mock-mode HTTP behaviour: upload, SSE replay, job lookup, egress, and upload limits."""

import json
import time

import pytest
from fastapi.testclient import TestClient

from app import jobs
from app.main import app
from app.models import JobResult, StageEvent

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("LATENT_MOCK", "1")
    monkeypatch.setattr(jobs, "MOCK_DELAY_RANGE", (0.01, 0.02))
    with TestClient(app) as c:
        yield c


def read_stage_events(client, job_id):
    events = []
    with client.stream("GET", f"/api/jobs/{job_id}/events") as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        name = None
        for line in resp.iter_lines():
            if line.startswith("event:"):
                name = line.split(":", 1)[1].strip()
            elif line.startswith("data:") and name == "stage":
                events.append(StageEvent.model_validate_json(line.split(":", 1)[1].strip()))
    return events


def upload(client, filename="flyer.png", body=PNG, content_type="image/png"):
    return client.post("/api/analyze", files={"image": (filename, body, content_type)})


@pytest.mark.parametrize(
    ("filename", "fixture"),
    [("flyer.png", "concert_flyer"), ("bank_doc.png", "sensitive_doc")],
)
def test_mock_stream_replays_fixture(client, filename, fixture):
    resp = upload(client, filename)
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]
    events = read_stage_events(client, job_id)
    expected = json.loads((jobs.FIXTURES_DIR / f"{fixture}.events.json").read_text())
    assert [(e.seq, e.stage, e.message) for e in events] == [
        (e["seq"], e["stage"], e["message"]) for e in expected
    ]
    assert all(e.job_id == job_id for e in events)
    result = JobResult.model_validate(events[-1].data)
    assert result.job_id == job_id and result.status == "done"
    assert client.get(f"/api/jobs/{job_id}").json() == result.model_dump(mode="json")


def test_late_subscriber_gets_every_event(client):
    job_id = upload(client).json()["job_id"]
    time.sleep(0.5)  # fixture has finished replaying by now
    events = read_stage_events(client, job_id)
    assert [e.seq for e in events] == list(range(len(events)))
    assert events[-1].stage == "done"


def test_job_status_running_then_done(client):
    job_id = upload(client).json()["job_id"]
    assert client.get(f"/api/jobs/{job_id}").json()["status"] == "running"
    read_stage_events(client, job_id)
    assert client.get(f"/api/jobs/{job_id}").json()["status"] == "done"


def test_egress_newest_first(client):
    first = upload(client).json()["job_id"]
    read_stage_events(client, first)
    second = upload(client, "doc.png").json()["job_id"]
    read_stage_events(client, second)
    records = client.get("/api/egress").json()
    assert len(records) >= 4
    assert [r["ts"] for r in records] == sorted((r["ts"] for r in records), reverse=True)
    assert records[0]["id"].endswith(second)


def test_unknown_job_404(client):
    assert client.get("/api/jobs/j_nope").status_code == 404
    assert client.get("/api/jobs/j_nope/events").status_code == 404


def test_unsupported_type_415(client):
    assert upload(client, "notes.txt", b"hello", "text/plain").status_code == 415
    assert upload(client, "fake.png", b"not really a png", "image/png").status_code == 415


def test_too_large_413(client):
    big = PNG + b"\x00" * (10 * 1024 * 1024)
    assert upload(client, body=big).status_code == 413


def test_without_mock_job_ends_in_error(client, monkeypatch):
    monkeypatch.setenv("LATENT_MOCK", "0")
    job_id = upload(client).json()["job_id"]
    events = read_stage_events(client, job_id)
    assert [e.stage for e in events] == ["error"]
    assert client.get(f"/api/jobs/{job_id}").json()["status"] == "error"
