"""Sanitized search query construction.

Queries are built deterministically from the scrubbed public entities of an
``Intent`` and a fixed set of template words. The summary, redaction counts and
any free model text are never read, so every word of an outbound query can be
traced to either a public entity value or ``TEMPLATE_WORDS``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date

from app.models import EntityType, Intent, SearchQuery

MAX_VALUE_CHARS = 60
MAX_QUERY_CHARS = 120
MAX_QUERY_WORDS = 14
MAX_QUERIES = 3

_ALLOWED_PUNCT = set(" &'.:-/$")
_ISO_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
_FINANCE_WORDS = ("stock", "revenue", "price", "market")

# Words the templates themselves add. Month abbreviations come from rendering ISO
# dates ("2026-12-05" -> "Dec 5"); years come from the `{year}` slot (now.year).
TEMPLATE_WORDS: set[str] = {
    "tickets",
    "price",
    "review",
    "book",
    "buy",
    "summary",
    "latest",
    "data",
    "market",
    "trends",
    "news",
    "similar",
    "events",
    "products",
    "books",
    "places",
    "near",
    *_MONTHS,
    *(str(y) for y in range(2000, 2100)),
}

# Ticketing sites the tickets query is restricted to, so real searches return ticket pages.
TICKET_DOMAINS: tuple[str, ...] = (
    "ticketmaster.com",
    "livenation.com",
    "axs.com",
    "seatgeek.com",
    "dice.fm",
    "eventbrite.com",
)

# A slot is a tuple of entity types (the first type present wins) or the year marker.
_YEAR = "year"
Slot = tuple[EntityType, ...] | str


@dataclass(frozen=True)
class _Template:
    intent_type: str
    purpose: str
    parts: tuple[Slot, ...]  # entity slots, `_YEAR`, or literal template words
    topic: str = "general"
    include_domains: tuple[str, ...] = ()


def _s(*types: EntityType) -> tuple[EntityType, ...]:
    return types


_TEMPLATES: tuple[_Template, ...] = (
    _Template(
        "event",
        "tickets",
        (_s("performer", "event_name"), _s("city"), _s("date"), "tickets"),
        include_domains=TICKET_DOMAINS,
    ),
    _Template("event", "place", (_s("venue"), _s("city"))),
    _Template("event", "context", (_s("performer", "event_name"), _s("venue"), _s("date")), "news"),
    _Template("product", "shopping", (_s("brand"), _s("product"), "price")),
    _Template("product", "context", (_s("brand"), _s("product"), "review")),
    _Template("book", "book", (_s("book_title"), _s("author"), "book", "buy")),
    _Template("book", "context", (_s("book_title"), _s("author"), "summary", "review")),
    _Template("place", "place", (_s("place"), _s("city"))),
    _Template(
        "chart", "context", (_s("topic", "public_org"), _s("metric"), "latest", "data", _YEAR)
    ),
    _Template("document", "context", (_s("topic"), "market", "trends", _YEAR)),
    _Template("document", "context", (_s("public_org"), _s("topic"), "news"), "news"),
    _Template("other", "context", (_s("topic", "product", "place"),)),
)


def normalize(value: str) -> str:
    """Keep letters, digits, space and ``&'.:-/$``; collapse whitespace; cap at 60 chars."""
    kept = "".join(ch if ch.isalnum() or ch in _ALLOWED_PUNCT else " " for ch in value)
    text = " ".join(kept.split())
    if len(text) > MAX_VALUE_CHARS:
        cut = text[:MAX_VALUE_CHARS]
        # Cut at a word boundary when one exists so no word is split in half.
        text = cut.rsplit(" ", 1)[0] if " " in cut else cut
    return text.strip()


def _render(entity_type: EntityType, value: str) -> str:
    if entity_type == "date":
        m = _ISO_DATE.match(value.strip())
        if m and 1 <= int(m.group(2)) <= 12:
            return f"{_MONTHS[int(m.group(2)) - 1].capitalize()} {int(m.group(3))}"
    return normalize(value)


