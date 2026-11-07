"""Local Ollama checks: the live /api/health report and the startup warm-up."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

HEALTH_TIMEOUT_S = 2.0
# The first load of a vision model on CPU can take minutes.
WARMUP_TIMEOUT_S = 300.0
KEEP_ALIVE = "30m"


def _canonical(name: str) -> str:
    """Ollama stores untagged names as `<name>:latest`."""
    return name if ":" in name else f"{name}:latest"


def _has_model(payload: dict[str, Any], model: str) -> bool:
    wanted = _canonical(model)
    for entry in payload.get("models") or []:
        names = {entry.get("name"), entry.get("model")}
        if wanted in {_canonical(n) for n in names if isinstance(n, str)}:
            return True
    return False


async def _get_json(client: httpx.AsyncClient, url: str) -> dict[str, Any] | None:
    try:
        resp = await client.get(url, timeout=HEALTH_TIMEOUT_S)
        resp.raise_for_status()
        data = resp.json()
    except (httpx.HTTPError, ValueError):
        return None
    return data if isinstance(data, dict) else None


async def check_health(
    client: httpx.AsyncClient, host: str, model: str, tavily_key_present: bool
) -> dict[str, Any]:
    """Build the /api/health body. Never raises when Ollama is down or misbehaving.

    status is "ok" when Ollama answers and the configured model is pulled;
    model_loaded reports whether it is currently in memory (GET /api/ps).
    """
    host = host.rstrip("/")
    version, tags, ps = await asyncio.gather(
        _get_json(client, f"{host}/api/version"),
        _get_json(client, f"{host}/api/tags"),
        _get_json(client, f"{host}/api/ps"),
    )
    up = version is not None
    pulled = up and tags is not None and _has_model(tags, model)
    loaded = up and ps is not None and _has_model(ps, model)
    return {
        "status": "ok" if pulled else "degraded",
        "ollama": "up" if up else "down",
        "model": model if pulled else None,
        "model_loaded": loaded,
        "tavily_key": tavily_key_present,
    }


async def warm_up(client: httpx.AsyncClient, host: str, model: str) -> bool:
    """Load the model into memory with a one-word chat so the first screenshot is fast."""
    body = {
        "model": model,
        "messages": [{"role": "user", "content": "hi"}],
        "stream": False,
        "keep_alive": KEEP_ALIVE,
    }
    try:
        resp = await client.post(
            f"{host.rstrip('/')}/api/chat", json=body, timeout=WARMUP_TIMEOUT_S
        )
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        log.warning("model warm-up for %s failed: %s", model, type(exc).__name__)
        return False
    log.info("model %s warmed up (keep_alive %s)", model, KEEP_ALIVE)
    return True
