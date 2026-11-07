"""Action cards from the intent (local) and the Tavily results (network).

Calendar and Maps cards are built from the on-device entities alone, so they appear even
when every search fails. Result cards follow the purpose of the query that found them.
Output is ranked, deduplicated by cleaned URL and capped at MAX_CARDS.
"""

import hashlib
import re
from datetime import datetime, timedelta
from urllib.parse import parse_qsl, quote_plus, urlencode, urlsplit, urlunsplit

from dateutil import parser as dateparser

from app.affiliate import tag_url
from app.models import Card, CardAction, Entity, IcsEvent, Intent, SearchQuery
from app.pipeline.search import TavilyResponse, TavilyResult

MAX_CARDS = 6
SNIPPET_CHARS = 240
EVENT_HOURS = 3
DEFAULT_HOUR = 20

TICKET_DOMAINS = (
    "ticketmaster.com",
    "livenation.com",
    "axs.com",
    "seatgeek.com",
    "stubhub.com",
    "vividseats.com",
    "dice.fm",
    "eventbrite.com",
)
PRICE_RE = re.compile(r"\$\s?(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)")
# "free shipping over $35", "save $20", "$10 off": amounts that are not the item's price.
NOT_A_PRICE_BEFORE = re.compile(r"(?:over|save|saving|shipping|orders?|off|fee)\s*:?\s*$", re.I)
NOT_A_PRICE_AFTER = re.compile(r"^\s*(?:off|discount|shipping|minimum)\b", re.I)
TRACKING_PARAMS = {"fbclid", "gclid"}

# Lower rank sorts first; within a rank, higher Tavily score first.
RANK = {
    "tickets": 0,
    "shop": 0,
    "book": 0,
    "calendar": 1,
    "place": 2,
    "insight": 3,
    "link": 4,
    "related": 5,
}
# Per-kind caps so a pile of results cannot crowd the local calendar/Maps cards out.
KIND_CAP = {
    "tickets": 3,
    "shop": 4,
    "book": 3,
    "calendar": 1,
    "place": 1,
    "insight": 1,
    "link": 3,
    "related": 2,
}


# --- helpers ----------------------------------------------------------------------


def clean_url(url: str) -> str:
    """Drop utm_*, fbclid and gclid query params and the fragment."""
    parts = urlsplit(url.strip())
    params = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if not k.lower().startswith("utm_") and k.lower() not in TRACKING_PARAMS
    ]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(params), ""))


