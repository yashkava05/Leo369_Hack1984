"""Local intent library routes (issue #21), mounted under /api.

Plain `def` handlers: FastAPI runs them in its threadpool, so SQLite never blocks the loop.
"""

from pydantic import BaseModel, ConfigDict, Field

from fastapi import APIRouter, HTTPException, Query, Response

from app import library
from app.models import IntentType, JobResult

router = APIRouter()


class CleanupExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    candidate_ids: list[str] | None = Field(default=None, max_length=5000)


@router.get("/library/cache/cleanup-preview")
def preview_cleanup() -> library.CacheCleanupPreview:
    return library.cleanup_preview()


@router.post("/library/cache/cleanup")
def execute_cleanup(body: CleanupExecuteRequest | None = None) -> library.CacheCleanupResult:
    return library.execute_cleanup(None if body is None else body.candidate_ids)


@router.post("/library/{job_id}/saved", status_code=204)
def set_saved(
    job_id: str,
    saved: bool = Query(True),
    pinned: bool = Query(False),
) -> Response:
    if not library.mark_saved(job_id, saved=saved, pinned=pinned):
        raise HTTPException(404, "not in the library")
    return Response(status_code=204)


@router.delete("/library/interests/{topic}", status_code=204)
def forget_interest(topic: str) -> Response:
    library.forget_interest(topic)
    return Response(status_code=204)


@router.delete("/library/all-local-data", status_code=204)
def wipe_all_local_data(confirm: str = Query("")) -> Response:
    if not library.wipe_all_local_data(confirm):
        raise HTTPException(400, "confirmation required")
    return Response(status_code=204)


@router.get("/library")
def list_library(
    q: str = Query("", max_length=200),
    type: IntentType | None = None,  # noqa: A002 - the contract's query parameter name
    limit: int = Query(library.DEFAULT_LIMIT, ge=1, le=library.MAX_LIMIT),
) -> list[library.LibraryItem]:
    return library.search(q, type, limit)


@router.get("/library/{job_id}")
def get_library_item(job_id: str) -> JobResult:
    result = library.get(job_id)
    if result is None:
        raise HTTPException(404, "not in the library")
    return result


@router.delete("/library/{job_id}", status_code=204)
def delete_library_item(job_id: str) -> Response:
    library.delete(job_id)  # idempotent: deleting a missing id is still 204
    return Response(status_code=204)


@router.delete("/library", status_code=204)
def wipe_library() -> Response:
    library.wipe()
    return Response(status_code=204)
