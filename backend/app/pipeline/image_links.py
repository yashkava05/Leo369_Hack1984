"""Visible screenshot links: local extraction and display, never automatic fetching or search."""

import re
from urllib.parse import parse_qsl, urlsplit

from pydantic import BaseModel, ConfigDict, Field

from app.models import Card, CardAction, Intent
from app.pipeline.cards import card_id


class VisibleLink(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str = Field(max_length=160)
    url: str = Field(max_length=2048)
    truncated: bool = False


class ScreenshotIntent(Intent):
    """Internal vision response only; visible_links never enter the shared Intent contract."""

    visible_links: list[VisibleLink] = Field(default_factory=list, max_length=12)


_PRIVATE_QUERY_KEYS = {
    "token",
    "access_token",
    "auth",
    "api_key",
    "apikey",
    "password",
    "secret",
    "signature",
    "sig",
}
_HOST = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}", re.I)


def visible_url(value: str) -> str | None:
    """Keep the visible path/case/query; add HTTPS only when no scheme was printed."""
    value = value.strip()
    if (
        not value
        or re.search(r"[|<>\\^`{}]", value)
        or "…" in value
        or "..." in value
        or any(c.isspace() or ord(c) < 32 for c in value)
    ):
        return None
    url = value if "://" in value else "https://" + value
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
        _ = parts.port
        if parts.scheme not in {"http", "https"} or parts.username or parts.password:
            return None
        if not _HOST.fullmatch(host) or host.endswith(
            (".localhost", ".local", ".internal", ".lan")
        ):
            return None
        if any(key.lower() in _PRIVATE_QUERY_KEYS for key, _ in parse_qsl(parts.query)):
            return None
    except ValueError:
        return None
    return url


def link_cards(links: list[VisibleLink]) -> list[Card]:
    cards = []
    seen = set()
    for index, link in enumerate(links):
        label = " ".join(link.label.split()) or "Visible link"
        incomplete = link.truncated or "…" in link.url or "..." in link.url
        url = None if incomplete else visible_url(link.url)
        if url:
            if url in seen:
                continue
            seen.add(url)
            cards.append(
                Card(
                    id=card_id("link", url),
                    kind="link",
                    title=label,
                    subtitle=urlsplit(url).hostname,
                    url=url,
                    source="on-device",
                    snippet=url,
                    score=1,
                    actions=[
                        CardAction(label="Open link", type="open_url", url=url),
                        CardAction(label="Copy link", type="copy", text=url),
                    ],
                )
            )
        else:
            cards.append(
                Card(
                    id=card_id("link", f"unreadable:{index}"),
                    kind="link",
                    title=f"{label} — {'incomplete' if incomplete else 'unavailable'}",
                    source="on-device",
                    subtitle=link.url
                    if incomplete or re.search(r"[|<>\\^`{}]", link.url)
                    else None,
                    score=0,
                    snippet=(
                        "The URL is cut off. Upload an expanded view showing the full link."
                        if incomplete
                        else "This link could not be validated as a public website URL."
                    ),
                    actions=[],
                )
            )
    return cards


def links_from_lines(lines: list[str]) -> list[VisibleLink]:
    """Only a recognized Links panel activates OCR extraction; other screenshots stay unchanged."""
    if not any(line.strip().lower() == "links" for line in lines):
        return []
    links = []
    previous = "Visible link"
    for line in lines[:500]:
        value = line.strip()
        truncated = "…" in value or "..." in value
        uncertain_url = bool(
            re.match(r"^(?:https?://)?[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/", value)
            and re.search(r"[|<>\\^`{}]", value)
        )
        if (
            visible_url(value)
            or uncertain_url
            or (truncated and "." in value and not any(c.isspace() for c in value))
        ):
            if len(value) <= 2048:
                links.append(VisibleLink(label=previous[:160], url=value, truncated=truncated))
            if len(links) == 12:
                break
        elif value and value.lower() != "links":
            previous = value
    return links


def native_image_links(image_bytes: bytes) -> list[VisibleLink]:
    """Optional macOS OCR; no subprocess is invoked on other platforms or without Swift."""
    import json
    import shutil
    import subprocess
    import sys
    from pathlib import Path

    if sys.platform != "darwin":
        return []
    swift = shutil.which("swift")
    if not swift:
        return []
    try:
        result = subprocess.run(
            [swift, str(Path(__file__).parent / "native" / "read_text.swift")],
            input=image_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=20,
            check=True,
        )
        lines = json.loads(result.stdout)
        if not isinstance(lines, list) or not all(isinstance(line, str) for line in lines):
            return []
        return links_from_lines(lines)
    except (OSError, subprocess.SubprocessError, ValueError):
        return []
