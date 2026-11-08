"""Reviewed voice/text input feeds the same structured, scrubbed pipeline as screenshots."""

import asyncio
import json
import time
from typing import Literal

from app import egress, jobs, library
from app.models import Card, CardAction, EgressRecord, JobResult
from app.pipeline.query import build_voice_queries, related_voice_query
from app.pipeline.runner import (
    _MODEL_SEMAPHORE,
    _finish_error,
    _ms,
    _publish,
    _scrub_message,
    finish_intent_job,
)
from app.pipeline.scrub import scrub_intent
from app.pipeline.text_intent import extract_text_intent

VoiceAction = Literal["explore", "save", "related"]


async def _save_local(job: jobs.JobState, timings: dict[str, int]) -> None:
    # A save-only voice result must not retain even attempted queries or audit records.
    completed = job.result.model_copy(
        update={"status": "done", "queries": [], "cards": [], "egress": [], "timings_ms": timings}
    )
    try:
        saved = await asyncio.to_thread(
            library.save, completed, expected_generation=job.memory_generation
        )
    except Exception:
        saved = False
    if not saved:
        await _finish_error(job, "local_save_unavailable", timings)
        return
    job.result = completed
    await _publish(
        job,
        "done",
        "ok",
        "Scrubbed intent saved locally; no web requests",
        local=True,
        data=job.result.model_dump(mode="json"),
    )


async def run_voice_job(
    job_id: str, text: str, action: VoiceAction, context: JobResult | None
) -> None:
    job = jobs.get_job(job_id)
    if job is None:
        return
    timings: dict[str, int] = {}
    try:
        if jobs.mock_enabled():
            del text
            await _mock_voice(job, action, context)
            return
        started = time.perf_counter()
        if action == "related":
            # The instruction is not an entity source. Only this selected saved item is read.
            del text
            if context is None or context.intent is None:
                await _finish_error(job, "selected_context_unavailable", timings)
                return
            intent = context.intent
            await _publish(
                job,
                "extract",
                "ok",
                "Using the selected saved item's public details on-device",
                local=True,
            )
        else:

            async def emit(stage: str, status: str, message: str) -> None:
                await _publish(job, stage, status, message, local=True)

            if _MODEL_SEMAPHORE.locked():
                await _publish(
                    job, "extract", "progress", "Waiting for the local model", local=True
                )
            async with _MODEL_SEMAPHORE:
                intent = await extract_text_intent(text, emit)
            del text
        timings["extract"] = _ms(time.perf_counter() - started)
        started = time.perf_counter()
        await _publish(job, "scrub", "start", "Hiding personal details on-device", local=True)
        scrubbed, report = await asyncio.to_thread(scrub_intent, intent)
        # Persist a public-entity summary, never free-form text copied from the model's reply.
        scrubbed = scrubbed.model_copy(
            update={
                "summary": ", ".join(e.value for e in scrubbed.public_entities)[:140]
                or "Saved thought"
            }
        )
        job.result = job.result.model_copy(update={"intent": scrubbed})
        await _publish(job, "scrub", "ok", _scrub_message(report.removed, report.kept), local=True)
        timings["scrub"] = _ms(time.perf_counter() - started)
        if action == "save":
            await _save_local(job, timings)
            return
        started = time.perf_counter()
        related = await asyncio.to_thread(related_voice_query, scrubbed)
        queries = (
            [related]
            if action == "related" and related
            else (
                []
                if action == "related"
                else await asyncio.to_thread(build_voice_queries, scrubbed)
            )
        )
        await _publish(
            job,
            "query",
            "ok",
            f"Built {len(queries)} searches from scrubbed public details",
            local=True,
            data={"queries": [q.text for q in queries]},
        )
        timings["query"] = _ms(time.perf_counter() - started)
        await finish_intent_job(job, scrubbed, queries, timings, related_q=related)
    except asyncio.CancelledError:
        if not job.finished:
            await _finish_error(job, "voice_job_cancelled", timings)
        raise
    except Exception:
        # Never include exception text: model/decoder exceptions can contain the reviewed text.
        if not job.finished:
            await _finish_error(job, "voice_interpretation_unavailable", timings)


async def _mock_voice(job: jobs.JobState, action: VoiceAction, context: JobResult | None) -> None:
    _, fixture = jobs.load_fixture("concert_flyer")
    intent = context.intent if action == "related" and context else fixture.intent
    if intent is None:
        await _finish_error(job, "selected_context_unavailable", {})
        return
    job.result = job.result.model_copy(update={"intent": intent})
    await _publish(
        job, "extract", "start", "Interpreting reviewed text on-device (mock)", local=True
    )
    await asyncio.sleep(jobs.MOCK_DELAY_RANGE[0])
    await _publish(job, "extract", "ok", "Public intent understood on-device (mock)", local=True)
    await _publish(job, "scrub", "ok", "Only scrubbed public details kept (mock)", local=True)
    if action == "save":
        await _save_local(job, {})
        return
    related = await asyncio.to_thread(related_voice_query, intent)
    queries = (
        [related]
        if action == "related" and related
        else ([] if action == "related" else await asyncio.to_thread(build_voice_queries, intent))
    )
    await _publish(
        job,
        "query",
        "ok",
        "Short searches built from public details (mock)",
        local=True,
        data={"queries": [q.text for q in queries]},
    )
    records = []
    for index, query in enumerate(queries):
        payload = json.dumps({"query": query.text})
        record = EgressRecord(
            id=f"{job.job_id}_voice_{index}",
            ts=time.time(),
            method="POST",
            host="api.tavily.com",
            path="/search",
            bytes_out=len(payload.encode()),
            payload_preview=payload,
            blocked=egress.is_offline(),
            reason="offline mode" if egress.is_offline() else None,
        )
        records.append(record)
        await _publish(
            job,
            "search",
            "error" if record.blocked else "ok",
            "Search blocked (mock)" if record.blocked else "Public text searched (mock)",
            local=False,
            data={"blocked": record.blocked, "reason": record.reason},
        )
    cards = (
        fixture.cards
        if action == "explore"
        else [
            Card(
                id=f"{job.job_id}_related",
                kind="related",
                title="Related reading: " + (queries[0].text if queries else "selected item"),
                source="example.test",
                url="https://example.test/related",
                actions=[
                    CardAction(type="open_url", label="Read", url="https://example.test/related")
                ],
            )
        ]
    )
    if not queries or egress.is_offline():
        cards = []
    jobs.EGRESS_LOG.extend(records)
    job.result = job.result.model_copy(
        update={"status": "done", "queries": queries, "cards": cards, "egress": records}
    )
    await _publish(job, "cards", "ok", "Cards built on this device (mock)", local=True)
    await asyncio.to_thread(
        library.save_quietly, job.result, expected_generation=job.memory_generation
    )
    await _publish(
        job,
        "done",
        "ok",
        "Reviewed thought complete (mock)",
        local=True,
        data=job.result.model_dump(mode="json"),
    )
