"""HTTP routes for the pipeline contract, mounted under /api."""

from fastapi import APIRouter, HTTPException, UploadFile
from sse_starlette import EventSourceResponse

from app import jobs
from app.models import EgressRecord, JobResult

MAX_IMAGE_BYTES = 10 * 1024 * 1024
ALLOWED_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/webp"}
MAGIC = (b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff")

router = APIRouter()


def _looks_like_image(head: bytes) -> bool:
    is_webp = head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    return is_webp or head.startswith(MAGIC)


@router.post("/analyze", status_code=202)
async def analyze(image: UploadFile) -> dict[str, str]:
    data = await image.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "image larger than 10 MB")
    if (image.content_type or "").lower() not in ALLOWED_TYPES or not _looks_like_image(data[:12]):
        raise HTTPException(415, "image must be png, jpg or webp")
    job = jobs.create_job()
    jobs.start_job(job, image.filename)
    return {"job_id": job.job_id}


def _job_or_404(job_id: str) -> jobs.JobState:
    job = jobs.get_job(job_id)
    if job is None:
        raise HTTPException(404, "unknown job id")
    return job


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: str) -> EventSourceResponse:
    job = _job_or_404(job_id)

    async def stream():
        async for event in job.stream():
            yield {"event": "stage", "data": event.model_dump_json()}

    return EventSourceResponse(stream(), ping=15)


@router.get("/jobs/{job_id}")
async def get_job(job_id: str) -> JobResult:
    return _job_or_404(job_id).result


@router.get("/egress")
async def get_egress() -> list[EgressRecord]:
    return jobs.egress_newest_first()
