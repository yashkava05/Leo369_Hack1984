"""Deterministic PII scrubber: one or more cases per policy row, plus contains_pii and timing.

Needs `presidio-analyzer` and the spaCy `en_core_web_lg` model (both installed by setup).
"""

import json
import time

import pytest

from app.models import Entity, Intent
from app.pipeline import scrub
from app.pipeline.scrub import ScrubReport, contains_pii, scrub_intent, warm_up


@pytest.fixture(scope="module", autouse=True)
def analyzer() -> None:
    warm_up()


def make_intent(
    intent_type: str, entities: list[tuple[str, str]], summary: str = "A flyer.", counts=None
):
    return Intent(
        intent_type=intent_type,
        summary=summary,
        public_entities=[Entity(type=t, value=v) for t, v in entities],
        redaction_counts=counts or {},
        confidence=0.9,
    )


def values(intent: Intent) -> list[str]:
    return [e.value for e in intent.public_entities]


# (case id, intent type, entities, values that must survive, removed categories)
POLICY_CASES = [
    # Row 1: hard-block categories remove the entity whatever its type.
    (
        "handle-in-event-name",
        "event",
        [("performer", "Lumen Drift"), ("event_name", "Afterparty hosted by @nish_k")],
        ["Lumen Drift"],
        {"HANDLE": 1},
    ),
    (
        "phone-in-product",
        "product",
        [("brand", "Sony"), ("product", "WH-1000XM5 call 617-555-0134")],
        ["Sony"],
        {"PHONE_NUMBER": 1},
    ),
    (
        "email-in-topic",
        "other",
        [("topic", "write to jane.doe@acme.com")],
        [],
        {"EMAIL_ADDRESS": 1},
    ),
    ("account-id-in-topic", "other", [("topic", "invoice INV-2024-77")], [], {"ACCOUNT_ID": 1}),
    ("handle-in-performer", "event", [("performer", "@tameimpala")], [], {"HANDLE": 1}),
    ("credit-card", "other", [("metric", "card 4111 1111 1111 1111")], [], {"CREDIT_CARD": 1}),
    ("ip-address", "other", [("topic", "server at 192.168.10.24")], [], {"IP_ADDRESS": 1}),
    # Row 2: PERSON kept only as performer/author.
    (
        "private-name-as-place",
        "place",
        [("place", "Jane Smith"), ("city", "Boston")],
        ["Boston"],
        {"PERSON": 1},
    ),
    (
        "performer-and-author-kept",
        "book",
        [("author", "Mara Quill"), ("book_title", "Quiet Rivers"), ("performer", "Theo Vance")],
        ["Mara Quill", "Quiet Rivers", "Theo Vance"],
        {},
    ),
    (
        "performer-named-in-event-kept",
        "event",
        [("performer", "Theo Vance"), ("event_name", "Theo Vance Farewell")],
        ["Theo Vance", "Theo Vance Farewell"],
        {},
    ),
    (
        "private-name-in-event-removed",
        "event",
        [("performer", "Lumen Drift"), ("event_name", "Mike Johnson's birthday")],
        ["Lumen Drift"],
        {"PERSON": 1},
    ),
    # Public titles, products, brands and companies spaCy mistakes for people (issue #49).
    (
        "public-product-kept",
        "product",
        [("brand", "Stanley"), ("product", "Quencher H2.0 tumbler"), ("price", "$45")],
        ["Stanley", "Quencher H2.0 tumbler", "$45"],
        {},
    ),
    (
        "invented-book-title-kept",
        "book",
        [("book_title", "The Glass Orchard"), ("author", "Mira Calloway")],
        ["The Glass Orchard", "Mira Calloway"],
        {},
    ),
    (
        "invented-brand-and-product-kept",
        "product",
        [("brand", "Aurelo"), ("product", "Pulse X2 headphones")],
        ["Aurelo", "Pulse X2 headphones"],
        {},
    ),
    (
        "private-name-as-product-removed",
        "product",
        [("brand", "Sony"), ("product", "Marcus Delgado")],
        ["Sony"],
        {"PERSON": 1},
    ),
    (
        "private-name-in-product-removed",
        "product",
        [("brand", "Stanley"), ("product", "Dana Whitfield tumbler")],
        ["Stanley"],
        {"PERSON": 1},
    ),
    (
        "private-name-as-book-title-removed",
        "book",
        [("book_title", "Tomas Lindqvist"), ("author", "Andy Weir")],
        ["Andy Weir"],
        {"PERSON": 1},
    ),
    (
        "private-name-as-public-org-removed",
        "chart",
        [("public_org", "Priya Raman"), ("metric", "share price")],
        ["share price"],
        {"PERSON": 1},
    ),
    (
        "handle-in-product-removed",
        "product",
        [("brand", "Stanley"), ("product", "tumbler from @cozy.corner.finds")],
        ["Stanley"],
        {"HANDLE": 1},
    ),
    (
        "email-in-brand-removed",
        "product",
        [("brand", "orders jane.doe@example.com"), ("product", "Quencher H2.0 tumbler")],
        ["Quencher H2.0 tumbler"],
        {"EMAIL_ADDRESS": 1},
    ),
    (
        "phone-in-book-title-removed",
        "book",
        [("book_title", "The Glass Orchard 617-555-0134")],
        [],
        {"PHONE_NUMBER": 1},
    ),
    (
        "public-name-rule-not-for-documents",
        "document",
        [("product", "Quencher H2.0 tumbler"), ("public_org", "Jane Doe")],
        [],
        {"PERSON": 2},
    ),
    # Row 3: document intents keep only topic/public_org/product.
    (
        "document-revenue-figure-dropped",
        "document",
        [
            ("public_org", "Northwind Labs"),
            ("topic", "S&P 500 index fund"),
            ("product", "Brokerage account"),
            ("metric", "Q3 revenue $4.2M"),
            ("price", "$1,250"),
            ("date", "2026-09-30"),
            ("author", "Sarah Lee"),
        ],
        ["Northwind Labs", "S&P 500 index fund", "Brokerage account"],
        {"DOCUMENT_POLICY": 4},
    ),
    # Row 4: six or more digits in a row, unless date/time/price.
    ("long-number-in-product", "product", [("product", "Item 88231904")], [], {"LONG_NUMBER": 1}),
    (
        "long-number-exempt-types",
        "event",
        [("date", "20261114"), ("time", "203000"), ("price", "1000000 JPY")],
        ["20261114", "203000", "1000000 JPY"],
        {},
    ),
    ("five-digits-kept", "place", [("venue", "Pier 12345")], ["Pier 12345"], {}),
]


