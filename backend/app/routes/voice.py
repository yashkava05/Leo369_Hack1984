"""Local voice adapters. Multipart bytes stay in memory, including validation failures."""

import asyncio
import json
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from python_multipart.multipart import MultipartParser, parse_options_header

from app import jobs, library, voice
from app.pipeline.text_intent import normalize_text

router = APIRouter()
MAX_AUDIO_BYTES = 8 * 1024 * 1024


class VoiceAnalyze(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str
    action: Literal["explore", "save", "related"]
    context_library_id: str | None = Field(None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_action(self):
        self.text = normalize_text(self.text)
        if self.context_library_id is not None:
            self.context_library_id = self.context_library_id.strip()
        if (self.action == "related") != bool(self.context_library_id):
            raise ValueError("invalid_context")
        if self.action != "related" and self.context_library_id is not None:
            raise ValueError("invalid_context")
        return self


async def _body(request: Request, limit: int) -> bytes:
    out = bytearray()
    async for chunk in request.stream():
        if len(out) + len(chunk) > limit:
            raise HTTPException(
                413, "audio_too_large" if limit > MAX_AUDIO_BYTES else "text_too_large"
            )
        out.extend(chunk)
    return bytes(out)


async def _audio_part(request: Request) -> tuple[bytes, str, str]:
    content_type, options = parse_options_header(request.headers.get("content-type", ""))
    boundary = options.get(b"boundary", b"")
    if content_type != b"multipart/form-data" or not boundary or len(boundary) > 128:
        raise HTTPException(415, "unsupported_audio")
    audio = bytearray()
    field = bytearray()
    value = bytearray()
    headers: dict[bytes, bytes] = {}
    meta: dict[str, str] = {}
    parts = 0
    complete = False
    header_bytes = 0

    def begin():
        nonlocal parts
        parts += 1
        if parts > 1:
            raise HTTPException(415, "unsupported_audio")

    def header_field(data, start, end):
        nonlocal header_bytes
        header_bytes += end - start
        if header_bytes > 8192:
            raise HTTPException(415, "unsupported_audio")
        field.extend(data[start:end])

    def header_value(data, start, end):
        nonlocal header_bytes
        header_bytes += end - start
        if header_bytes > 8192:
            raise HTTPException(415, "unsupported_audio")
        value.extend(data[start:end])

    def header_end():
        headers[bytes(field).lower()] = bytes(value)
        field.clear()
        value.clear()

    def ready():
        kind, disposition = parse_options_header(headers.get(b"content-disposition", b""))
        if kind != b"form-data" or disposition.get(b"name") != b"audio":
            raise HTTPException(415, "unsupported_audio")
        meta["type"] = headers.get(b"content-type", b"").decode("latin-1")
        meta["name"] = disposition.get(b"filename", b"").decode("utf-8", errors="replace")

    def data(data, start, end):
        if len(audio) + end - start > MAX_AUDIO_BYTES:
            raise HTTPException(413, "audio_too_large")
        audio.extend(data[start:end])

    def end():
        nonlocal complete
        complete = True

    parser = MultipartParser(
        boundary,
        {
            "on_part_begin": begin,
            "on_header_field": header_field,
            "on_header_value": header_value,
            "on_header_end": header_end,
            "on_headers_finished": ready,
            "on_part_data": data,
            "on_end": end,
        },
    )
    total = 0
    try:
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_AUDIO_BYTES:
                raise HTTPException(413, "audio_too_large")
            parser.write(chunk)
        parser.finalize()
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(415, "unsupported_audio") from None
    if parts != 1 or not complete or not meta:
        raise HTTPException(415, "unsupported_audio")
    return bytes(audio), meta["type"], meta["name"]


@router.post("/voice/transcribe")
async def transcribe(request: Request) -> dict:
    data, content_type, filename = await _audio_part(request)
    try:
        return await voice.transcribe_audio(data, content_type, filename=filename)
    except voice.VoiceError as exc:
        raise HTTPException(exc.status, exc.code) from None


@router.post("/voice/analyze", status_code=202)
async def analyze_voice(request: Request) -> dict[str, str]:
    try:
        item = VoiceAnalyze.model_validate(json.loads(await _body(request, 16384)))
    except (ValueError, ValidationError, TypeError):
        raise HTTPException(422, "invalid_voice_request") from None
    context = None
    if item.action == "related":
        context = await asyncio.to_thread(library.get, item.context_library_id)
        if context is None or context.intent is None:
            raise HTTPException(404, "unknown_context")
    jobs.cleanup_finished()
    job = jobs.create_job()
    jobs.start_voice_job(job, item.text if item.action != "related" else "", item.action, context)
    return {"job_id": job.job_id}