def _first_values(intent: Intent) -> dict[str, str]:
    """First non-empty rendered value of each entity type."""
    out: dict[str, str] = {}
    for ent in intent.public_entities:
        if ent.type in out:
            continue
        rendered = _render(ent.type, ent.value)
        if rendered:
            out[ent.type] = rendered
    return out


def _fit(pieces: list[list[str]], entity_idx: list[int]) -> str:
    """Join word lists, trimming the longest entity value until length limits hold."""
    while True:
        words = [w for piece in pieces for w in piece]
        text = " ".join(words)
        if len(words) <= MAX_QUERY_WORDS and len(text) <= MAX_QUERY_CHARS:
            return text
        trimmable = [i for i in entity_idx if len(pieces[i]) > 1]
        if not trimmable:
            return ""
        longest = max(trimmable, key=lambda i: len(" ".join(pieces[i])))
        pieces[longest] = pieces[longest][:-1]


def _topic_for(tpl: _Template, values: dict[str, str]) -> str:
    if tpl.intent_type == "chart":
        haystack = f"{values.get('metric', '')} {values.get('topic', '')}".lower()
        return "finance" if any(w in haystack for w in _FINANCE_WORDS) else "general"
    return tpl.topic


def _build_one(tpl: _Template, values: dict[str, str], year: int) -> SearchQuery | None:
    pieces: list[list[str]] = []
    entity_idx: list[int] = []
    for part in tpl.parts:
        if isinstance(part, tuple):
            value = next((values[t] for t in part if t in values), None)
            if value is None:
                return None
            entity_idx.append(len(pieces))
            pieces.append(value.split())
        elif part == _YEAR:
            pieces.append([str(year)])
        else:
            pieces.append([part])
    text = _fit(pieces, entity_idx)
    if not text:
        return None
    return SearchQuery(
        text=text,
        purpose=tpl.purpose,
        topic=_topic_for(tpl, values),
        include_domains=list(tpl.include_domains),
    )


def _entity_tokens(intent: Intent) -> set[str]:
    tokens: set[str] = set()
    for ent in intent.public_entities:
        tokens.update(ent.value.lower().split())
        tokens.update(normalize(ent.value).lower().split())
    return tokens


def provenance_ok(q: SearchQuery, intent: Intent) -> bool:
    """Every lowercase query token is a template word or appears in a public entity token."""
    tokens = q.text.lower().split()
    if not tokens:
        return False
    entity_tokens = _entity_tokens(intent)
    return all(tok in TEMPLATE_WORDS or any(tok in et for et in entity_tokens) for tok in tokens)


def _pii_categories(text: str, allow: set[str]) -> list[str]:
    try:
        from app.pipeline.scrub import contains_pii
    except ImportError:
        # TODO: remove this fallback once the pii-scrubber issue merges contains_pii.
        return []
    try:
        return list(contains_pii(text, allow=allow))
    except TypeError:
        # contains_pii without the optional allow-list parameter.
        return list(contains_pii(text))


def allow_terms(intent: Intent) -> set[str]:
    """Scrubbed values the PII check may let through, raw and normalized.

    Kept performer/author names and, outside document intents, kept public names (titles,
    products, brands, companies); see ``scrub.allow_terms``. The runner passes the same set to
    the egress guard so a query built here is not blocked there.
    """
    try:
        from app.pipeline.scrub import allow_terms as scrub_allow_terms
    except ImportError:
        values = {e.value for e in intent.public_entities if e.type in ("performer", "author")}
    else:
        values = scrub_allow_terms(intent)
    return {v for value in values for v in (value, normalize(value))}


def build_queries(intent: Intent, now: date | None = None) -> list[SearchQuery]:
    """Build 0-3 sanitized queries for an intent, in template order."""
    year = (now or date.today()).year
    values = _first_values(intent)
    allow = allow_terms(intent)

    out: list[SearchQuery] = []
    seen: set[str] = set()
    for tpl in _TEMPLATES:
        if tpl.intent_type != intent.intent_type:
            continue
        q = _build_one(tpl, values, year)
        if q is None or q.text.lower() in seen:
            continue
        if not provenance_ok(q, intent) or _pii_categories(q.text, allow):
            continue
        seen.add(q.text.lower())
        out.append(q)
        if len(out) == MAX_QUERIES:
            break
    return out


