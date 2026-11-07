"""The single door to the network.

Every internet request goes through `internet_post`, which checks the hard rules below in
order, records the attempt (sent or blocked) with its exact byte count, and emits a
StageEvent for the live terminal. `local_client` is the only way to reach Ollama and
refuses anything that is not loopback. No other module may open a network client; see
tests/test_single_egress.py.

Rules (first failure blocks):
1. LATENT_OFFLINE=1 (or `set_offline(True)`) blocks everything.
2. Host must be in ALLOWED_HOSTS, scheme https, default port.
3. Serialized body <= MAX_BODY_BYTES (an image cannot fit).
4. No base64-looking run of 200+ chars in the body.
5. `contains_pii` finds nothing in any string value of the body (minus `allow_terms`).
6. No API key in the body: no field named `api_key`, no configured key value anywhere.
   Keys travel only in headers and never reach a record, log line or event.
"""

import json
import os
import re
import time
import uuid
from collections import deque
from collections.abc import Iterator, Set
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.config import get_settings
from app.models import EgressRecord, StageEvent

ALLOWED_HOSTS = {"api.tavily.com", "api.exa.ai"}
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
MAX_BODY_BYTES = 4096
BASE64_RUN = re.compile(r"[A-Za-z0-9+/=]{200,}")
PREVIEW_CHARS = 300
MAX_RECORDS = 500
LOG_PATH = Path(__file__).resolve().parent.parent / "egress.log"

INTERNET_TIMEOUT = 15.0
LOCAL_TIMEOUT = 120.0  # local vision inference can take a while on a laptop

_REDACTED = "[redacted]"
_TRUTHY = ("1", "true", "yes", "on")

_records: deque[EgressRecord] = deque(maxlen=MAX_RECORDS)
_internet: httpx.AsyncClient | None = None
_local: httpx.AsyncClient | None = None
_offline_override: bool | None = None


class EgressBlocked(Exception):
    """Raised when a rule refuses an outbound request. The attempt is still recorded."""

    def __init__(self, reason: str, record: EgressRecord | None = None):
        super().__init__(reason)
        self.reason = reason
        self.record = record


class LocalHostRefused(ValueError):
    """OLLAMA_HOST points somewhere other than this machine."""


# --- offline switch ---------------------------------------------------------------


def is_offline() -> bool:
    if _offline_override is not None:
        return _offline_override
    return os.getenv("LATENT_OFFLINE", "").strip().lower() in _TRUTHY


def set_offline(value: bool | None) -> None:
    """Runtime air-gap toggle; None falls back to the LATENT_OFFLINE env var."""
    global _offline_override
    _offline_override = value


# --- audit log --------------------------------------------------------------------


def records() -> list[EgressRecord]:
    """Every attempt this session (up to MAX_RECORDS), newest first."""
    return sorted(_records, key=lambda r: r.ts, reverse=True)


def clear_records() -> None:
    _records.clear()


def _append(record: EgressRecord) -> None:
    _records.append(record)
    try:
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(record.model_dump_json() + "\n")
    except OSError:
        pass  # the in-memory log and the UI still have it


# --- secrets ----------------------------------------------------------------------


def _secret_values(headers: dict[str, str]) -> list[str]:
    settings = get_settings()
    values = [settings.tavily_api_key, settings.exa_api_key]
    values += [os.getenv("TAVILY_API_KEY", ""), os.getenv("EXA_API_KEY", "")]
    for value in headers.values():
        value = str(value)
        values.append(value)
        if " " in value:  # "Bearer tvly-..." -> also the bare token
            values.append(value.split(" ", 1)[1])
    # Very short values ("application/json" is fine, "1" is not worth redacting).
    return sorted({v.strip() for v in values if len(v.strip()) >= 8}, key=len, reverse=True)


def _without_api_keys(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _without_api_keys(v) for k, v in value.items() if str(k).lower() != "api_key"}
    if isinstance(value, list | tuple):
        return [_without_api_keys(v) for v in value]
    return value


def _redact(text: str, secrets: list[str]) -> str:
    for secret in secrets:
        text = text.replace(secret, _REDACTED)
    return text


def _preview(body: Any, secrets: list[str]) -> str:
    try:
        text = json.dumps(_without_api_keys(body), ensure_ascii=False)
    except (TypeError, ValueError):
        text = "<unserializable body>"
    return _redact(text, secrets)[:PREVIEW_CHARS]


def _has_api_key_field(value: Any) -> bool:
    if isinstance(value, dict):
        return any(str(k).lower() == "api_key" or _has_api_key_field(v) for k, v in value.items())
    if isinstance(value, list | tuple):
        return any(_has_api_key_field(v) for v in value)
    return False


# --- PII --------------------------------------------------------------------------

# Used only if app.pipeline.scrub (Presidio) cannot be imported; deliberately conservative.
_FALLBACK_PII = {
    "EMAIL_ADDRESS": re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
    "PHONE_NUMBER": re.compile(r"(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b"),
    "US_SSN": re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
    "CREDIT_CARD": re.compile(r"\b(?:\d[ -]?){13,16}\b"),
    "IP_ADDRESS": re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
    "HANDLE": re.compile(r"(?<![\w@])@[A-Za-z0-9_.]{2,30}"),
}


def _fallback_contains_pii(text: str, allow: Set[str] = frozenset()) -> list[str]:
    found = []
    for category, pattern in _FALLBACK_PII.items():
        if any(m.group(0) not in allow for m in pattern.finditer(text)):
            found.append(category)
    return found


