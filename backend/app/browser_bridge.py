"""Provider-neutral local bridge between the Latent browser extension and the backend (#67).

The extension reads an explicitly authorized tab (Outlook Web #67, Teams Web #68) and hands
the page text to this process. Nothing here opens a network connection: the extension posts to
this local server, and analysis goes to Ollama through `egress.local_client()`.

Security model, in order:
- The UI creates a job (same-origin UI only) and receives a one-job nonce plus a view token.
- Only an allow-listed extension origin (`chrome-extension://<id>`) holding that nonce may claim
  the job and submit content, exactly once each. Ordinary web pages cannot set that Origin, and
  never see the nonce.
- Payloads are size-capped, schema-checked (extra fields rejected) and checked against the scope
  the user confirmed; the provider decides which tab origins are acceptable.
- Private content lives only in this bounded in-memory store. Cancel, expiry and replacement wipe
  it, and late submissions are dropped. Nothing is logged or written to disk; the audit trail
  keeps only coarse operation/count/timing metadata.
"""

from __future__ import annotations

import asyncio
import hmac
import os
import secrets
import time
import uuid
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.config import get_settings

MAX_JOBS = 4
JOB_TTL_S = 15 * 60
RESULT_TTL_S = 5 * 60  # a finished result is dropped soon after, even if the UI never asks
# Field limits are in characters; 20 full list items of non-ASCII text stay under this.
MAX_CONTENT_BYTES = 160 * 1024
MAX_ITEMS = 20
MAX_AUDIT = 200

Status = Literal[
    "waiting_for_extension", "reading", "analyzing", "done", "error", "cancelled", "blocked"
]
TERMINAL = {"done", "error", "cancelled", "blocked"}

# Constant failure codes the extension may report. No free text ever crosses the bridge.
ExtensionError = Literal[
    "extension_unavailable",
    "no_source_selected",
    "permission_denied",
    "wrong_origin",
    "account_changed",
    "login_required",
    "unsupported_layout",
    "empty_mailbox",
    "nothing_selected",
    "tab_closed",
    "cancelled",
    "read_failed",
    # Teams Web (#68)
    "conversation_changed",
    "org_blocked",
    "empty_conversation",
]


class BridgeError(Exception):
    """A constant, content-free error code plus the HTTP status the route should return."""

    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.code = code
        self.status = status


# --- wire schema (extension -> backend) ---------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class SourceItem(_Strict):
    """One message as the provider adapter saw it. All text is untrusted page content."""

    id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")
    sender: str = Field("", max_length=200)
    time: str = Field("", max_length=80)
    subject: str = Field("", max_length=300)
    preview: str = Field("", max_length=1200)
    body: str | None = Field(None, max_length=8000)
    unread: bool = False


class Coverage(_Strict):
    requested: int = Field(ge=1, le=MAX_ITEMS)
    inspected: int = Field(ge=0, le=MAX_ITEMS)
    # Rows looked at (differs from `inspected` in unread mode, which keeps only unread rows).
    examined: int = Field(0, ge=0, le=1000)
    scrolls: int = Field(0, ge=0, le=100)
    partial: bool
    reason: Literal["count_reached", "list_end", "budget", "timeout", "selected_message"]
    elapsed_ms: int = Field(0, ge=0, le=600_000)


class ClaimRequest(_Strict):
    provider: str = Field(min_length=1, max_length=32)
    origin: str = Field(min_length=1, max_length=200)


class ProgressRequest(_Strict):
    inspected: int = Field(ge=0, le=MAX_ITEMS)


class ContentRequest(_Strict):
    provider: str = Field(min_length=1, max_length=32)
    origin: str = Field(min_length=1, max_length=200)
    mode: Literal["latest", "unread", "selected"]
    items: list[SourceItem] = Field(max_length=MAX_ITEMS)
    coverage: Coverage


class FailRequest(_Strict):
    code: ExtensionError


# --- job store ----------------------------------------------------------------------------


@dataclass
class Scope:
    mode: Literal["latest", "unread", "selected", "today"]
    count: int
    # Teams (#68): replies are read only when the user put them in scope, and `source` is the
    # opaque fingerprint of the one chat/channel the user confirmed. Outlook leaves both unset.
    replies: bool = False
    source: str | None = None


