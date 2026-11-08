"""FastAPI entrypoint: `uvicorn app.main:app --reload --port 8000` from `backend/`."""

import asyncio
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import egress, ollama, watch
from app.api import router as pipeline_router
from app.config import get_settings
from app.pipeline import scrub
from app.routes.library import router as library_router
from app.routes.mode import router as mode_router
from app.routes.offline import router as offline_router
from app.routes.voice import router as voice_router
from app.routes.watch import router as watch_router

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
    watch.start(asyncio.get_running_loop())  # opt-in: no-op unless LATENT_WATCH_DIR is set
    try:
        yield
    finally:
        await asyncio.to_thread(watch.stop)
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
app.include_router(offline_router, prefix="/api")
app.include_router(mode_router, prefix="/api")
app.include_router(watch_router, prefix="/api")
app.include_router(library_router, prefix="/api")
app.include_router(voice_router, prefix="/api")