def _pii_checker():
    try:
        from app.pipeline import scrub
    except ImportError:
        return _fallback_contains_pii
    return getattr(scrub, "contains_pii", _fallback_contains_pii)


def _strings(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, list | tuple):
        for v in value:
            yield from _strings(v)


def _find_pii(body: Any, allow_terms: Set[str]) -> list[str]:
    check = _pii_checker()
    allow = set(allow_terms)
    found: list[str] = []
    for text in _strings(body):
        for category in check(text, allow=allow):
            if category not in found:
                found.append(category)
    return found


# --- rules ------------------------------------------------------------------------


def _check(url: str, body: Any, payload: bytes | None, allow_terms: Set[str], secrets: list[str]):
    """Return the reason the request must be blocked, or None if it may go."""
    if is_offline():
        return "offline mode"
    parts = urlsplit(url)
    if parts.scheme != "https":
        return f"scheme {parts.scheme or 'none'} not allowed (https only)"
    try:
        port = parts.port
    except ValueError:
        return "invalid port"
    if (parts.hostname or "") not in ALLOWED_HOSTS or parts.username or port not in (None, 443):
        return f"host {parts.hostname or '?'} not in allow-list"
    if payload is None:
        return "body is not JSON-serializable"
    if len(payload) > MAX_BODY_BYTES:
        return f"body {len(payload)} bytes exceeds {MAX_BODY_BYTES}"
    if BASE64_RUN.search(payload.decode("utf-8", "replace")):
        return "base64-like blob in body"
    pii = _find_pii(body, allow_terms)
    if pii:
        return "pii in body: " + ", ".join(pii)
    if _has_api_key_field(body):
        return "api key in body (keys go in headers only)"
    text = payload.decode("utf-8", "replace")
    if any(secret in text for secret in secrets):
        return "api key in body (keys go in headers only)"
    return None


# --- events -----------------------------------------------------------------------


async def _emit(job_id: str | None, record: EgressRecord) -> None:
    if not job_id:
        return
    from app import jobs  # local import: jobs owns the job store

    job = jobs.get_job(job_id)
    if job is None:
        return
    target = f"{record.method} {record.host}{record.path}"
    if record.blocked:
        message = f"network ✕ blocked {target} · {record.bytes_out} bytes · {record.reason}"
    else:
        message = f"network → {target} · {record.bytes_out} bytes · image data: 0 bytes"
    job.result = job.result.model_copy(update={"egress": [*job.result.egress, record]})
    await job.publish(
        StageEvent(
            job_id=job_id,
            seq=len(job.events),
            ts=time.time(),
            stage="search",
            status="error" if record.blocked else "progress",
            message=message,
            local=False,
            data={
                "host": record.host,
                "path": record.path,
                "bytes_out": record.bytes_out,
                "blocked": record.blocked,
                "reason": record.reason,
            },
        )
    )


# --- clients ----------------------------------------------------------------------


def _internet_client() -> httpx.AsyncClient:
    global _internet
    if _internet is None or _internet.is_closed:
        _internet = httpx.AsyncClient(timeout=INTERNET_TIMEOUT, follow_redirects=False)
    return _internet


async def internet_post(
    url: str,
    body: dict,
    headers: dict,
    *,
    job_id: str | None,
    allow_terms: Set[str] = frozenset(),
) -> httpx.Response:
    """POST `body` as JSON to an allow-listed host, or raise EgressBlocked."""
    headers = {str(k): str(v) for k, v in (headers or {}).items()}
    secrets = _secret_values(headers)
    try:
        payload: bytes | None = json.dumps(body).encode()
    except (TypeError, ValueError):
        payload = None
    parts = urlsplit(url)
    reason = _check(url, body, payload, allow_terms, secrets)
    record = EgressRecord(
        id="e_" + uuid.uuid4().hex[:10],
        ts=time.time(),
        method="POST",
        host=_redact(parts.hostname or "", secrets),
        path=_redact(parts.path or "/", secrets),
        bytes_out=len(payload) if payload is not None else 0,
        payload_preview=_preview(body, secrets),
        blocked=reason is not None,
        reason=reason,
    )
    _append(record)
    await _emit(job_id, record)
    if reason is not None:
        raise EgressBlocked(reason, record)
    send_headers = {**headers, "content-type": "application/json"}
    return await _internet_client().post(url, content=payload, headers=send_headers)


def local_host() -> str:
    """OLLAMA_HOST, validated to be loopback. Raises LocalHostRefused otherwise."""
    host = os.getenv("OLLAMA_HOST") or get_settings().ollama_host
    if "://" not in host:
        host = "http://" + host  # Ollama accepts a bare "127.0.0.1:11434"
    parts = urlsplit(host)
    if parts.scheme not in ("http", "https") or (parts.hostname or "") not in LOOPBACK_HOSTS:
        raise LocalHostRefused(f"OLLAMA_HOST must be loopback ({sorted(LOOPBACK_HOSTS)})")
    return host.rstrip("/")


def local_client() -> httpx.AsyncClient:
    """Shared client for Ollama; base_url = OLLAMA_HOST, loopback only."""
    global _local
    base_url = local_host()
    if _local is None or _local.is_closed or str(_local.base_url).rstrip("/") != base_url:
        _local = httpx.AsyncClient(base_url=base_url, timeout=LOCAL_TIMEOUT, trust_env=False)
    return _local


async def aclose() -> None:
    """Close both shared clients (FastAPI lifespan shutdown)."""
    global _internet, _local
    for client in (_internet, _local):
        if client is not None:
            await client.aclose()
    _internet = _local = None
