"""In-memory job store with per-job event replay, plus the fixture-backed mock pipeline."""

import asyncio
import json
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
    # pydantic-settings reads LATENT_MOCK from the process env first, then from .env.
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


# Finished jobs are dropped once their last event is older than this.
JOB_TTL_SECONDS = 30 * 60


def cleanup_finished(max_age_s: float = JOB_TTL_SECONDS) -> None:
    """Drop finished jobs whose last event is older than max_age_s."""
    now = time.time()
    for job_id, job in list(JOBS.items()):
        if job.finished and job.events and now - job.events[-1].ts > max_age_s:
            del JOBS[job_id]


def start_job(job: JobState, filename: str | None, image_bytes: bytes | None = None) -> None:
    if mock_enabled():
        runner = run_mock(job, pick_fixture(filename))
    else:
        # Real mode: run the full pipeline in the background and return 202 immediately.
        from app.pipeline.runner import run_job

        runner = run_job(job.job_id, image_bytes or b"", filename or "")
    job.task = asyncio.create_task(runner)


def offline_replay(
    events: list[StageEvent], result: JobResult
) -> tuple[list[StageEvent], JobResult]:
    """Air-gap variant of a fixture: local stages unchanged, every search request blocked."""
    blocked = [
        r.model_copy(update={"blocked": True, "reason": "offline mode"}) for r in result.egress
    ]
    local_part = [e for e in events if e.stage in ("ingest", "extract", "scrub", "query")]
    base = local_part[-1] if local_part else events[0]

    def make(stage, status, message, local, data=None) -> StageEvent:
        return base.model_copy(
            update={
                "stage": stage,
                "status": status,
                "message": message,
                "local": local,
                "data": data,
            }
        )

    out = list(local_part)
    out.append(make("search", "start", "search: air-gap on, nothing may leave this device", False))
    for r in blocked:
        target = f"{r.method} {r.host}{r.path}"
        out.append(
            make(
                "search",
                "error",
                f"network ✕ blocked {target} · {r.bytes_out} bytes · {r.reason}",
                False,
                {
                    "host": r.host,
                    "path": r.path,
                    "bytes_out": r.bytes_out,
                    "blocked": True,
                    "reason": r.reason,
                },
            )
        )
    out.append(
        make("search", "ok", "search: 0 results, every request blocked (offline mode)", False)
    )
    out.append(make("cards", "ok", "cards: built 0 cards (search blocked)", True))
    out.append(make("done", "ok", f"done: 0 cards, 0 network calls, {len(blocked)} blocked", True))
    out = [e.model_copy(update={"seq": i}) for i, e in enumerate(out)]
    return out, result.model_copy(update={"cards": [], "egress": blocked})


async def run_mock(job: JobState, fixture: str) -> None:
    events, fixture_result = load_fixture(fixture)
    from app import egress  # local import: egress imports jobs lazily too

    if egress.is_offline():
        events, fixture_result = offline_replay(events, fixture_result)
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
            from app import library  # local intent library (issue #21)

            library.save_quietly(result)
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