@dataclass
class BrowserJob:
    job_id: str
    provider: str
    scope: Scope
    request: str  # the reviewed voice/typed question; private, RAM only
    nonce: str
    view_token: str
    created: float
    status: Status = "waiting_for_extension"
    origin: str | None = None
    inspected: int = 0
    items: list[Any] | None = None  # provider item models (SourceItem for Outlook)
    coverage: Any = None  # provider coverage model
    result: dict[str, Any] | None = None
    error: str | None = None
    claimed: bool = False
    submitted: bool = False
    timings_ms: dict[str, int] = field(default_factory=dict)
    task: asyncio.Task | None = None

    def wipe(self) -> None:
        """Drop every private value; only coarse status/count metadata survives."""
        self.request = ""
        self.items = None
        self.result = None
        if self.task is not None and not self.task.done():
            self.task.cancel()
        self.task = None


_jobs: dict[str, BrowserJob] = {}
_audit: deque[dict[str, Any]] = deque(maxlen=MAX_AUDIT)


def audit(job: BrowserJob, op: str, boundary: Literal["browser", "local"], **meta: int | str):
    """Coarse audit entry: operation, provider, counts, timing. Never content or URLs."""
    allowed = {k: v for k, v in meta.items() if k in {"count", "ms", "outcome", "partial"}}
    _audit.append(
        {
            "ts": time.time(),
            "job_id": job.job_id,
            "provider": job.provider,
            "op": op,
            "boundary": boundary,
            **allowed,
        }
    )


def audit_log() -> list[dict[str, Any]]:
    return list(reversed(_audit))


def _expire(job_id: str) -> None:
    job = _jobs.pop(job_id, None)
    if job is not None:
        job.wipe()


def _schedule_expiry(job: BrowserJob, delay: float) -> None:
    """Expire on a timer too, so private results do not wait for the next request to vanish."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # no loop (sync tests): _sweep on the next access still applies the TTL
    loop.call_later(delay, _expire, job.job_id)


def _sweep(now: float | None = None) -> None:
    now = time.time() if now is None else now
    for job_id, job in list(_jobs.items()):
        if now - job.created > JOB_TTL_S:
            job.wipe()
            del _jobs[job_id]


def reset() -> None:
    """Test helper and shutdown hook: wipe everything."""
    for job in _jobs.values():
        job.wipe()
    _jobs.clear()
    _audit.clear()


def create_job(provider: str, scope: Scope, request: str) -> BrowserJob:
    _sweep()
    # One request at a time: a new confirmed request cancels a running read and wipes every
    # earlier job, finished results included. (The cancelled job stays only as a content-free
    # tombstone so its stale view token reads "cancelled" until it expires.)
    for old in list(_jobs.values()):
        if old.status not in TERMINAL:
            cancel(old, reason="replaced")
        else:
            old.wipe()
            del _jobs[old.job_id]
    while len(_jobs) >= MAX_JOBS:
        oldest = min(_jobs.values(), key=lambda j: j.created)
        oldest.wipe()
        del _jobs[oldest.job_id]
    job = BrowserJob(
        job_id="b_" + uuid.uuid4().hex,
        provider=provider,
        scope=scope,
        request=request,
        nonce=secrets.token_urlsafe(32),
        view_token=secrets.token_urlsafe(24),
        created=time.time(),
    )
    _jobs[job.job_id] = job
    _schedule_expiry(job, JOB_TTL_S)
    audit(job, "job_created", "local", count=scope.count)
    return job


def get(job_id: str) -> BrowserJob | None:
    _sweep()
    return _jobs.get(job_id)


def cancel(job: BrowserJob, *, reason: str = "cancelled") -> None:
    if job.status not in TERMINAL:
        job.status = "cancelled"
        job.error = "cancelled"
    job.wipe()
    audit(job, "cancelled", "local", outcome=reason)


def remove(job: BrowserJob) -> None:
    cancel(job)
    _jobs.pop(job.job_id, None)


# --- authentication -----------------------------------------------------------------------


def extension_origins() -> set[str]:
    ids = get_settings().latent_extension_ids
    return {f"chrome-extension://{i.strip()}" for i in ids if i.strip()}


def require_extension(origin: str | None, job: BrowserJob | None, nonce: str | None) -> BrowserJob:
    """Authenticate an extension call: allow-listed extension origin plus this job's nonce."""
    if not origin or origin not in extension_origins():
        raise BridgeError("untrusted_origin", 403)
    if job is None:
        raise BridgeError("unknown_job", 404)
    if not nonce or not hmac.compare_digest(nonce.encode(), job.nonce.encode()):
        raise BridgeError("bad_nonce", 403)
    if job.status in TERMINAL:
        raise BridgeError("job_closed", 410)
    return job


