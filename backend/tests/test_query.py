import json
import random
import string
import sys
import types
from datetime import date
from pathlib import Path

import pytest

from app.models import Entity, EntityType, Intent, IntentType, SearchQuery
from app.pipeline import query as qmod
from app.pipeline.query import (
    MAX_QUERY_CHARS,
    MAX_QUERY_WORDS,
    TEMPLATE_WORDS,
    build_queries,
    provenance_ok,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
NOW = date(2026, 11, 7)


def fixture_intent(name: str) -> Intent:
    data = json.loads((FIXTURES / f"{name}.result.json").read_text())
    return Intent.model_validate(data["intent"])


def make_intent(intent_type: str, *entities: tuple[str, str], summary: str = "s") -> Intent:
    return Intent(
        intent_type=intent_type,
        summary=summary,
        public_entities=[Entity(type=t, value=v) for t, v in entities],
        redaction_counts={},
        confidence=0.9,
    )


def texts(qs):
    return [(q.text, q.purpose, q.topic) for q in qs]


def test_event_concert_fixture():
    qs = build_queries(fixture_intent("concert_flyer"), now=NOW)
    assert texts(qs) == [
        ("Lumen Drift Boston Dec 5 tickets", "tickets", "general"),
        ("Paradise Rock Club Boston", "place", "general"),
        ("Lumen Drift Paradise Rock Club Dec 5", "context", "news"),
    ]
    assert all(q.include_domains == [] for q in qs)


def test_event_uses_event_name_when_no_performer():
    intent = make_intent(
        "event", ("event_name", "Harbor Jazz Fest"), ("city", "Boston"), ("date", "Aug 3")
    )
    assert texts(build_queries(intent, now=NOW)) == [
        ("Harbor Jazz Fest Boston Aug 3 tickets", "tickets", "general"),
    ]


def test_document_sensitive_fixture():
    qs = build_queries(fixture_intent("sensitive_doc"), now=NOW)
    assert texts(qs) == [
        ("S&P 500 index fund market trends 2026", "context", "general"),
        ("NVIDIA S&P 500 index fund news", "context", "news"),
    ]


def test_product():
    intent = make_intent("product", ("brand", "Sony"), ("product", "WH-1000XM5"), ("price", "$348"))
    assert texts(build_queries(intent, now=NOW)) == [
        ("Sony WH-1000XM5 price", "shopping", "general"),
        ("Sony WH-1000XM5 review", "context", "general"),
    ]


def test_book():
    intent = make_intent("book", ("book_title", "Project Hail Mary"), ("author", "Andy Weir"))
    assert texts(build_queries(intent, now=NOW)) == [
        ("Project Hail Mary Andy Weir book buy", "book", "general"),
        ("Project Hail Mary Andy Weir summary review", "context", "general"),
    ]


def test_place():
    intent = make_intent("place", ("place", "Boston Public Library"), ("city", "Boston"))
    assert texts(build_queries(intent, now=NOW)) == [
        ("Boston Public Library Boston", "place", "general"),
    ]


@pytest.mark.parametrize(
    ("metric", "topic"),
    [("stock price", "finance"), ("quarterly revenue", "finance"), ("rainfall", "general")],
)
def test_chart_topic(metric, topic):
    intent = make_intent("chart", ("topic", "Tesla"), ("metric", metric))
    assert texts(build_queries(intent, now=NOW)) == [
        (f"Tesla {metric} latest data 2026", "context", topic),
    ]


def test_other_falls_back_through_topic_product_place():
    assert texts(build_queries(make_intent("other", ("place", "Fenway Park")), now=NOW)) == [
        ("Fenway Park", "context", "general"),
    ]
    intent = make_intent("other", ("place", "Fenway Park"), ("product", "Kindle"))
    assert [q.text for q in build_queries(intent, now=NOW)] == ["Kindle"]


def test_year_defaults_to_today():
    intent = make_intent("document", ("topic", "solar panels"))
    assert build_queries(intent)[0].text == f"solar panels market trends {date.today().year}"


@pytest.mark.parametrize(
    "intent",
    [
        make_intent("event"),
        make_intent("event", ("time", "20:00"), ("price", "$40")),
        make_intent("product", ("price", "$10")),
        make_intent("book", ("book_title", "Dune")),
        make_intent("chart", ("metric", "revenue")),
        make_intent("other", ("city", "Boston")),
        make_intent("place", ("place", "!!!"), ("city", "Boston")),
    ],
)
def test_no_usable_entities_gives_no_queries(intent):
    assert build_queries(intent, now=NOW) == []


def test_summary_and_redactions_never_used():
    intent = make_intent(
        "place", ("place", "Fenway Park"), ("city", "Boston"), summary="zebrasecret private note"
    )
    intent.redaction_counts = {"phone": 4}
    for q in build_queries(intent, now=NOW):
        low = q.text.lower()
        assert "zebrasecret" not in low and "phone" not in low


def test_normalization_and_limits():
    long = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi"
    intent = make_intent(
        "event",
        ("performer", "  The <Band>!!  *Name*\n\t" + long),
        ("venue", long),
        ("city", "Boston, MA"),
        ("date", "2026-12-05"),
    )
    qs = build_queries(intent, now=NOW)
    assert qs
    for q in qs:
        assert len(q.text) <= MAX_QUERY_CHARS
        assert len(q.text.split()) <= MAX_QUERY_WORDS
        assert not set(q.text) & set("<>!*,\n\t")
        assert provenance_ok(q, intent)
    assert qs[0].text.startswith("The Band Name Alpha")
    assert qs[0].text.endswith("Boston MA Dec 5 tickets")


def test_dedupe_and_cap_three():
    intent = make_intent("other", ("topic", "x"))
    assert len(build_queries(intent, now=NOW)) == 1
    for intent_type in ("event", "product", "book", "chart", "document", "place", "other"):
        rich = make_intent(intent_type, *[(t, f"v{t}") for t in EntityType.__args__])
        qs = build_queries(rich, now=NOW)
        assert len(qs) <= 3
        assert len({q.text for q in qs}) == len(qs)


def test_provenance_rejects_foreign_words():
    intent = fixture_intent("concert_flyer")
    ok = SearchQuery(text="Lumen Drift Boston tickets", purpose="tickets")
    bad = SearchQuery(text="Lumen Drift Boston private party", purpose="tickets")
    empty = SearchQuery(text="  ", purpose="tickets")
    assert provenance_ok(ok, intent)
    assert not provenance_ok(bad, intent)
    assert not provenance_ok(empty, intent)


def test_template_words_cover_every_literal():
    for tpl in qmod._TEMPLATES:
        for part in tpl.parts:
            if isinstance(part, str) and part != qmod._YEAR:
                assert part in TEMPLATE_WORDS


def test_pii_check_drops_flagged_queries(monkeypatch):
    calls = []

    def fake_contains_pii(text, allow=None):
        calls.append((text, allow))
        return ["PERSON"] if "Paradise" in text else []

    fake = types.ModuleType("app.pipeline.scrub")
    fake.contains_pii = fake_contains_pii
    monkeypatch.setitem(sys.modules, "app.pipeline.scrub", fake)

    qs = build_queries(fixture_intent("concert_flyer"), now=NOW)
    assert [q.text for q in qs] == ["Lumen Drift Boston Dec 5 tickets"]
    assert calls and all("Lumen Drift" in allow for _, allow in calls)


def test_pii_check_without_allow_param(monkeypatch):
    fake = types.ModuleType("app.pipeline.scrub")
    fake.contains_pii = lambda text: ["EMAIL_ADDRESS"] if "tickets" in text else []
    monkeypatch.setitem(sys.modules, "app.pipeline.scrub", fake)
    qs = build_queries(fixture_intent("concert_flyer"), now=NOW)
    assert [q.purpose for q in qs] == ["place", "context"]


_ALPHABET = string.ascii_letters + string.digits + string.punctuation + " \t\néü—@#"
_TYPES = list(EntityType.__args__)
_INTENTS = list(IntentType.__args__)


def _random_value(rng: random.Random) -> str:
    if rng.random() < 0.15:
        return f"{rng.randint(1990, 2099)}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}"
    return "".join(rng.choice(_ALPHABET) for _ in range(rng.randint(0, 90)))


def test_property_every_built_query_passes_provenance():
    rng = random.Random(1984)
    built = 0
    for _ in range(3000):
        entities = [(rng.choice(_TYPES), _random_value(rng)) for _ in range(rng.randint(0, 8))]
        intent = make_intent(rng.choice(_INTENTS), *entities, summary=_random_value(rng))
        now = date(rng.randint(2000, 2099), 1, 1)
        qs = build_queries(intent, now=now)
        assert len(qs) <= 3
        for q in qs:
            built += 1
            assert provenance_ok(q, intent), (q.text, entities)
            assert q.text and len(q.text) <= MAX_QUERY_CHARS
            assert len(q.text.split()) <= MAX_QUERY_WORDS
    assert built > 500
