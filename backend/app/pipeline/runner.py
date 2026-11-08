"""The real pipeline: one background job per screenshot, streaming every stage.

`run_job` runs ingest -> extract -> scrub -> query -> search -> cards -> done in order,
emitting a `StageEvent` for each step (local=True on-device, local=False on the network),
timing every stage into `timings_ms`, and ending with a valid `JobResult`. A later stage
failing still yields partial results: a search failure degrades to on-device cards only and
the job still ends `done`; only an extraction failure ends the job in `error`.

Privacy: the image bytes live only in this coroutine's memory, are passed to the extractor
and then dropped (`del`); they are never written to disk, logged, or put in an event. Only
`app.egress` opens network connections — this module reaches Tavily solely through
`app.pipeline.search`, which posts via `egress.internet_post`.
"""

from __future__ import annotations

import asyncio
import io
import logging
import time

from PIL import Image, UnidentifiedImageError

from app import jobs, library
from app.models import Card, Intent, JobResult, SearchQuery, StageEvent
from app.pipeline import cards as cards_mod
from app.pipeline import exa as exa_mod
from app.pipeline import search as search_mod
from app.pipeline.extract import extract_intent
from app.pipeline.query import allow_terms as query_allow_terms
from app.pipeline.query import build_queries, related_query
from app.pipeline.scrub import scrub_intent

log = logging.getLogger(__name__)

MAX_IMAGE_BYTES = 10 * 1024 * 1024
ALLOWED_FORMATS = {"PNG": "PNG", "JPEG": "JPEG", "WEBP": "WEBP"}
SEARCH_DEGRADED_NOTE = "Web search unavailable — showing on-device results only."

# Serialize access to the single local vision model: one extraction at a time.
_MODEL_SEMAPHORE = asyncio.Semaphore(1)


def _ms(elapsed_s: float) -> int:
    return int(round(elapsed_s * 1000))


async def _publish(
    job: jobs.JobState,
    stage: str,
    status: str,
    message: str,
    *,
    local: bool,
    data: dict | None = None,
) -> None:
    await job.publish(
        StageEvent(
            job_id=job.job_id,
            seq=len(job.events),
            ts=time.time(),
            stage=stage,
            status=status,
            message=message,
            local=local,
            data=data,
        )
    )


class _IngestRejected(ValueError):
    """The upload is not a decodable png/jpeg/webp within the size limit."""


def _verify_image(image_bytes: bytes) -> tuple[str, float]:
    """Verify the bytes are a real png/jpeg/webp <= 10 MB. Returns (format, size_mb)."""
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise _IngestRejected("image larger than 10 MB")
    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            img.verify()  # checks structure without decoding pixels
        with Image.open(io.BytesIO(image_bytes)) as img:
            fmt = (img.format or "").upper()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise _IngestRejected(f"not a readable image ({type(exc).__name__})") from exc
    if fmt not in ALLOWED_FORMATS:
        raise _IngestRejected(f"unsupported image format {fmt or 'unknown'}")
    return fmt, len(image_bytes) / (1024 * 1024)


async def _finish_error(job: jobs.JobState, message: str, timings: dict[str, int]) -> None:
    job.result = job.result.model_copy(
        update={"status": "error", "error": message, "timings_ms": timings}
    )
    await _publish(job, "error", "error", f"error: {message}", local=True)


def _scrub_message(removed: dict[str, int], kept: int) -> str:
    parts = [f"{n} {cat.lower()}" for cat, n in removed.items() if n]
    prefix = f"Removed {', '.join(parts)} — " if parts else ""
    entities = "public entity" if kept == 1 else "public entities"
    return f"{prefix}{kept} {entities} kept"


async def run_job(job_id: str, image_bytes: bytes, filename: str) -> None:
    """Run the full pipeline for one screenshot, streaming stages to the job's subscribers."""
    jobs.cleanup_finished()
    job = jobs.get_job(job_id)
    if job is None:  # cleaned up or never created; nothing to stream to
        return

    timings: dict[str, int] = {}
    # Hand the bytes over in a box so the stages can drop the last reference after extract.
    box = [image_bytes]
    del image_bytes
    try:
        await _run_stages(job, box, timings)
    except Exception as exc:
        # Backstop: an unexpected failure in scrub/query/cards must still end the stream with
        # a terminal event, or the job stays "running" and subscribers wait forever.
        # Log the type only: exception text can carry entity values.
        log.error("job %s failed unexpectedly (%s)", job_id, type(exc).__name__)
        if not job.finished:
            await _finish_error(job, f"internal error ({type(exc).__name__})", timings)


