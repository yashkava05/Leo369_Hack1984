"""extract_intent: preprocessing, the Ollama call shape, retry/fallback, clamping and events.

Unit tests mock Ollama with an httpx.MockTransport. The live test (`-m ollama`) runs the real
model on every eval screenshot and prints the Intent JSON.
"""

import base64
import io
import json
import os
from pathlib import Path

import httpx
import pytest
from PIL import Image

from app.config import get_settings
from app.models import Entity, Intent
from app.pipeline import extract
from app.pipeline.extract import (
    FALLBACK_INTENT,
    ImageRejected,
    clamp,
    extract_intent,
    preprocess,
)
from app.pipeline.prompts import SYSTEM_PROMPT

OLLAMA = "http://ollama.test:11434"
EVAL_DIR = Path(__file__).resolve().parents[2] / "eval"

CONCERT = {
    "intent_type": "event",
    "summary": "Tame Impala concert at TD Garden in Boston on Nov 15",
    "public_entities": [
        {"type": "performer", "value": "Tame Impala"},
        {"type": "venue", "value": "TD Garden"},
        {"type": "city", "value": "Boston"},
        {"type": "date", "value": "Nov 15"},
    ],
    "redaction_counts": {"handle": 2, "message_text": 2, "ui_chrome": 2},
    "confidence": 0.92,
}
PRODUCT = {
    "intent_type": "product",
    "summary": "Sony WH-1000XM5 wireless headphones",
    "public_entities": [
        {"type": "brand", "value": "Sony"},
        {"type": "product", "value": "WH-1000XM5"},
    ],
    "redaction_counts": {"name": 1, "account": 1, "address": 1},
    "confidence": 0.9,
}
BOOK = {
    "intent_type": "book",
    "summary": "Project Hail Mary by Andy Weir",
    "public_entities": [
        {"type": "book_title", "value": "Project Hail Mary"},
        {"type": "author", "value": "Andy Weir"},
    ],
    "redaction_counts": {"name": 2, "message_text": 1},
    "confidence": 0.88,
}
DOCUMENT = {
    "intent_type": "document",
    "summary": "Pricing in the edge AI accelerator market",
    "public_entities": [{"type": "topic", "value": "edge AI accelerators"}],
    "redaction_counts": {"name": 2, "email": 2, "internal_name": 3, "confidential_figure": 4},
    "confidence": 0.8,
}


def png_bytes(size=(1600, 900), exif=None, fmt="PNG") -> bytes:
    img = Image.new("RGB", size, (240, 240, 240))
    out = io.BytesIO()
    kwargs = {"exif": exif} if exif is not None else {}
    img.save(out, format=fmt, **kwargs)
    return out.getvalue()


def gps_exif(orientation: int | None = None) -> Image.Exif:
    exif = Image.Exif()
    exif[0x010F] = "PhoneMaker"  # Make
    exif[0x8825] = {1: "N", 2: (42.0, 21.0, 0.0)}  # GPSInfo
    if orientation:
        exif[0x0112] = orientation
    return exif


def chat_reply(content) -> httpx.Response:
    body = content if isinstance(content, str) else json.dumps(content)
    return httpx.Response(200, json={"message": {"role": "assistant", "content": body}})


