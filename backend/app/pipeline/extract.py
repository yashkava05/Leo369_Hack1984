"""Screenshot -> Intent with the local vision model (qwen2.5vl via Ollama).

Nothing here touches the internet: the image is preprocessed in memory and sent only to
OLLAMA_HOST through egress.local_client(). Private content is reported by the model as counts
only; `scrub.py` re-checks the result afterwards.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import time
from collections.abc import Awaitable, Callable

import httpx
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import ValidationError

from app import egress
from app.config import get_settings
from app.models import Entity, Intent
from app.pipeline.image_links import ScreenshotIntent, native_image_links
from app.pipeline.prompts import (
    REDACTION_CATEGORIES,
    RETRY_PROMPT,
    SYSTEM_PROMPT,
    USER_PROMPT,
)

log = logging.getLogger(__name__)

# emit(stage, status, message). The job runner stamps these events local=True.
Emit = Callable[[str, str, str], Awaitable[None]]

STAGE = "extract"
MAX_SIDE_PX = 1280  # text stays legible, latency drops a lot
MIN_SIDE_PX = 64
OLLAMA_TIMEOUT_S = 90.0
KEEP_ALIVE = "30m"
CHAT_PATH = "/api/chat"  # relative to egress.local_client().base_url (loopback-validated)
MAX_ENTITIES = 12
MAX_ENTITY_CHARS = 80
MAX_SUMMARY_CHARS = 140
MAX_RETRY_ERROR_CHARS = 1000

FALLBACK_INTENT = Intent(
    intent_type="other",
    summary="Could not read this screenshot",
    public_entities=[],
    redaction_counts={},
    confidence=0,
)


class ImageRejected(ValueError):
    """The upload is not a decodable image, or is too small to read."""


class ModelOutputInvalid(ValueError):
    """The model's reply did not contain a valid Intent."""


def preprocess(image_bytes: bytes) -> tuple[bytes, tuple[int, int]]:
    """Decode, fix orientation, downscale to <= MAX_SIDE_PX and re-encode as metadata-free PNG."""
    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            img = ImageOps.exif_transpose(img)
            img = img.convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ImageRejected(f"not a readable image ({type(exc).__name__})") from exc
    if min(img.size) < MIN_SIDE_PX:
        raise ImageRejected(f"image too small ({img.width}×{img.height}, min {MIN_SIDE_PX} px)")
    if max(img.size) > MAX_SIDE_PX:
        img.thumbnail((MAX_SIDE_PX, MAX_SIDE_PX), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    # A fresh RGB image written without exif/pnginfo carries no EXIF, GPS or text chunks.
    img.save(out, format="PNG", optimize=True)
    return out.getvalue(), img.size


def _chat_body(model: str, png_b64: str, user_text: str) -> dict:
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_text, "images": [png_b64]},
        ],
        "format": ScreenshotIntent.model_json_schema(),
        "options": {"temperature": 0},
        "stream": False,
        "keep_alive": KEEP_ALIVE,
    }


async def _ask(client: httpx.AsyncClient, body: dict) -> Intent:
    resp = await client.post(CHAT_PATH, json=body, timeout=OLLAMA_TIMEOUT_S)
    resp.raise_for_status()
    try:
        content = resp.json()["message"]["content"]
    except (ValueError, KeyError, TypeError) as exc:
        raise ModelOutputInvalid(f"reply has no message.content ({type(exc).__name__})") from exc
    if not isinstance(content, str):
        raise ModelOutputInvalid("message.content is not a string")
    try:
        return ScreenshotIntent.model_validate_json(content)
    except ValidationError as exc:
        raise ModelOutputInvalid(str(exc)) from exc


