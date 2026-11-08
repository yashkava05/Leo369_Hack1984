"""Phase-1 local memory routes: saved snapshots import + reset fence."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from app import jobs, library
from app.models import Card, IntentType

router = APIRouter()

# One Kept item holds one result's cards (a handful); the browser imports one item per request.
MAX_IMPORT_ITEMS = 200
MAX_CARDS_PER_ITEM = 50


class SavedImportItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=200)
    label: str = Field(min_length=1, max_length=200)
    intent_type: IntentType
    saved_at: float = Field(allow_inf_nan=False)
    cards: list[Card] = Field(max_length=MAX_CARDS_PER_ITEM)
    source_job_id: str | None = None


class SavedImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    memory_epoch: int | None = None
    items: list[SavedImportItem] = Field(max_length=MAX_IMPORT_ITEMS)


class SavedItemResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    intent_type: IntentType
    saved_at: float
    pinned: bool
    cards: list[dict]
    source_job_id: str | None = None


class SavedListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    memory_epoch: int
    items: list[SavedItemResponse]


@router.get("/saved")
def list_saved() -> SavedListResponse:
    epoch, items = library.list_saved_items()
    return SavedListResponse(
        memory_epoch=epoch,
        items=[
            SavedItemResponse(
                id=item.id,
                label=item.label,
                intent_type=item.intent_type,
                saved_at=item.created_at,
                pinned=item.pinned,
                cards=item.cards,
                source_job_id=item.source_job_id,
            )
            for item in items
        ],
    )


@router.post("/saved/import")
def import_saved(body: SavedImportRequest) -> dict:
    epoch, statuses, stale = library.import_saved_items(
        [
            library.SavedItem(
                id=item.id,
                created_at=item.saved_at,
                updated_at=item.saved_at,
                pinned=False,
                label=item.label,
                intent_type=item.intent_type,
                cards=[card.model_dump(mode="json") for card in item.cards],
                source_job_id=item.source_job_id,
            )
            for item in body.items
        ],
        client_epoch=body.memory_epoch,
    )
    if stale:
        raise HTTPException(409, detail={"code": "stale_epoch", "memory_epoch": epoch})
    return {"memory_epoch": epoch, "results": statuses}


@router.post("/saved/{saved_id}/pin")
def pin_saved(
    saved_id: str, pinned: bool = Query(True), memory_epoch: int | None = Query(None)
) -> dict:
    epoch, updated, stale = library.set_saved_item_pin(
        saved_id, pinned=pinned, client_epoch=memory_epoch
    )
    if stale:
        raise HTTPException(409, detail={"code": "stale_epoch", "memory_epoch": epoch})
    if not updated:
        raise HTTPException(404, "saved item not found")
    return {"memory_epoch": epoch, "pinned": pinned}


@router.delete("/saved/{saved_id}", status_code=204)
def delete_saved(saved_id: str, memory_epoch: int | None = Query(None)) -> None:
    epoch, _deleted, stale = library.delete_saved_item(saved_id, client_epoch=memory_epoch)
    if stale:
        raise HTTPException(409, detail={"code": "stale_epoch", "memory_epoch": epoch})


@router.get("/memory/summary")
def get_memory_summary() -> dict[str, int]:
    return library.memory_summary()


@router.delete("/memory")
async def delete_all_local_data(confirm: str = Query("")) -> dict:
    ok, epoch = await asyncio.to_thread(library.delete_all_local_data, confirm=confirm)
    if not ok:
        raise HTTPException(
            400,
            "confirmation required: DELETE_ALL_LOCAL_DATA"
            " (saved items, library history, FTS index, Muse feed and preferences)",
        )
    generation = await asyncio.to_thread(library.current_generation)
    cancelled = []
    for job in list(jobs.JOBS.values()):
        if job.memory_generation >= generation:
            continue  # A job started after the reset belongs to the new memory generation.
        if job.task is not None and not job.task.done():
            job.task.cancel()
            cancelled.append(job.task)
        jobs.JOBS.pop(job.job_id, None)
    await asyncio.gather(*cancelled, return_exceptions=True)
    jobs.EGRESS_LOG.clear()
    return {
        "memory_epoch": epoch,
        "message": "Local app memory cleared; browser Kept copies must sync.",
    }
