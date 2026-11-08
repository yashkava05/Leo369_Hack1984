"""Reviewed input stays local; malformed model replies never enter diagnostics."""

import json
from datetime import date
from types import SimpleNamespace

import httpx
import pytest

from app.models import Intent
from app.pipeline import text_intent


class Events(list):
    async def __call__(self, *event):
        self.append(event)


EVENT = {
    "intent_type": "event",
    "summary": "AI events in Boston",
    "public_entities": [
        {"type": "topic", "value": "AI"},
        {"type": "city", "value": "Boston"},
        {"type": "date", "value": "2026-11-07"},
    ],
    "redaction_counts": {"email": 1},
    "confidence": 0.9,
}


@pytest.fixture
def local(monkeypatch):
    clients = []
    monkeypatch.setattr(text_intent, "get_settings", lambda: SimpleNamespace(latent_model="local"))

    def install(*replies):
        requests = []
        pending = iter(replies)

        def transport(request):
            requests.append(request)
            reply = next(pending)
            if isinstance(reply, Exception):
                raise reply
            if isinstance(reply, httpx.Response):
                return reply
            return httpx.Response(
                200,
                json={
                    "message": {"content": reply if isinstance(reply, str) else json.dumps(reply)}
                },
            )

        client = httpx.AsyncClient(
            base_url="http://127.0.0.1:11434", transport=httpx.MockTransport(transport)
        )
        clients.append(client)
        monkeypatch.setattr(text_intent.egress, "local_client", lambda: client)
        return requests

    yield install


@pytest.mark.parametrize("text", ["", " \n ", "x" * 1001, None, 123])
async def test_invalid_input_never_calls_client(local, text):
    requests = local()
    with pytest.raises(ValueError, match="^invalid_text$"):
        await text_intent.extract_text_intent(text, Events())
    assert requests == []


def test_normalize_text_public_validation_helper():
    assert text_intent.normalize_text("  hello\n  world\t ") == "hello world"
    assert text_intent.normalize_text(" x" * 500 + " ") == " ".join(["x"] * 500)
    assert len(text_intent.normalize_text("x" * 1000)) == 1000


async def test_local_request_fixed_date_and_privacy_prompt(local, caplog):
    requests = local(EVENT)
    events = Events()
    private = "fake.person@example.test"
    result = await text_intent.extract_text_intent(
        f" Find AI events in Boston this weekend\n {private}", events, now=date(2026, 11, 6)
    )
    assert result.public_entities[-1].value == "2026-11-07"
    (request,) = requests
    assert str(request.url) == "http://127.0.0.1:11434/api/chat"
    body = json.loads(request.content)
    assert body["model"] == "local" and body["format"] == Intent.model_json_schema()
    assert body["options"] == {"temperature": 0} and body["stream"] is False
    system, user = body["messages"]
    assert "2026-11-06" in system["content"]
    assert "untrusted user text" in system["content"]
    assert "values must come only from that text" in system["content"]
    assert "redaction counts" in system["content"]
    assert "device location" in system["content"]
    assert "images" not in user and "\n" not in user["content"]
    assert private not in repr(events) + caplog.text
    assert events[-1][:2] == ("extract", "ok")


async def test_defaults_to_current_local_date(local):
    requests = local(EVENT)
    await text_intent.extract_text_intent("AI events", Events())
    assert date.today().isoformat() in json.loads(requests[0].content)["messages"][0]["content"]


async def test_one_schema_repair_without_echoing_private_output(local, caplog):
    private = "fake private model output"
    requests = local(private, EVENT)
    events = Events()
    intent = await text_intent.extract_text_intent("AI events in Boston", events)
    assert intent.intent_type == "event" and len(requests) == 2
    second = json.loads(requests[1].content)
    assert private not in requests[1].content.decode() + caplog.text + repr(events)
    assert "schema" in second["messages"][-1]["content"]


@pytest.mark.parametrize(
    "replies",
    [
        ("private junk", "private junk"),
        (httpx.Response(200, json={"bad": "private"}), httpx.Response(200, text="private")),
        (httpx.ReadTimeout("private"),),
        (httpx.ConnectError("private"),),
        (httpx.Response(500, text="private"),),
        (dict(EVENT, public_entities=[{"type": "private", "value": "private"}]), "private"),
    ],
)
async def test_errors_constant_and_no_exception_context(local, caplog, replies):
    requests = local(*replies)
    events = Events()
    with pytest.raises(ValueError) as error:
        await text_intent.extract_text_intent("private transcript", events)
    assert str(error.value) == "text_intent_unavailable"
    assert error.value.__context__ is None and error.value.__cause__ is None
    assert len(requests) <= 2
    assert "private" not in caplog.text + repr(events) + str(error.value)


async def test_shared_client_creation_failure_is_safe(monkeypatch):
    def fail():
        raise RuntimeError("private hostname")

    monkeypatch.setattr(text_intent.egress, "local_client", fail)
    with pytest.raises(ValueError, match="^text_intent_unavailable$") as error:
        await text_intent.extract_text_intent("AI", Events())
    assert error.value.__context__ is None


async def test_uses_existing_clamp(local):
    local(
        dict(
            EVENT,
            confidence=2,
            summary="x" * 200,
            redaction_counts={"fake private key": 2, "email": 1},
            public_entities=EVENT["public_entities"] * 7,
        )
    )
    intent = await text_intent.extract_text_intent("AI Boston", Events())
    assert intent.confidence == 1 and len(intent.summary) == 140
    assert len(intent.public_entities) == 3
    assert intent.redaction_counts == {"other": 2, "email": 1}


@pytest.mark.parametrize("today", [date(2026, 11, 6), date(2026, 11, 7), date(2026, 11, 8)])
async def test_weekend_reference_handles_friday_saturday_and_sunday(local, today):
    requests = local(EVENT)
    await text_intent.extract_text_intent("Find AI events this weekend", Events(), now=today)
    prompt = json.loads(requests[0].content)["messages"][0]["content"]
    assert 'date "2026-11-07"' in prompt
    assert today.isoformat() in prompt
    assert "never copy them unless supported by the user text" in prompt


async def test_retries_an_event_that_dropped_its_public_subject(local, caplog):
    incomplete = dict(
        EVENT,
        summary="private model summary",
        public_entities=[{"type": "city", "value": "Boston"}],
    )
    requests = local(incomplete, EVENT)
    events = Events()
    result = await text_intent.extract_text_intent("Show concerts or events in Boston", events)
    assert any(entity.type == "topic" for entity in result.public_entities)
    assert len(requests) == 2
    repair = json.loads(requests[1].content)["messages"][-1]["content"]
    assert "public subject" in repair
    assert "private model summary" not in repair + repr(events) + caplog.text


async def test_missing_subject_retry_stays_bounded_without_inventing_a_subject(local):
    incomplete = dict(EVENT, public_entities=[{"type": "city", "value": "Boston"}])
    requests = local(incomplete, incomplete)
    result = await text_intent.extract_text_intent("Boston", Events())
    assert len(requests) == 2
    assert [(entity.type, entity.value) for entity in result.public_entities] == [
        ("city", "Boston")
    ]
