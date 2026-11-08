"""Finite Muse feed routes, mounted under /api."""

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict

from app import feed

router = APIRouter()


class FeedbackRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: feed.FeedFeedbackAction


@router.get("/feed")
def list_feed(
    limit: Annotated[int, Query(ge=1, le=feed.MAX_FEED_ITEMS)] = feed.MAX_FEED_ITEMS,
    cursor: str | None = None,
) -> feed.FeedResponse:
    # V1 is intentionally finite. A cursor is accepted for forward compatibility, but there is
    # no next page and therefore no infinite-scroll path.
    del cursor
    return feed.list_items(limit)


@router.get("/feed/{item_id}")
def get_feed_item(item_id: str) -> feed.FeedItemDetail:
    item = feed.get_item(item_id)
    if item is None:
        raise HTTPException(404, "feed item not found")
    return item


@router.post("/feed/{item_id}/feedback", status_code=204)
def feed_feedback(item_id: str, request: FeedbackRequest) -> Response:
    if not feed.feedback(item_id, request.action):
        raise HTTPException(404, "feed item not found")
    return Response(status_code=204)


@router.post("/feed/refresh", status_code=202)
async def refresh_feed() -> dict[str, bool]:
    await feed.refresh()
    return {"accepted": True}