def clamp(intent: Intent) -> Intent:
    """Enforce the contract's soft limits on whatever the model returned."""
    entities: list[Entity] = []
    seen: set[str] = set()
    for ent in intent.public_entities:
        value = " ".join(ent.value.split())
        key = value.casefold()
        if not value or len(value) > MAX_ENTITY_CHARS or key in seen:
            continue
        seen.add(key)
        entities.append(Entity(type=ent.type, value=value))
        if len(entities) == MAX_ENTITIES:
            break

    counts: dict[str, int] = {}
    for category, n in intent.redaction_counts.items():
        if n <= 0:
            continue
        # Unknown keys are folded into "other": a key is free text and could carry private data.
        key = category if category in REDACTION_CATEGORIES else "other"
        counts[key] = counts.get(key, 0) + n

    summary = " ".join(intent.summary.split())
    if len(summary) > MAX_SUMMARY_CHARS:
        summary = summary[: MAX_SUMMARY_CHARS - 1].rstrip() + "…"

    model = ScreenshotIntent if isinstance(intent, ScreenshotIntent) else Intent
    links = {"visible_links": intent.visible_links} if isinstance(intent, ScreenshotIntent) else {}
    return model(
        **links,
        intent_type=intent.intent_type,
        summary=summary,
        public_entities=entities,
        redaction_counts=counts,
        confidence=min(max(intent.confidence, 0.0), 1.0),
    )


def _count(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


async def extract_intent(image_bytes: bytes, emit: Emit) -> Intent:
    """Return the screenshot's Intent using only the local model.

    Raises ImageRejected for unreadable or tiny images, and httpx errors (including a 90 s
    timeout) when Ollama cannot be reached; an "error" event is emitted first in both cases.
    Malformed model output is retried once, then degrades to FALLBACK_INTENT without raising.
    """
    settings = get_settings()
    started = time.perf_counter()

    try:
        png, (width, height) = preprocess(image_bytes)
    except ImageRejected as exc:
        await emit(STAGE, "error", f"Could not read image: {exc}")
        raise
    await emit(STAGE, "start", f"Reading image on-device ({width}×{height}, metadata stripped)")

    png_b64 = base64.b64encode(png).decode("ascii")
    await emit(STAGE, "progress", f"Running {settings.latent_model} locally…")

    intent: Intent | None = None
    # Shared client owned by egress (closed by egress.aclose() at shutdown); never close it here.
    client = egress.local_client()
    user_text = USER_PROMPT
    for attempt in (1, 2):
        try:
            intent = await _ask(client, _chat_body(settings.latent_model, png_b64, user_text))
            break
        except ModelOutputInvalid as exc:
            log.warning(
                "extract attempt %d: invalid model output (%s)", attempt, type(exc).__name__
            )
            if attempt == 2:
                break
            await emit(STAGE, "progress", "Model output did not match the schema; retrying once…")
            user_text = f"{USER_PROMPT}\n\n" + RETRY_PROMPT.format(
                error=str(exc)[:MAX_RETRY_ERROR_CHARS]
            )
        except httpx.TimeoutException:
            await emit(STAGE, "error", f"Local model timed out after {OLLAMA_TIMEOUT_S:.0f} s")
            raise
        except httpx.HTTPError as exc:
            await emit(STAGE, "error", f"Local model unavailable ({type(exc).__name__})")
            raise

    elapsed = time.perf_counter() - started
    if intent is None:
        log.info("extract: fell back to 'other' after retry in %.2f s", elapsed)
        await emit(STAGE, "ok", f"intent: other · model output unreadable · {elapsed:.1f} s")
        return FALLBACK_INTENT

    intent = clamp(intent)
    if intent.intent_type == "other":
        # Native OCR takes precedence over model guesses for visible URL characters.
        recognized = await asyncio.to_thread(native_image_links, image_bytes)
        if recognized:
            intent = ScreenshotIntent(
                **intent.model_dump(include=set(Intent.model_fields)), visible_links=recognized
            )
    withheld = sum(intent.redaction_counts.values())
    log.info(
        "extract: %s, %d entities, %d withheld, %.2f s",
        intent.intent_type,
        len(intent.public_entities),
        withheld,
        elapsed,
    )
    await emit(
        STAGE,
        "ok",
        f"intent: {intent.intent_type}"
        f" · {_count(len(intent.public_entities), 'public entity', 'public entities')}"
        f" · {_count(withheld, 'private item', 'private items')} withheld · {elapsed:.1f} s",
    )
    return intent
