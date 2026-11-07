"""FastAPI entrypoint: `uvicorn app.main:app --reload --port 8000` from `backend/`."""

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import router as pipeline_router
from app.config import get_settings

settings = get_settings()

app = FastAPI(title="Latent", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

api = APIRouter(prefix="/api")


@api.get("/health")
def health() -> dict:
    # Temporary static body; the Ollama setup issue replaces it with real checks.
    return {"status": "ok", "ollama": "unchecked", "model": None, "tavily_key": False}


app.include_router(api)
app.include_router(pipeline_router, prefix="/api")