RELATED_INTENTS = ("book", "chart", "document")

_DISCOVERY_TEMPLATES: tuple[_Template, ...] = (
    _Template(
        "event",
        "related",
        (_s("performer", "event_name"), "similar", "events", "near", _s("city")),
    ),
    _Template("product", "related", (_s("brand", "product"), "similar", "products")),
    _Template("book", "related", (_s("book_title", "author"), "similar", "books")),
    _Template("place", "related", (_s("place"), "similar", "places", "near", _s("city"))),
)


def related_query(intent: Intent, now: date | None = None) -> SearchQuery | None:
    """The Exa "related" query for book/chart/document intents, or None.

    Uses the same template as the intent's first context query (so it passes the same
    provenance and PII checks) with ``purpose="related"``. It is kept apart from
    ``build_queries`` so Tavily never receives it.
    """
    if intent.intent_type not in RELATED_INTENTS:
        return None
    tpl = next(
        (t for t in _TEMPLATES if t.intent_type == intent.intent_type and t.purpose == "context"),
        None,
    )
    if tpl is None:
        return None
    year = (now or date.today()).year
    q = _build_one(tpl, _first_values(intent), year)
    if q is None:
        return None
    allow = allow_terms(intent)
    if not provenance_ok(q, intent) or _pii_categories(q.text, allow):
        return None
    return q.model_copy(update={"purpose": "related"})


# Voice event discovery can have a topic ("AI events") rather than a known performer.
# Keep these separate so the established screenshot templates retain their behavior.
_VOICE_EVENTS = (
    _Template(
        "event",
        "tickets",
        (_s("performer", "event_name", "public_org", "topic"), _s("city"), _s("date"), "tickets"),
    ),
    _Template(
        "event",
        "tickets",
        (_s("performer", "event_name", "public_org", "topic"), _s("city"), "tickets"),
    ),
    # A named team/event can be searched without inventing a separate location.
    _Template(
        "event",
        "tickets",
        (_s("performer", "event_name", "public_org", "topic"), _s("date"), "tickets"),
    ),
    _Template(
        "event", "tickets", (_s("performer", "event_name", "public_org", "topic"), "tickets")
    ),
)


def _voice_candidate(
    intent: Intent, templates: tuple[_Template, ...], now: date | None
) -> SearchQuery | None:
    for template in templates:
        query = _build_one(template, _first_values(intent), (now or date.today()).year)
        if (
            query
            and provenance_ok(query, intent)
            and not _pii_categories(query.text, allow_terms(intent))
        ):
            return query
    return None


def build_voice_queries(intent: Intent, now: date | None = None) -> list[SearchQuery]:
    """Event/topic discovery for voice, with all other intents using the existing builder."""
    if intent.intent_type != "event":
        return build_queries(intent, now)
    query = _voice_candidate(intent, _VOICE_EVENTS, now)
    return [query] if query else []


def related_voice_query(intent: Intent, now: date | None = None) -> SearchQuery | None:
    """Extend related reading to one selected event/product, from its public entities only."""
    if intent.intent_type == "event":
        query = _voice_candidate(intent, _VOICE_EVENTS, now)
    elif intent.intent_type == "product":
        query = _voice_candidate(
            intent,
            (
                _Template("product", "context", (_s("brand"), _s("product"), "review")),
                _Template("product", "context", (_s("product"), "review")),
            ),
            now,
        )
    else:
        return related_query(intent, now)
    return query.model_copy(update={"purpose": "related"}) if query else None


def feed_discovery_query(intent: Intent, now: date | None = None) -> SearchQuery | None:
    """One privacy-proven discovery query for the Muse feed.

    Nearby event/place discovery uses only the public city already extracted from the saved
    screenshot. No device or profile location is consulted.
    """
    tpl = next((t for t in _DISCOVERY_TEMPLATES if t.intent_type == intent.intent_type), None)
    if tpl is None:
        return None
    q = _build_one(tpl, _first_values(intent), (now or date.today()).year)
    if q is None:
        return None
    allow = allow_terms(intent)
    if not provenance_ok(q, intent) or _pii_categories(q.text, allow):
        return None
    return q
