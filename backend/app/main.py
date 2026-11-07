"""FastAPI entrypoint: `uvicorn app.main:app --reload --port 8000` from `backend/`."""

import asyncio
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import egress, ollama
from app.api import router as pipeline_router
from app.config import get_settings
from app.pipeline import scrub

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    egress.local_host()  # refuse to start if OLLAMA_HOST is not loopback
    current = get_settings()
    warmup = None
    if not current.latent_mock:
        # Load the vision model in the background so the first screenshot isn't slow.
        warmup = asyncio.create_task(ollama.warm_up(egress.local_client(), current.latent_model))
        # The PII analyzer loads a spaCy model (a few seconds); mock mode never scrubs.
        await asyncio.to_thread(scrub.warm_up)
    try:
        yield
    finally:
        if warmup is not None:
            warmup.cancel()
            await asyncio.gather(warmup, return_exceptions=True)
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
async def health() -> dict:
    current = get_settings()
    return await ollama.check_health(
        egress.local_client(),
        current.latent_model,
        tavily_key_present=bool(current.tavily_api_key.strip()),
    )


app.include_router(api)
app.include_router(pipeline_router, prefix="/api")