def ensure_open(job: BrowserJob) -> None:
    """Re-check after any await: a cancel/replace may have landed while a body was arriving."""
    if _jobs.get(job.job_id) is not job or job.status in TERMINAL:
        raise BridgeError("job_closed", 410)


def require_viewer(job: BrowserJob | None, token: str | None) -> BrowserJob:
    if job is None:
        raise BridgeError("unknown_job", 404)
    if not token or not hmac.compare_digest(token.encode(), job.view_token.encode()):
        raise BridgeError("bad_token", 403)
    return job


# Per-launch secret for the UI routes. The backend writes it to a 0600 file; the Vite dev proxy
# reads that file and adds it as a header, so page JavaScript never sees it. A page that is not
# served through Latent's own proxy (another dev server on :5173, a cross-origin page) cannot
# create jobs or read results, even though its Origin header looks right.
_UI_SECRET = secrets.token_urlsafe(32)
UI_SECRET_HEADER = "x-latent-ui-secret"


def ui_secret() -> str:
    return _UI_SECRET


def ui_secret_path() -> Path:
    settings = get_settings()
    if settings.latent_ui_secret_path.strip():
        return Path(settings.latent_ui_secret_path.strip()).expanduser()
    db = settings.latent_db_path.strip()
    return (Path(db).expanduser().parent if db else Path.home() / ".latent") / "ui-secret"


def publish_ui_secret() -> None:
    """Write this launch's secret (0600). If it cannot be written the browser agent stays off."""
    path = ui_secret_path()
    try:
        if not path.parent.exists():
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(_UI_SECRET)
        path.chmod(0o600)
    except OSError:
        pass


def unpublish_ui_secret() -> None:
    path = ui_secret_path()
    try:
        if path.read_text(encoding="utf-8") == _UI_SECRET:  # a newer launch may own it now
            path.unlink()
    except OSError:
        pass


def require_ui(origin: str | None, secret: str | None, *, need_origin: bool) -> None:
    """UI routes: the launch secret (added by Latent's proxy) plus a UI Origin when present.

    Browsers always send Origin on POST, so job creation requires it; same-origin GET/DELETE
    through the proxy carry none and rely on the secret plus the per-job view token.
    """
    if origin is None and need_origin:
        raise BridgeError("untrusted_origin", 403)
    if origin is not None and origin not in set(get_settings().cors_origins):
        raise BridgeError("untrusted_origin", 403)
    if not secret or not hmac.compare_digest(secret.encode(), _UI_SECRET.encode()):
        raise BridgeError("bad_ui_secret", 403)


# --- state machine ------------------------------------------------------------------------


def claim(job: BrowserJob, origin_ok: bool) -> None:
    if job.claimed:
        raise BridgeError("replay", 409)
    ensure_open(job)
    if not origin_ok:
        job.status, job.error = "error", "wrong_origin"
        job.wipe()
        raise BridgeError("wrong_origin", 403)
    job.claimed = True
    job.status = "reading"


def progress(job: BrowserJob, inspected: int) -> None:
    if not job.claimed or job.submitted:
        raise BridgeError("bad_state", 409)
    ensure_open(job)
    job.inspected = min(inspected, job.scope.count)


def fail(job: BrowserJob, code: str) -> None:
    job.status = "cancelled" if code == "cancelled" else "error"
    job.error = code
    job.wipe()
    audit(job, "read_failed", "browser", outcome=code)


Analyzer = Callable[[BrowserJob], Awaitable[dict[str, Any]]]


async def run_analysis(job: BrowserJob, analyze: Analyzer) -> None:
    """Analyze submitted content; a cancelled or replaced job never receives the result."""
    started = time.perf_counter()
    try:
        result = await analyze(job)
    except asyncio.CancelledError:
        raise
    except BridgeError as exc:
        if job.status == "analyzing":
            job.status, job.error = "error", exc.code
            job.wipe()
        return
    except Exception:  # never let private content reach a traceback log
        if job.status == "analyzing":
            job.status, job.error = "error", "analysis_failed"
            job.wipe()
        return
    if job.status != "analyzing":
        return  # cancelled while the model was running: drop the late result
    ms = int((time.perf_counter() - started) * 1000)
    job.timings_ms["analyze"] = ms
    job.items = None  # raw page text is no longer needed once grounded results exist
    job.request = ""
    job.result = result
    job.status = "done"
    _schedule_expiry(job, RESULT_TTL_S)
    count = len(result.get("emails", result.get("messages", [])))
    audit(job, "analyzed_locally", "local", count=count, ms=ms)
