"""Which pipeline the backend runs (issue #15).

`GET /api/mode` tells the UI whether the backend replays fixtures (`LATENT_MOCK=1`). In mock
mode the local model is never called, so the UI keeps the drop zone enabled even when
`/api/health` reports Ollama down.
"""

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from app.config import get_settings

router = APIRouter()


class ModeState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mock: bool


@router.get("/mode")
async def get_mode() -> ModeState:
    return ModeState(mock=get_settings().latent_mock)
