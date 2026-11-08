"""Browser-session agent routes (#67, Teams #68): the Latent UI and the extension meet here.

UI (same-origin, view token):      POST /browser/jobs · GET/DELETE /browser/jobs/{id}
Extension (extension origin+nonce): POST /browser/jobs/{id}/claim|progress|content|fail

Errors are constant codes only; responses never echo page content back to the extension.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app import browser_bridge as bridge
from app import egress, outlook, teams
from app.config import get_settings
from app.pipeline.text_intent import normalize_text

router = APIRouter(prefix="/browser")
PROVIDERS = {outlook.PROVIDER: outlook, teams.PROVIDER: teams}


class CreateJob(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: Literal["outlook", "teams"]
    request: str = Field(min_length=1, max_length=1000)
    mode: Literal["latest", "unread", "selected", "today"]
    count: int = Field(ge=1, le=max(outlook.MAX_COUNT, teams.MAX_COUNT))
    # Teams only (#68): the chat/channel fingerprint the user explicitly confirmed, and whether
    # thread replies are in scope. Outlook requests must leave these unset.
    source: str | None = Field(None, max_length=16)
    source_confirmed: bool = False
    replies: bool = False


def _scope(item: CreateJob) -> bridge.Scope:
    if item.provider == teams.PROVIDER:
        return teams.validate_scope(
            item.mode,
            item.count,
            replies=item.replies,
            source=item.source,
            confirmed=item.source_confirmed,
        )
    if item.source is not None or item.source_confirmed or item.replies:
        raise bridge.BridgeError("invalid_scope", 422)
    return outlook.validate_scope(item.mode, item.count)


def _raise(exc: bridge.BridgeError) -> None:
    raise HTTPException(exc.status, exc.code) from None


async def _json(request: Request, limit: int) -> Any:
    out = bytearray()
    async for chunk in request.stream():
        if len(out) + len(chunk) > limit:
            raise HTTPException(413, "payload_too_large")
        out.extend(chunk)
    try:
        return json.loads(bytes(out))
    except ValueError:
        raise HTTPException(422, "invalid_payload") from None


def _parse(model: type[BaseModel], data: Any) -> Any:
    try:
        return model.model_validate(data)
    except ValidationError:
        # Never echo validation details: they can contain page text.
        raise HTTPException(422, "invalid_payload") from None


def _airgap(job: bridge.BrowserJob | None = None) -> None:
    """Air-gap disables browser retrieval: Outlook/Teams pages load content from Microsoft."""
    if egress.is_offline():
        if job is not None and job.status not in bridge.TERMINAL:
            job.status, job.error = "blocked", "airgap_on"
            job.wipe()
            bridge.audit(job, "blocked_airgap", "browser")
        raise HTTPException(423, "airgap_on")


def _scope_view(job: bridge.BrowserJob) -> dict[str, Any]:
    scope: dict[str, Any] = {"mode": job.scope.mode, "count": job.scope.count}
    if job.provider == teams.PROVIDER:
        scope["replies"] = job.scope.replies
    return scope


def _view(job: bridge.BrowserJob) -> dict[str, Any]:
    reading = job.status in ("reading", "analyzing", "done") or job.inspected > 0
    steps = [
        {
            "key": "source",
            "label": "Selecting your authorized tab",
            "boundary": "local",
            "state": "done"
            if job.claimed
            else ("active" if job.status == "waiting_for_extension" else "idle"),
        },
        {
            "key": "read",
            "label": f"Reading {job.inspected} of {job.scope.count}"
            if job.scope.mode != "selected"
            else "Reading the open message",
            "boundary": "browser",
            "state": "done" if job.submitted else ("active" if job.status == "reading" else "idle"),
        },
        {
            "key": "analyze",
            "label": "Analyzing on this device",
            "boundary": "local",
            "state": "done"
            if job.status == "done"
            else ("active" if job.status == "analyzing" else "idle"),
        },
    ]
    if not reading and job.status in bridge.TERMINAL:
        for step in steps:
            if step["state"] == "active":
                step["state"] = "idle"
    if job.status in ("error", "blocked", "cancelled"):
        for step in steps:
            if step["state"] == "active":
                step["state"] = "error"
    coverage = job.coverage.model_dump() if job.coverage else None
    return {
        "job_id": job.job_id,
        "provider": job.provider,
        "status": job.status,
        "error": job.error,
        "scope": _scope_view(job),
        "origin": job.origin,
        "inspected": job.inspected,
        "coverage": coverage,
        "steps": steps,
        "result": job.result,
        "demo": get_settings().latent_mock,
        "timings_ms": dict(job.timings_ms),
        "receipt": {
            "browser_reads": job.inspected if job.submitted else 0,
            "backend_internet_requests": 0,  # this flow never calls egress.internet_post
            "local_model_calls": 1
            if job.status == "done" and job.inspected and not get_settings().latent_mock
            else 0,
        },
    }


# --- UI side ------------------------------------------------------------------------------


@router.post("/jobs", status_code=201)
async def create_job(request: Request) -> dict[str, Any]:
    try:
        bridge.require_ui_origin(request.headers.get("origin"))
    except bridge.BridgeError as exc:
        _raise(exc)
    _airgap()
    item = _parse(CreateJob, await _json(request, 4096))
    try:
        text = normalize_text(item.request)
        scope = _scope(item)
    except ValueError:
        raise HTTPException(422, "invalid_payload") from None
    except bridge.BridgeError as exc:
        _raise(exc)
    job = bridge.create_job(item.provider, scope, text)
    return {
        "job_id": job.job_id,
        "nonce": job.nonce,
        "view_token": job.view_token,
        "scope": _scope_view(job),
        "expires_in_s": bridge.JOB_TTL_S,
    }


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, x_latent_view: str | None = Header(None)) -> dict[str, Any]:
    try:
        job = bridge.require_viewer(bridge.get(job_id), x_latent_view)
    except bridge.BridgeError as exc:
        _raise(exc)
    return _view(job)


@router.delete("/jobs/{job_id}", status_code=204)
async def delete_job(job_id: str, x_latent_view: str | None = Header(None)) -> Response:
    """Cancel/close: aborts analysis and wipes every private value for this job."""
    try:
        job = bridge.require_viewer(bridge.get(job_id), x_latent_view)
    except bridge.BridgeError as exc:
        _raise(exc)
    bridge.remove(job)
    return Response(status_code=204)


# --- extension side -----------------------------------------------------------------------


def _ext(request: Request, job_id: str) -> bridge.BrowserJob:
    try:
        return bridge.require_extension(
            request.headers.get("origin"), bridge.get(job_id), request.headers.get("x-latent-nonce")
        )
    except bridge.BridgeError as exc:
        _raise(exc)
        raise  # unreachable; keeps type checkers happy


@router.post("/jobs/{job_id}/claim")
async def claim(job_id: str, request: Request) -> dict[str, Any]:
    job = _ext(request, job_id)
    _airgap(job)
    body = _parse(bridge.ClaimRequest, await _json(request, 1024))
    _airgap(job)
    provider = PROVIDERS.get(body.provider)
    try:
        if provider is None or body.provider != job.provider:
            raise bridge.BridgeError("wrong_provider", 422)
        bridge.claim(job, provider.origin_allowed(body.origin))
    except bridge.BridgeError as exc:
        _raise(exc)
    job.origin = body.origin
    job.timings_ms["claimed_at_ms"] = int((time.time() - job.created) * 1000)
    bridge.audit(job, "claimed", "local")
    # The scope comes from the backend, never from the page or the UI message.
    scope = {"provider": job.provider, "mode": job.scope.mode, "count": job.scope.count}
    if hasattr(provider, "claim_scope"):
        scope.update(provider.claim_scope(job))
    return scope


@router.post("/jobs/{job_id}/progress", status_code=204)
async def progress(job_id: str, request: Request) -> Response:
    job = _ext(request, job_id)
    _airgap(job)
    body = _parse(bridge.ProgressRequest, await _json(request, 256))
    _airgap(job)
    try:
        bridge.progress(job, body.inspected)
    except bridge.BridgeError as exc:
        _raise(exc)
    return Response(status_code=204)


@router.post("/jobs/{job_id}/content", status_code=202)
async def content(job_id: str, request: Request) -> dict[str, Any]:
    job = _ext(request, job_id)
    if job.submitted:
        raise HTTPException(409, "replay")
    if not job.claimed:
        raise HTTPException(409, "bad_state")
    _airgap(job)
    provider = PROVIDERS[job.provider]
    schema = getattr(provider, "ContentRequest", bridge.ContentRequest)
    body = _parse(schema, await _json(request, bridge.MAX_CONTENT_BYTES))
    # The body may take a while to arrive: Stop, replacement or air-gap may have landed since.
    try:
        bridge.ensure_open(job)
    except bridge.BridgeError as exc:
        _raise(exc)
    if job.submitted:
        raise HTTPException(409, "replay")
    _airgap(job)
    try:
        if body.provider != job.provider or body.origin != job.origin:
            raise bridge.BridgeError("wrong_origin", 403)
        if body.coverage.requested != job.scope.count:
            raise bridge.BridgeError("scope_mismatch", 422)
        if hasattr(provider, "check_content"):
            items = provider.check_content(job, body)
        else:
            items = provider.check_items(job, body.mode, body.items)
    except bridge.BridgeError as exc:
        job.status, job.error = "error", exc.code
        job.wipe()
        _raise(exc)
    job.submitted = True
    job.items = items
    job.inspected = len(items)
    if hasattr(provider, "partial"):
        is_partial = provider.partial(job, body.coverage, len(items))
    else:
        is_partial = body.coverage.partial or (
            len(items) < job.scope.count and job.scope.mode != "selected"
        )
    job.coverage = body.coverage.model_copy(update={"inspected": len(items), "partial": is_partial})
    job.timings_ms["read"] = body.coverage.elapsed_ms
    job.status = "analyzing"
    bridge.audit(
        job,
        "read_tab",
        "browser",
        count=len(items),
        ms=body.coverage.elapsed_ms,
        partial=str(job.coverage.partial).lower(),
    )
    job.task = asyncio.create_task(bridge.run_analysis(job, provider.analyze))
    return {"accepted": len(items)}


@router.post("/jobs/{job_id}/fail", status_code=204)
async def fail(job_id: str, request: Request) -> Response:
    job = _ext(request, job_id)
    body = _parse(bridge.FailRequest, await _json(request, 256))
    if job.status in bridge.TERMINAL:
        return Response(status_code=204)
    bridge.fail(job, body.code)
    return Response(status_code=204)