@pytest.mark.parametrize(
    ("intent_type", "entities", "kept", "removed"),
    [case[1:] for case in POLICY_CASES],
    ids=[case[0] for case in POLICY_CASES],
)
def test_policy(intent_type, entities, kept, removed) -> None:
    cleaned, report = scrub_intent(make_intent(intent_type, entities))
    assert values(cleaned) == kept
    assert report.removed == removed
    assert report.kept == len(kept)


def test_dropped_entity_types_are_types_only() -> None:
    _, report = scrub_intent(
        make_intent(
            "event", [("place", "Jane Smith"), ("event_name", "party @nish_k"), ("city", "Boston")]
        )
    )
    assert report.dropped_entity_types == ["place", "event_name"]


def test_report_never_contains_values() -> None:
    secrets = ["Jane Smith", "jane.doe@acme.com", "@nish_k", "617-555-0134", "88231904"]
    intent = make_intent(
        "event",
        [
            ("place", secrets[0]),
            ("topic", secrets[1]),
            ("event_name", secrets[2]),
            ("product", secrets[4]),
        ],
        summary=f"Flyer from Jane Smith, call 617-555-0134 or mail {secrets[1]}",
    )
    _, report = scrub_intent(intent)
    dumped = json.dumps(report.model_dump())
    for secret in secrets:
        assert secret not in dumped


def test_summary_person_replaced_performer_kept() -> None:
    intent = make_intent(
        "event",
        [("performer", "Theo Vance")],
        summary="Theo Vance plays Boston; flyer sent by Jane Smith",
    )
    cleaned, report = scrub_intent(intent)
    assert cleaned.summary == "Theo Vance plays Boston; flyer sent by [person]"
    assert report.removed == {"PERSON": 1}


def test_summary_hard_block_and_long_numbers_replaced() -> None:
    cleaned, report = scrub_intent(
        make_intent("other", [], summary="Receipt 12345678 emailed to jane.doe@acme.com by @nish_k")
    )
    assert cleaned.summary == "Receipt [number] emailed to [email_address] by [handle]"
    assert report.removed == {"EMAIL_ADDRESS": 1, "HANDLE": 1, "LONG_NUMBER": 1}


def test_redaction_counts_merged_lowercase() -> None:
    intent = make_intent(
        "event",
        [("event_name", "party @nish_k"), ("venue", "DM @someone_else"), ("city", "Boston")],
        counts={"handle": 2, "email": 1},
    )
    cleaned, report = scrub_intent(intent)
    assert report.removed == {"HANDLE": 2}
    assert cleaned.redaction_counts == {"handle": 4, "email": 1}


