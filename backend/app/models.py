"""Pipeline contract shared by every stage and mirrored in frontend/src/types.ts.

Do not rename or add fields without updating types.ts and the fixtures.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict

IntentType = Literal["event", "product", "book", "place", "chart", "document", "other"]
EntityType = Literal[
    "performer",
    "event_name",
    "venue",
    "city",
    "date",
    "time",
    "product",
    "brand",
    "price",
    "book_title",
    "author",
    "place",
    "topic",
    "public_org",
    "metric",
]


class Entity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: EntityType
    value: str  # public info only


class Intent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent_type: IntentType
    summary: str  # <= 140 chars, no PII
    public_entities: list[Entity]
    redaction_counts: dict[str, int]  # e.g. {"handle": 2}; counts only, never values
    confidence: float  # 0..1


class SearchQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str  # what is sent to Tavily, verbatim
    purpose: Literal["tickets", "shopping", "book", "place", "context", "related"]
    topic: Literal["general", "news", "finance"] = "general"
    include_domains: list[str] = []


class EgressRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    ts: float
    method: str
    host: str
    path: str
    bytes_out: int
    payload_preview: str  # first 300 chars of the JSON body, API key removed
    blocked: bool
    reason: str | None = None


class IcsEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    start: str  # ISO 8601, with offset if known
    end: str | None = None
    location: str | None = None
    url: str | None = None


class CardAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    type: Literal["open_url", "download_ics", "copy"]
    url: str | None = None
    ics: IcsEvent | None = None
    text: str | None = None


class Card(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    kind: Literal["tickets", "shop", "book", "calendar", "insight", "place", "link", "related"]
    title: str
    subtitle: str | None = None
    url: str | None = None
    price: str | None = None  # as displayed by the source, e.g. "$89"
    source: str  # domain, e.g. "ticketmaster.com"
    snippet: str | None = None  # <= 240 chars
    score: float = 0
    actions: list[CardAction] = []


Stage = Literal["ingest", "extract", "scrub", "query", "search", "cards", "done", "error"]


class StageEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str
    seq: int
    ts: float
    stage: Stage
    status: Literal["start", "progress", "ok", "error"]
    message: str  # one human line for the terminal
    local: bool  # true = on-device, false = network
    data: dict | None = None


class JobResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str
    status: Literal["running", "done", "error"]
    intent: Intent | None = None
    queries: list[SearchQuery] = []
    cards: list[Card] = []
    egress: list[EgressRecord] = []
    timings_ms: dict[str, int] = {}
    error: str | None = None
