"""Runtime air-gap toggle (issue #16).

Reads and writes the egress guard's runtime offline flag so the UI can cut all internet
egress live. The flag itself and rule 1 live in `app.egress` (owned by the egress guard);
these routes only call the existing `is_offline` / `set_offline` helpers.
"""

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from app import egress

router = APIRouter()


class OfflineState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    offline: bool


@router.get("/offline")
async def get_offline() -> OfflineState:
    return OfflineState(offline=egress.is_offline())


@router.post("/offline")
async def post_offline(state: OfflineState) -> OfflineState:
    egress.set_offline(state.offline)
    return OfflineState(offline=egress.is_offline())
