"""In-memory job store with per-job event replay, plus the fixture-backed mock pipeline."""

import asyncio
import json
import os
import random
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from app.config import get_settings
from app.models import EgressRecord, JobResult, StageEvent

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"
FIXTURE_NAMES = ("concert_flyer", "sensitive_doc")
TERMINAL_STAGES = ("done", "error")

# Gap between replayed mock events, in seconds. Tests shrink this.
MOCK_DELAY_RANGE: tuple[float, float] = (0.3, 0.7)


def mock_enabled() -> bool:
    # A live LATENT_MOCK env var wins so it can be toggled per process (and in tests);
    # otherwise fall back to the value loaded from .env.
    raw = os.getenv("LATENT_MOCK")
    if raw is not None:
        return raw.strip().lower() in ("1", "true", "yes", "on")
    return get_settings().latent_mock


@dataclass
class JobState:
    job_id: str
    result: JobResult
    events: list[StageEvent] = field(default_factory=list)
    changed: asyncio.Condition = field(default_factory=asyncio.Condition)
    task: asyncio.Task | None = None

    @property
    def finished(self) -> bool:
        return bool(self.events) and self.events[-1].stage in TERMINAL_STAGES

    async def publish(self, event: StageEvent) -> None:
        async with self.changed:
            self.events.append(event)
            self.changed.notify_all()

    async def stream(self):
        """Yield every event from seq 0, then live ones, until a terminal event."""
        idx = 0
        while True:
            async with self.changed:
                await self.changed.wait_for(lambda i=idx: i < len(self.events))
                pending = self.events[idx:]
            for event in pending:
                idx += 1
                yield event
                if event.stage in TERMINAL_STAGES:
                    return


JOBS: dict[str, JobState] = {}
EGRESS_LOG: list[EgressRecord] = []  # whole session, oldest first


def new_job_id() -> str:
    return "j_" + uuid.uuid4().hex[:10]


def create_job() -> JobState:
    job_id = new_job_id()
    job = JobState(job_id=job_id, result=JobResult(job_id=job_id, status="running"))
    JOBS[job_id] = job
    return job


def get_job(job_id: str) -> JobState | None:
    return JOBS.get(job_id)


def egress_newest_first() -> list[EgressRecord]:
    return sorted(EGRESS_LOG, key=lambda r: r.ts, reverse=True)


def load_fixture(name: str) -> tuple[list[StageEvent], JobResult]:
    events = json.loads((FIXTURES_DIR / f"{name}.events.json").read_text())
    result = json.loads((FIXTURES_DIR / f"{name}.result.json").read_text())
    return [StageEvent.model_validate(e) for e in events], JobResult.model_validate(result)


def pick_fixture(filename: str | None) -> str:
    return "sensitive_doc" if "doc" in (filename or "").lower() else "concert_flyer"


def start_job(job: JobState, filename: str | None) -> None:
    runner = run_mock(job, pick_fixture(filename)) if mock_enabled() else run_unimplemented(job)
    job.task = asyncio.create_task(runner)


async def run_mock(job: JobState, fixture: str) -> None:
    events, fixture_result = load_fixture(fixture)
    now = time.time()
    result = fixture_result.model_copy(
        update={
            "job_id": job.job_id,
            "egress": [
                r.model_copy(update={"id": f"{r.id}_{job.job_id}", "ts": now + i * 0.1})
                for i, r in enumerate(fixture_result.egress)
            ],
        }
    )
    for i, event in enumerate(events):
        if i:
            await asyncio.sleep(random.uniform(*MOCK_DELAY_RANGE))
        update = {"job_id": job.job_id, "ts": time.time()}
        if event.stage == "done":
            job.result = result
            EGRESS_LOG.extend(result.egress)
            update["data"] = result.model_dump(mode="json")
        await job.publish(event.model_copy(update=update))


async def run_unimplemented(job: JobState) -> None:
    # Real stages land in later issues behind this same shape.
    message = "pipeline not implemented yet; start the backend with LATENT_MOCK=1"
    job.result = job.result.model_copy(update={"status": "error", "error": message})
    await job.publish(
        StageEvent(
            job_id=job.job_id,
            seq=0,
            ts=time.time(),
            stage="error",
            status="error",
            message=f"error: {message}",
            local=True,
            data=None,
        )
    )
