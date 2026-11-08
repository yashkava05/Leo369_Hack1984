"""Local intent library routes (issue #21), mounted under /api.

Plain `def` handlers: FastAPI runs them in its threadpool, so SQLite never blocks the loop.
"""

from fastapi import APIRouter, HTTPException, Query, Response

from app import library
from app.models import IntentType, JobResult

router = APIRouter()


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