class FakeOllama:
    """MockTransport that records every request and replays canned replies in order."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply if isinstance(reply, httpx.Response) else chat_reply(reply)

    def bodies(self) -> list[dict]:
        return [json.loads(r.content) for r in self.requests]


class Events(list):
    async def __call__(self, stage: str, status: str, message: str) -> None:
        self.append((stage, status, message))


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    monkeypatch.setenv("OLLAMA_HOST", OLLAMA)
    monkeypatch.setenv("LATENT_MODEL", "qwen2.5vl:3b")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def ollama(monkeypatch):
    def install(*replies) -> FakeOllama:
        fake = FakeOllama(*replies)
        monkeypatch.setattr(
            extract, "_make_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(fake))
        )
        return fake

    return install


# --- preprocessing -----------------------------------------------------------------------


def test_preprocess_downscales_and_strips_metadata():
    out, size = preprocess(png_bytes((2560, 1440), exif=gps_exif(), fmt="JPEG"))
    assert size == (1280, 720)
    img = Image.open(io.BytesIO(out))
    assert img.format == "PNG" and img.size == (1280, 720) and img.mode == "RGB"
    assert not img.getexif()
    assert not img.info.get("exif")


def test_preprocess_applies_exif_orientation():
    # Orientation 6 = rotate 90° clockwise to display; a 200×100 sensor image shows as 100×200.
    _, size = preprocess(png_bytes((200, 100), exif=gps_exif(orientation=6), fmt="JPEG"))
    assert size == (100, 200)


def test_preprocess_keeps_small_images_unscaled():
    _, size = preprocess(png_bytes((800, 600)))
    assert size == (800, 600)


@pytest.mark.parametrize("data", [png_bytes((63, 400)), b"not an image", b""])
def test_preprocess_rejects_tiny_or_garbage(data):
    with pytest.raises(ImageRejected):
        preprocess(data)


async def test_rejected_image_emits_error_and_never_calls_ollama(ollama):
    fake = ollama()
    events = Events()
    with pytest.raises(ImageRejected):
        await extract_intent(b"\x89PNG garbage", events)
    assert events[-1][:2] == ("extract", "error")
    assert fake.requests == []


# --- the Ollama call ---------------------------------------------------------------------


async def test_concert_flyer_request_shape_and_result(ollama):
    fake = ollama(CONCERT)
    events = Events()
    intent = await extract_intent(png_bytes((2560, 1440), exif=gps_exif(), fmt="JPEG"), events)

    assert intent.intent_type == "event"
    values = {e.value for e in intent.public_entities}
    assert {"Tame Impala", "Boston", "Nov 15"} <= values
    assert intent.redaction_counts["handle"] == 2

    (body,) = fake.bodies()
    assert str(fake.requests[0].url) == f"{OLLAMA}/api/chat"
    assert body["model"] == "qwen2.5vl:3b"
    assert body["format"] == Intent.model_json_schema()
    assert body["options"] == {"temperature": 0}
    assert body["stream"] is False and body["keep_alive"] == "30m"
    system, user = body["messages"]
    assert system == {"role": "system", "content": SYSTEM_PROMPT}
    assert user["content"] == "Extract the intent from this screenshot."
    sent = Image.open(io.BytesIO(base64.b64decode(user["images"][0])))
    assert sent.format == "PNG" and sent.size == (1280, 720) and not sent.getexif()


@pytest.mark.parametrize(
    ("reply", "kind", "expected"),
    [
        (PRODUCT, "product", {"Sony", "WH-1000XM5"}),
        (BOOK, "book", {"Project Hail Mary", "Andy Weir"}),
        (DOCUMENT, "document", {"edge AI accelerators"}),
    ],
)
async def test_other_intent_types_parse(ollama, reply, kind, expected):
    ollama(reply)
    intent = await extract_intent(png_bytes(), Events())
    assert intent.intent_type == kind
    assert {e.value for e in intent.public_entities} == expected


async def test_events_follow_the_terminal_format(ollama):
    ollama(CONCERT)
    events = Events()
    await extract_intent(png_bytes((1280, 720)), events)
    assert [(s, st) for s, st, _ in events] == [
        ("extract", "start"),
        ("extract", "progress"),
        ("extract", "ok"),
    ]
    assert events[0][2] == "Reading image on-device (1280×720, metadata stripped)"
    assert events[1][2] == "Running qwen2.5vl:3b locally…"
    assert events[2][2].startswith(
        "intent: event · 4 public entities · 6 private items withheld · "
    )
    assert events[2][2].endswith(" s")


async def test_only_ollama_host_is_contacted(ollama):
    fake = ollama("{broken", CONCERT)
    await extract_intent(png_bytes(), Events())
    assert len(fake.requests) == 2
    assert {(r.url.scheme, r.url.host, r.url.port) for r in fake.requests} == {
        ("http", "ollama.test", 11434)
    }


# --- retry and fallback ------------------------------------------------------------------


async def test_malformed_output_is_retried_with_the_error(ollama):
    bad = dict(CONCERT, intent_type="concert")
    fake = ollama(bad, CONCERT)
    events = Events()
    intent = await extract_intent(png_bytes(), events)
    assert intent.intent_type == "event"
    first, second = fake.bodies()
    assert first["messages"][1]["content"] == "Extract the intent from this screenshot."
    retry_text = second["messages"][1]["content"]
    assert retry_text.startswith("Extract the intent from this screenshot.")
    assert "intent_type" in retry_text and "not valid" in retry_text
    assert second["messages"][1]["images"] == first["messages"][1]["images"]
    assert any("retrying" in m for _, _, m in events)


@pytest.mark.parametrize(
    "replies",
    [
        ("not json", "{still not json"),
        ({"intent_type": "event"}, dict(CONCERT, extra_field=1)),
        (httpx.Response(200, json={"done": True}), httpx.Response(200, text="<html>")),
    ],
)
async def test_second_failure_degrades_to_other(ollama, replies):
    fake = ollama(*replies)
    events = Events()
    intent = await extract_intent(png_bytes(), events)
    assert intent == FALLBACK_INTENT
    assert len(fake.requests) == 2
    assert events[-1][1] == "ok" and events[-1][2].startswith("intent: other")


async def test_timeout_emits_error_and_raises(ollama):
    ollama(httpx.ReadTimeout("slow"))
    events = Events()
    with pytest.raises(httpx.TimeoutException):
        await extract_intent(png_bytes(), events)
    assert events[-1] == ("extract", "error", "Local model timed out after 90 s")


async def test_ollama_down_emits_error_and_raises(ollama):
    ollama(httpx.ConnectError("refused"))
    events = Events()
    with pytest.raises(httpx.ConnectError):
        await extract_intent(png_bytes(), events)
    assert events[-1][:2] == ("extract", "error")


async def test_http_error_status_raises(ollama):
    ollama(httpx.Response(404, json={"error": "model 'qwen2.5vl:3b' not found"}))
    with pytest.raises(httpx.HTTPStatusError):
        await extract_intent(png_bytes(), Events())


def test_request_timeout_is_90s():
    assert extract.OLLAMA_TIMEOUT_S == 90


# --- clamping ----------------------------------------------------------------------------


def test_clamp_drops_dedupes_and_caps_entities():
    raw = Intent(
        intent_type="event",
        summary="x" * 200,
        public_entities=[
            Entity(type="performer", value="Tame Impala"),
            Entity(type="performer", value="tame  impala"),
            Entity(type="city", value="   "),
            Entity(type="topic", value="y" * 81),
            *[Entity(type="topic", value=f"topic {i}") for i in range(20)],
        ],
        redaction_counts={"handle": 2, "name": 0, "Jo Smith": 1, "secret_stuff": 2},
        confidence=1.7,
    )
    out = clamp(raw)
    values = [e.value for e in out.public_entities]
    assert len(values) == 12
    assert values[0] == "Tame Impala" and values[1] == "topic 0"
    assert out.redaction_counts == {"handle": 2, "other": 3}
    assert len(out.summary) == 140
    assert out.confidence == 1.0


async def test_extract_clamps_model_output(ollama):
    reply = dict(
        CONCERT,
        public_entities=CONCERT["public_entities"] + [{"type": "city", "value": "BOSTON"}],
        confidence=-0.3,
    )
    ollama(reply)
    intent = await extract_intent(png_bytes(), Events())
    assert [e.value for e in intent.public_entities].count("Boston") == 1
    assert len(intent.public_entities) == 4
    assert intent.confidence == 0.0


# --- prompt ------------------------------------------------------------------------------


def test_prompt_covers_every_type_and_redaction_category():
    for kind in ("event", "product", "book", "place", "chart", "document", "other"):
        assert f"- {kind}:" in SYSTEM_PROMPT
    for category in extract.REDACTION_CATEGORIES:
        assert f"- {category}:" in SYSTEM_PROMPT
    assert "Project Heron" in SYSTEM_PROMPT and "SSD controller market" in SYSTEM_PROMPT


def test_few_shots_do_not_reuse_eval_strings():
    expected = EVAL_DIR / "expected.json"
    spec = json.loads(expected.read_text()) if expected.exists() else None
    if not spec or not isinstance(spec, dict):
        pytest.skip("eval set not present")
    planted = {s.lower() for item in spec.values() for s in item["must_not_appear"]}
    prompt = SYSTEM_PROMPT.lower()
    assert [s for s in planted if s in prompt] == []


# --- live --------------------------------------------------------------------------------


@pytest.mark.ollama
async def test_live_eval_screenshots():
    get_settings.cache_clear()
    os.environ.pop("OLLAMA_HOST", None)  # use the real .env / default host
    shots = sorted((EVAL_DIR / "screenshots").glob("*.png"))
    if not shots:
        pytest.skip("no eval screenshots")
    try:
        httpx.get(f"{get_settings().ollama_host}/api/version", timeout=2).raise_for_status()
    except httpx.HTTPError:
        pytest.skip("Ollama is not running")
    for shot in shots:
        events = Events()
        intent = await extract_intent(shot.read_bytes(), events)
        print(f"\n{shot.name}: {events[-1][2]}\n{intent.model_dump_json(indent=2)}")
