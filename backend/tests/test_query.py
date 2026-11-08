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
    feed_discovery_query,
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
    # Only the tickets query is restricted to ticketing sites.
    assert qs[0].include_domains == list(qmod.TICKET_DOMAINS)
    assert all(q.include_domains == [] for q in qs[1:])


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


def test_chart_uses_public_org_when_no_topic():
    # Issue #50: the model labels the company as public_org, not topic.
    intent = make_intent("chart", ("public_org", "NVIDIA"), ("metric", "NVDA share price"))
    assert texts(build_queries(intent, now=NOW)) == [
        ("NVIDIA NVDA share price latest data 2026", "context", "finance"),
    ]
    related = qmod.related_query(intent, now=NOW)
    assert related is not None and related.purpose == "related"
    # topic still wins when both are present.
    intent = make_intent(
        "chart", ("public_org", "NVIDIA"), ("topic", "GPU market"), ("metric", "share")
    )
    assert [q.text for q in build_queries(intent, now=NOW)] == ["GPU market share latest data 2026"]


def test_tickets_query_restricted_to_ticket_sites():
    intent = make_intent(
        "event", ("performer", "Lumen Drift"), ("city", "Boston"), ("date", "2026-12-05")
    )
    (q,) = build_queries(intent, now=NOW)
    assert q.purpose == "tickets"
    assert "ticketmaster.com" in q.include_domains
    assert 0 < len(q.include_domains) <= 8
    assert all("/" not in d and "." in d for d in q.include_domains)


def _scrubbed_test_data(name: str) -> Intent:
    from app.pipeline.scrub import scrub_intent

    data = json.loads((Path(__file__).resolve().parent / "data" / f"{name}.json").read_text())
    cleaned, _ = scrub_intent(Intent.model_validate(data["intent"]))
    return cleaned


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        # The repo's own fake book and product: spaCy tags both names as PERSON.
        (
            "tavily_book",
            [
                "The Glass Orchard Mira Calloway book buy",
                "The Glass Orchard Mira Calloway summary review",
            ],
        ),
        (
            "tavily_product",
            ["Aurelo Pulse X2 headphones price", "Aurelo Pulse X2 headphones review"],
        ),
    ],
)
def test_public_names_survive_scrub_and_pii_check(name, expected):
    from app import egress

    intent = _scrubbed_test_data(name)
    qs = build_queries(intent, now=NOW)
    assert [q.text for q in qs] == expected
    # The egress guard gets the same allow-list from the runner and must not block them.
    assert all(egress._find_pii({"query": q.text}, qmod.allow_terms(intent)) == [] for q in qs)


def test_product_ig_shop_builds_queries():
    # Issue #49.
    from app.pipeline.scrub import scrub_intent

    raw = make_intent(
        "product", ("brand", "Stanley"), ("product", "Quencher H2.0 tumbler"), ("price", "$45")
    )
    intent, _ = scrub_intent(raw)
    assert [q.text for q in build_queries(intent, now=NOW)] == [
        "Stanley Quencher H2.0 tumbler price",
        "Stanley Quencher H2.0 tumbler review",
    ]


def test_allow_terms_never_admit_a_private_name():
    intent = make_intent("product", ("brand", "Stanley"), ("product", "tumbler"), ("price", "$45"))
    allow = qmod.allow_terms(intent)
    assert qmod._pii_categories("Stanley tumbler Jane Smith price", allow) == ["PERSON"]
    # Document intents only allow performers/authors, which the document policy drops.
    doc = make_intent("document", ("public_org", "Northwind Labs"), ("topic", "edge AI"))
    assert qmod.allow_terms(doc) == set()


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


@pytest.mark.parametrize(
    ("intent", "expected"),
    [
        (
            make_intent("event", ("event_name", "Nova Fields"), ("city", "Port Aurora")),
            "Nova Fields similar events near Port Aurora",
        ),
        (
            make_intent("product", ("brand", "Aurelo"), ("product", "Pulse X2")),
            "Aurelo similar products",
        ),
        (
            make_intent("book", ("book_title", "The Glass Orchard"), ("author", "Mira Calloway")),
            "The Glass Orchard similar books",
        ),
        (
            make_intent("place", ("place", "Museum of Light"), ("city", "Port Aurora")),
            "Museum of Light similar places near Port Aurora",
        ),
    ],
)
def test_feed_discovery_queries_are_provenance_safe(intent, expected):
    query = feed_discovery_query(intent, now=NOW)
    assert query is not None
    assert query.text == expected
    assert query.purpose == "related"
    assert query.include_domains == []
    assert provenance_ok(query, intent)


def test_feed_discovery_needs_public_location_for_nearby():
    intent = make_intent("event", ("event_name", "Nova Fields"))
    assert feed_discovery_query(intent, now=NOW) is None


def test_template_words_cover_every_literal():
    for tpl in (*qmod._TEMPLATES, *qmod._DISCOVERY_TEMPLATES):
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


def test_property_every_built_query_passes_provenance(monkeypatch):
    # Provenance only: spaCy tags some random strings as names, which would skew the count.
    monkeypatch.setattr(qmod, "_pii_categories", lambda text, allow: [])
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
