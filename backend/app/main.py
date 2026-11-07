"""FastAPI entrypoint: `uvicorn app.main:app --reload --port 8000` from `backend/`."""

import asyncio
from contextlib import asynccontextmanager

import httpx
from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app import ollama
from app.config import Settings, get_settings

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.settings = get_settings()
    app.state.http = httpx.AsyncClient()
    warmup = None
    if not app.state.settings.latent_mock:
        # Load the vision model in the background so the first screenshot isn't slow.
        warmup = asyncio.create_task(
            ollama.warm_up(
                app.state.http, app.state.settings.ollama_host, app.state.settings.latent_model
            )
        )
    try:
        yield
    finally:
        if warmup is not None:
            warmup.cancel()
            await asyncio.gather(warmup, return_exceptions=True)
        await app.state.http.aclose()


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
async def health(request: Request) -> dict:
    s: Settings = request.app.state.settings
    return await ollama.check_health(
        request.app.state.http,
        s.ollama_host,
        s.latent_model,
        tavily_key_present=bool(s.tavily_api_key.strip()),
    )


app.include_router(api)