def domain_of(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    return host.removeprefix("www.")


def _on_domain(host: str, domains: tuple[str, ...]) -> bool:
    return any(host == d or host.endswith("." + d) for d in domains)


def lowest_price(text: str) -> str | None:
    """Lowest plausible dollar amount in `text`, formatted like "$45" or "$1,299.99"."""
    best: tuple[float, str] | None = None
    text = text or ""
    for m in PRICE_RE.finditer(text):
        before, after = text[max(0, m.start() - 20) : m.start()], text[m.end() : m.end() + 20]
        if NOT_A_PRICE_BEFORE.search(before) or NOT_A_PRICE_AFTER.search(after):
            continue
        raw = m.group(1)
        value = float(raw.replace(",", ""))
        if value > 0 and (best is None or value < best[0]):
            best = (value, raw)
    return f"${best[1]}" if best else None


def snippet(text: str | None) -> str | None:
    text = " ".join((text or "").split())
    if not text:
        return None
    if len(text) <= SNIPPET_CHARS:
        return text
    cut = text[: SNIPPET_CHARS - 1].rsplit(" ", 1)[0]
    return cut.rstrip(" ,.;:") + "…"


def card_id(kind: str, key: str) -> str:
    return "c_" + hashlib.sha1(f"{kind}|{key}".encode()).hexdigest()[:10]


def _first(entities: list[Entity], *types: str) -> str | None:
    for t in types:
        for e in entities:
            if e.type == t and e.value.strip():
                return e.value.strip()
    return None


# --- local cards ------------------------------------------------------------------


def parse_event_start(date_value: str, time_value: str | None, now: datetime) -> datetime | None:
    """Parse the flyer's date (+ time, default 20:00). A year-less date in the past rolls on."""
    text = f"{date_value} {time_value}" if time_value else date_value
    base = now.replace(hour=DEFAULT_HOUR, minute=0, second=0, microsecond=0, tzinfo=None)
    try:
        start = dateparser.parse(text, fuzzy=True, default=base)
        # Same text with a different default date shows which parts were actually written;
        # fuzzy parsing of text with no date in it silently returns the default.
        alt = base.replace(
            year=base.year - 7, month=1 if base.month != 1 else 2, day=1 if base.day != 1 else 2
        )
        probe = dateparser.parse(text, fuzzy=True, default=alt)
    except (ValueError, OverflowError):
        return None
    start = start.replace(tzinfo=None)
    if start.month != probe.month and start.day != probe.day:
        return None  # neither month nor day came from the text
    year_given = start.year == probe.year
    if not year_given and start.date() < now.date():
        try:
            start = start.replace(year=start.year + 1)
        except ValueError:  # Feb 29
            start = start.replace(year=start.year + 1, day=28)
    return start


def _display_when(start: datetime) -> str:
    hour = start.strftime("%I").lstrip("0")
    return f"{start.strftime('%a, %b')} {start.day} {start.year} · {hour}:{start:%M %p}"


def calendar_card(intent: Intent, now: datetime, url: str | None) -> Card | None:
    if intent.intent_type != "event":
        return None
    ents = intent.public_entities
    date_value = _first(ents, "date")
    if not date_value:
        return None
    start = parse_event_start(date_value, _first(ents, "time"), now)
    if start is None:
        return None
    name = _first(ents, "performer", "event_name") or "Event"
    location = ", ".join(v for v in (_first(ents, "venue", "place"), _first(ents, "city")) if v)
    end = start + timedelta(hours=EVENT_HOURS)
    ics = IcsEvent(
        title=name,
        start=start.isoformat(timespec="seconds"),
        end=end.isoformat(timespec="seconds"),
        location=location or None,
        url=url,
    )
    when = _display_when(start)
    return Card(
        id=card_id("calendar", f"{name}|{ics.start}"),
        kind="calendar",
        title=name,
        subtitle=f"{when} · {location}" if location else when,
        source="on-device",
        snippet="Event details read from the screenshot on this device.",
        score=intent.confidence,
        actions=[CardAction(label="Add to calendar", type="download_ics", ics=ics)],
    )


def place_card(intent: Intent) -> Card | None:
    ents = intent.public_entities
    if intent.intent_type == "event":
        name = _first(ents, "venue")
    elif intent.intent_type == "place":
        name = _first(ents, "place", "venue")
    else:
        return None
    if not name:
        return None
    city = _first(ents, "city")
    query = f"{name} {city}" if city and city.lower() not in name.lower() else name
    url = "https://www.google.com/maps/search/?api=1&query=" + quote_plus(query)
    return Card(
        id=card_id("place", url),
        kind="place",
        title=name,
        subtitle=city,
        url=url,
        source="google.com",
        score=intent.confidence,
        actions=[CardAction(label="Open in Maps", type="open_url", url=url)],
    )


# --- result cards -----------------------------------------------------------------


def _result_card(purpose: str, r: TavilyResult) -> Card:
    url = clean_url(r.url)
    host = domain_of(url)
    title = " ".join(r.title.split()) or host
    text = snippet(r.content)
    price = lowest_price(r.content)

    if _on_domain(host, TICKET_DOMAINS):
        url = tag_url(url)
        kind, label = "tickets", "Buy tickets"
        price = f"from {price}" if price else None
    elif purpose == "shopping" and price:
        url = tag_url(url)
        kind, label = "shop", "View price"
    elif purpose == "book":
        url = tag_url(url)
        kind, label, price = "book", "Get the book", None
    else:
        kind, label, price = "link", "Open", None

    return Card(
        id=card_id(kind, url),
        kind=kind,
        title=title,
        url=url,
        price=price,
        source=host,
        snippet=text,
        score=r.score,
        actions=[CardAction(label=label, type="open_url", url=url)],
    )


def insight_card(queries: list[SearchQuery], results: dict[str, TavilyResponse]) -> Card | None:
    for q in queries:
        resp = results.get(q.text)
        answer = " ".join((resp.answer or "").split()) if resp else ""
        if not answer:
            continue
        text = snippet(answer) or answer
        top = resp.results[0] if resp.results else None
        return Card(
            id=card_id("insight", text),
            kind="insight",
            title="Quick answer",
            subtitle=q.text,
            source=domain_of(top.url) if top else "tavily.com",
            snippet=text,
            score=top.score if top else 0.0,
            actions=[CardAction(label="Copy", type="copy", text=text)],
        )
    return None


# --- assembly ---------------------------------------------------------------------


def build_cards(
    intent: Intent,
    queries: list[SearchQuery],
    results: dict[str, TavilyResponse],
    now: datetime | None = None,
) -> list[Card]:
    now = now or datetime.now()
    candidates: list[Card] = []
    for q in queries:
        resp = results.get(q.text)
        if resp is None:
            continue
        candidates += [_result_card(q.purpose, r) for r in resp.results if r.url.strip()]

    tickets = sorted((c for c in candidates if c.kind == "tickets"), key=lambda c: -c.score)
    local = [
        calendar_card(intent, now, tickets[0].url if tickets else None),
        place_card(intent),
        insight_card(queries, results),
    ]
    candidates += [c for c in local if c is not None]

    ranked = sorted(candidates, key=lambda c: (RANK[c.kind], -c.score))
    out: list[Card] = []
    seen: set[str] = set()
    per_kind: dict[str, int] = {}
    for card in ranked:
        key = card.url or card.id
        if key in seen or per_kind.get(card.kind, 0) >= KIND_CAP[card.kind]:
            continue
        seen.add(key)
        per_kind[card.kind] = per_kind.get(card.kind, 0) + 1
        out.append(card)
    return out[:MAX_CARDS]
