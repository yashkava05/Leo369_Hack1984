"""Folder-watch routes (issue #20): watcher status and a broadcast stream of new jobs."""

import json

from fastapi import APIRouter
from sse_starlette import EventSourceResponse

from app import watch

router = APIRouter()


@router.get("/watch")
async def get_watch() -> dict:
    return watch.status()


@router.get("/watch/events")
async def watch_events() -> EventSourceResponse:
    async def stream():
        async with watch.broadcaster.subscribe() as queue:
            while True:
                notice = await queue.get()
                yield {"event": "job", "data": json.dumps(notice)}

    return EventSourceResponse(stream(), ping=15)