def test_clean_intent_unchanged() -> None:
    intent = make_intent(
        "event",
        [
            ("performer", "Lumen Drift"),
            ("venue", "Paradise Rock Club"),
            ("city", "Boston"),
            ("date", "2026-11-14"),
        ],
        summary="Lumen Drift concert flyer for Paradise Rock Club in Boston.",
        counts={"handle": 1},
    )
    cleaned, report = scrub_intent(intent)
    assert cleaned == intent
    assert report == ScrubReport(removed={}, dropped_entity_types=[], kept=4)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("tame impala boston tickets", []),
        ("email jane.doe@acme.com", ["EMAIL_ADDRESS"]),
        ("call me at 617-555-0134 @nish_k", ["PHONE_NUMBER", "HANDLE"]),
        ("order #A12345-XY status", ["ACCOUNT_ID"]),
        ("social security number 536-22-1234", ["US_SSN"]),
        ("dinner with Jane Smith", ["PERSON"]),
        ("", []),
    ],
)
def test_contains_pii(text: str, expected: list[str]) -> None:
    assert contains_pii(text) == expected


def test_contains_pii_allow_list() -> None:
    assert contains_pii("Theo Vance tickets Boston") == ["PERSON"]
    assert contains_pii("Theo Vance tickets Boston", allow={"theo vance"}) == []
    assert contains_pii("Theo Vance and Jane Smith", allow={"Theo Vance"}) == ["PERSON"]
    assert contains_pii("Theo Vance Farewell tickets", allow={"Theo Vance"}) == []
    # spaCy tags "Hail Mary Theo Vance" as one name; the title word left over is not a name.
    assert contains_pii("Hail Mary Theo Vance book", allow={"Theo Vance"}) == []
    assert contains_pii("Theo Vance with Jane Smith", allow={"Theo Vance"}) == ["PERSON"]


# Private names, handles and emails planted in eval/expected.json. The public-name rule must not
# let any of them through when the model labels one as a title, product, brand or company.
PLANTED = [
    "Priya Raman",
    "Marcus Delgado",
    "Tomas Lindqvist",
    "Aisha Bello",
    "Jane Doe",
    "Ravi Menon",
    "Maya Chen",
    "Leo Fischer",
    "Sam Ortiz",
    "Dr. Kowalski",
    "@harbor_gig_guide",
    "@lena.okafor99",
    "@cozy.corner.finds",
    "@jaybird_writes",
    "@maya.c",
    "jane.doe@example.com",
    "ravi.menon@example.com",
]


@pytest.mark.parametrize("entity_type", ["product", "brand", "book_title", "public_org"])
def test_planted_private_values_still_removed_as_public_names(entity_type: str) -> None:
    intent_type = "book" if entity_type == "book_title" else "product"
    for planted in PLANTED:
        cleaned, report = scrub_intent(
            make_intent(intent_type, [("brand", "Stanley"), (entity_type, planted)])
        )
        assert planted.lower() not in json.dumps(cleaned.model_dump()).lower(), planted
        assert report.kept == 1, planted


@pytest.mark.parametrize(
    ("span", "shaped"),
    [
        ("Marcus Delgado", True),
        ("Anna de Vries", True),
        ("Mike Johnson's", True),
        ("Dr. Kowalski", True),
        ("Kowalski MD", True),
        ("The Glass Orchard", False),
        ("Aurelo Pulse X2", False),
        ("Quencher", False),
        ("Stanley tumbler", False),
    ],
)
def test_name_shaped(span: str, shaped: bool) -> None:
    assert scrub._name_shaped(span) is shaped


def test_allow_terms_only_kept_public_names() -> None:
    cleaned, _ = scrub_intent(
        make_intent(
            "product",
            [("brand", "Stanley"), ("product", "Marcus Delgado"), ("price", "$45")],
        )
    )
    assert scrub.allow_terms(cleaned) == {"Stanley"}
    doc, _ = scrub_intent(
        make_intent("document", [("public_org", "Northwind Labs"), ("topic", "edge AI")])
    )
    assert scrub.allow_terms(doc) == set()


def test_lone_word_not_a_person() -> None:
    cleaned, _ = scrub_intent(make_intent("product", [("product", "Kindle")]))
    assert values(cleaned) == ["Kindle"]
    assert contains_pii("Kindle") == []


def test_analyzer_built_once() -> None:
    first = scrub._get_analyzer()
    warm_up()
    contains_pii("hello")
    assert scrub._get_analyzer() is first


def test_contains_pii_under_50ms() -> None:
    text = (
        "Lumen Drift live at Paradise Rock Club Boston Nov 14 8pm, tickets from $89, "
        "presale code inside, doors 7pm, all ages bar"
    )
    assert len(text) == 120
    contains_pii(text)
    runs = 20
    start = time.perf_counter()
    for _ in range(runs):
        contains_pii(text)
    avg_ms = (time.perf_counter() - start) / runs * 1000
    print(f"contains_pii avg {avg_ms:.1f} ms over {runs} runs ({len(text)} chars)")
    assert avg_ms < 50
