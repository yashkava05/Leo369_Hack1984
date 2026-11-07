"""FastAPI entrypoint: `uvicorn app.main:app --reload --port 8000` from `backend/`."""

from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import egress
from app.api import router as pipeline_router
from app.config import get_settings

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    egress.local_host()  # refuse to start if OLLAMA_HOST is not loopback
    try:
        yield
    finally:
        await egress.aclose()


app = FastAPI(title="Latent", version="0.1.0", lifespan=lifespan)

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