async def _run_stages(job: jobs.JobState, box: list[bytes], timings: dict[str, int]) -> None:
    job_id = job.job_id
    image_bytes = box.pop()

    # --- ingest (local) -----------------------------------------------------------
    t0 = time.perf_counter()
    try:
        fmt, size_mb = _verify_image(image_bytes)
    except _IngestRejected as exc:
        timings["ingest"] = _ms(time.perf_counter() - t0)
        await _finish_error(job, f"ingest failed: {exc}", timings)
        return
    await _publish(job, "ingest", "start", "Reading the upload on-device", local=True)
    await _publish(
        job,
        "ingest",
        "ok",
        f"Received {size_mb:.1f} MB {fmt} — stays in memory, never written to disk",
        local=True,
        data={"format": fmt},
    )
    timings["ingest"] = _ms(time.perf_counter() - t0)
    # Opt-in library thumbnail, built in memory before the raw bytes are dropped.
    thumb = library.make_thumb(image_bytes) if library.keep_thumbs() else None

    # --- extract (local, model-serialized) ---------------------------------------
    async def extract_emit(stage: str, status: str, message: str) -> None:
        await _publish(job, stage, status, message, local=True)

    t0 = time.perf_counter()
    if _MODEL_SEMAPHORE.locked():
        await _publish(
            job, "extract", "progress", "Waiting for the local model (1 job ahead)", local=True
        )
    try:
        async with _MODEL_SEMAPHORE:
            intent: Intent = await extract_intent(image_bytes, extract_emit)
    except Exception as exc:  # extract_intent already emitted an "extract error" line
        del image_bytes
        timings["extract"] = _ms(time.perf_counter() - t0)
        log.info("extract failed for %s: %s", job_id, type(exc).__name__)
        await _finish_error(job, f"extraction failed ({type(exc).__name__})", timings)
        return
    # Drop the only reference to the raw bytes as soon as the model is done with them.
    del image_bytes
    timings["extract"] = _ms(time.perf_counter() - t0)

    # --- scrub (local) ------------------------------------------------------------
    t0 = time.perf_counter()
    await _publish(job, "scrub", "start", "Scrubbing private data on-device", local=True)
    scrubbed, report = await asyncio.to_thread(scrub_intent, intent)
    await _publish(job, "scrub", "ok", _scrub_message(report.removed, report.kept), local=True)
    timings["scrub"] = _ms(time.perf_counter() - t0)

    # --- query (local) ------------------------------------------------------------
    t0 = time.perf_counter()
    queries: list[SearchQuery] = await asyncio.to_thread(build_queries, scrubbed)
    # Exa only; never sent to Tavily.
    related_q = await asyncio.to_thread(related_query, scrubbed)
    plural = "y" if len(queries) == 1 else "ies"
    await _publish(
        job,
        "query",
        "ok",
        f"Built {len(queries)} search quer{plural} from public entities",
        local=True,
        data={"queries": [q.text for q in queries]},
    )
    timings["query"] = _ms(time.perf_counter() - t0)

    await finish_intent_job(job, scrubbed, queries, timings, related_q=related_q, thumb=thumb)


async def finish_intent_job(
    job: jobs.JobState,
    scrubbed: Intent,
    queries: list[SearchQuery],
    timings: dict[str, int],
    *,
    related_q: SearchQuery | None = None,
    thumb: bytes | None = None,
) -> None:
    """Shared search/cards/save tail for structured, scrubbed screenshot and voice intents."""
    job_id = job.job_id
    # allow_terms: only kept public names (performers, authors, titles, products, brands,
    # companies) may appear in an outbound query; the same set the query builder checked with.
    allow_terms = query_allow_terms(scrubbed)

    # --- search (network) ---------------------------------------------------------
    # Tavily and Exa run concurrently; Exa's findSimilar waits only for the Tavily answer.
    t0 = time.perf_counter()
    for q in queries:
        await _publish(job, "search", "start", f"search → {q.text}", local=False)
    tavily_task = asyncio.create_task(search_mod.search(queries, job_id, allow_terms))

    async def tavily_context() -> exa_mod.TavilyContext:
        return exa_mod.tavily_context(queries, await tavily_task)

    related_cards: list[Card] = []
    exa_task = None
    if related_q is not None:
        # Exa is optional: once Tavily answers it gets at most OPTIONAL_BUDGET_S more, and
        # keeps whatever arrived by then.
        exa_task = asyncio.create_task(
            exa_mod.related_concurrent(
                [related_q],
                tavily_context(),
                job_id,
                allow_terms,
                budget=exa_mod.OPTIONAL_BUDGET_S,
            )
        )
    try:
        try:
            results = await tavily_task
        except Exception as exc:  # search never raises, but degrade gracefully if it ever does
            log.info("search failed for %s: %s", job_id, type(exc).__name__)
            results = {}
        if exa_task is not None:
            try:
                related_cards = await exa_task
            except Exception as exc:  # Exa never raises either; related cards are optional
                log.info("exa failed for %s: %s", job_id, type(exc).__name__)
    finally:
        # On cancellation, stop both network tasks and wait for them before returning.
        for task in (tavily_task, exa_task):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(t for t in (tavily_task, exa_task) if t is not None), return_exceptions=True
        )
    search_note = SEARCH_DEGRADED_NOTE if queries and not results else None
    await _publish(
        job,
        "search",
        "ok",
        f"{len(results)} of {len(queries)} queries returned results"
        + (f" · {len(related_cards)} related from Exa" if related_cards else ""),
        local=False,
        data={"found": len(results)},
    )
    timings["search"] = _ms(time.perf_counter() - t0)

    # --- cards (local) ------------------------------------------------------------
    t0 = time.perf_counter()
    cards = await asyncio.to_thread(cards_mod.build_cards, scrubbed, queries, results)
    cards = exa_mod.merge_cards(cards, related_cards)
    await _publish(
        job,
        "cards",
        "ok",
        f"Built {len(cards)} action cards",
        local=True,
        data={"count": len(cards)},
    )
    timings["cards"] = _ms(time.perf_counter() - t0)

    # --- done ---------------------------------------------------------------------
    job.result = job.result.model_copy(
        update={
            "status": "done",
            "intent": scrubbed,
            "queries": queries,
            "cards": cards,
            "timings_ms": timings,
            "error": search_note,
        }
    )
    result: JobResult = job.result
    # Save the scrubbed result (egress stripped) to the local library before announcing done.
    await asyncio.to_thread(
        library.save_quietly, result, thumb, expected_generation=job.memory_generation
    )
    await _publish(
        job,
        "done",
        "ok",
        f"Done · {len(cards)} cards" + (f" · {search_note}" if search_note else ""),
        local=True,
        data=result.model_dump(mode="json"),
    )
