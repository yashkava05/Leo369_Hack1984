"""Deterministic PII scrubber: the local second pass over everything the vision model returned.

`scrub_intent` applies the entity policy and cleans the summary before anything can become a
search query. `contains_pii` is the fast check the egress guard runs on every outbound string.
Reports carry categories and counts only, never the matched values.
"""

import re
import threading

from presidio_analyzer import AnalyzerEngine, Pattern, PatternRecognizer, RecognizerResult
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_analyzer.predefined_recognizers import PhoneRecognizer
from pydantic import BaseModel

from app.models import Entity, Intent

SPACY_MODEL = "en_core_web_lg"

# Findings that remove an entity whatever its type and that `contains_pii` always flags.
HARD_BLOCK = (
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "CREDIT_CARD",
    "US_SSN",
    "IBAN_CODE",
    "IP_ADDRESS",
    "US_BANK_NUMBER",
    "HANDLE",
    "ACCOUNT_ID",
)
PERSON = "PERSON"
DETECTED = (*HARD_BLOCK, PERSON)

# Pseudo-categories for removals that come from policy rather than a detector.
LONG_NUMBER = "LONG_NUMBER"
DOCUMENT_POLICY = "DOCUMENT_POLICY"

PERSON_TYPES = frozenset({"performer", "author"})
DOCUMENT_KEEP = frozenset({"topic", "public_org", "product"})
DIGIT_RUN_EXEMPT = frozenset({"date", "time", "price"})
DIGIT_RUN = re.compile(r"\d{6,}")

HANDLE_PATTERN = r"(?<![\w@])@[A-Za-z0-9_.]{2,30}"
ACCOUNT_ID_PATTERN = r"(?i)\b(?:acct|account|order|invoice|ref)[#:\s-]*[A-Z0-9-]{5,}\b"

SCORE_THRESHOLD = 0.5


class ScrubReport(BaseModel):
    removed: dict[str, int]  # category -> count, e.g. {"EMAIL_ADDRESS": 1, "HANDLE": 2}
    dropped_entity_types: list[str]  # entity types removed by policy (types only, never values)
    kept: int


class _PhoneRecognizer(PhoneRecognizer):
    """Presidio's phone recognizer, trusted without a context word.

    The stock score (0.4) only clears the 0.5 threshold next to a word like "phone"; "call" is a
    spaCy stop word, so "call me at 617-555-0134" would pass. A number that libphonenumber
    validates is strong enough evidence in a screenshot on its own.
    """

    SCORE = 0.6


_analyzer: AnalyzerEngine | None = None
_lock = threading.Lock()


def _build_analyzer() -> AnalyzerEngine:
    provider = NlpEngineProvider(
        nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": SPACY_MODEL}],
        }
    )
    analyzer = AnalyzerEngine(nlp_engine=provider.create_engine(), supported_languages=["en"])
    analyzer.registry.remove_recognizer("PhoneRecognizer")
    analyzer.registry.add_recognizer(_PhoneRecognizer())
    analyzer.registry.add_recognizer(
        PatternRecognizer(
            supported_entity="HANDLE",
            patterns=[Pattern(name="handle", regex=HANDLE_PATTERN, score=0.85)],
        )
    )
    analyzer.registry.add_recognizer(
        PatternRecognizer(
            supported_entity="ACCOUNT_ID",
            patterns=[Pattern(name="account_id", regex=ACCOUNT_ID_PATTERN, score=0.85)],
        )
    )
    return analyzer


def _get_analyzer() -> AnalyzerEngine:
    global _analyzer
    if _analyzer is None:
        with _lock:
            if _analyzer is None:
                _analyzer = _build_analyzer()
    return _analyzer


def warm_up() -> None:
    """Build the analyzer once (loads the spaCy model, a few seconds). Safe to call repeatedly."""
    _get_analyzer().analyze(text="warm up", language="en", entities=list(DETECTED))


def _norm(text: str) -> str:
    return " ".join(text.split()).casefold()


def _is_allowed(finding: RecognizerResult, span: str, allow: set[str]) -> bool:
    """True if the span is an allowed value, or a PERSON span that names nobody else.

    spaCy often tags a performer's name together with the words around it ("Theo Vance
    Farewell", "Mary Andy Weir" from a book title), so allowed names are cut out of a PERSON
    span and the rest is checked again; only a full name (two or more words) left over blocks.
    """
    if _norm(span) in {_norm(a) for a in allow}:
        return True
    if finding.entity_type != PERSON:
        return False
    rest = span
    for value in allow:
        rest = re.sub(r"\s+".join(map(re.escape, value.split())), " ", rest, flags=re.IGNORECASE)
    if rest == span:
        return False
    leftover = _get_analyzer().analyze(
        text=rest, language="en", entities=[PERSON], score_threshold=SCORE_THRESHOLD
    )
    return not any(len(rest[r.start : r.end].split()) > 1 for r in leftover)


def _lone_word_person(finding: RecognizerResult, text: str) -> bool:
    """A PERSON tag on a text that is a single word ("Kindle"): spaCy has no context to go on."""
    return finding.entity_type == PERSON and len(text.split()) == 1


def _findings(text: str, allow: set[str] | None = None) -> list[RecognizerResult]:
    """Non-overlapping findings in text order, skipping allowed spans."""
    if not text.strip():
        return []
    results = _get_analyzer().analyze(
        text=text, language="en", entities=list(DETECTED), score_threshold=SCORE_THRESHOLD
    )
    results = [r for r in results if not _lone_word_person(r, text)]
    if allow:
        results = [r for r in results if not _is_allowed(r, text[r.start : r.end], allow)]
    # On overlap keep the stronger finding, preferring hard-block categories over PERSON.
    results.sort(key=lambda r: (-r.score, r.entity_type == PERSON, r.start))
    picked: list[RecognizerResult] = []
    for r in results:
        if all(r.end <= p.start or r.start >= p.end for p in picked):
            picked.append(r)
    return sorted(picked, key=lambda r: r.start)


def contains_pii(text: str, allow: set[str] | None = None) -> list[str]:
    """Unique PII categories found in `text`, in order of appearance; [] if clean.

    `allow` holds values that may appear (the kept performer/author names): a finding whose text
    equals one of them, ignoring case and spacing, is skipped, and so is a PERSON finding that
    leaves no full name once those values are cut out of it. A PERSON tag on a one-word text is
    ignored.
    """
    found: list[str] = []
    for r in _findings(text, allow):
        if r.entity_type not in found:
            found.append(r.entity_type)
    return found


def _entity_removal(entity: Entity, intent_type: str, allow: set[str]) -> str | None:
    """The category an entity is removed under, or None to keep it."""
    if intent_type == "document" and entity.type not in DOCUMENT_KEEP:
        return DOCUMENT_POLICY
    # `allow` holds only kept performer/author values, which carry no hard-block finding, so
    # skipping them here only lets a public name inside another entity (an event name) stay.
    categories = [r.entity_type for r in _findings(entity.value, allow)]
    hard = [c for c in categories if c != PERSON]
    if hard:
        return hard[0]
    if PERSON in categories and entity.type not in PERSON_TYPES:
        return PERSON
    if entity.type not in DIGIT_RUN_EXEMPT and DIGIT_RUN.search(entity.value):
        return LONG_NUMBER
    return None


def _scrub_summary(summary: str, allow: set[str], removed: dict[str, int]) -> str:
    out = summary
    for r in reversed(_findings(summary, allow)):
        out = out[: r.start] + f"[{r.entity_type.lower()}]" + out[r.end :]
        removed[r.entity_type] = removed.get(r.entity_type, 0) + 1

    def number(match: re.Match[str]) -> str:
        removed[LONG_NUMBER] = removed.get(LONG_NUMBER, 0) + 1
        return "[number]"

    return DIGIT_RUN.sub(number, out)


def scrub_intent(intent: Intent) -> tuple[Intent, ScrubReport]:
    """Apply the entity policy and clean the summary; return the cleaned Intent and a report."""
    removed: dict[str, int] = {}
    dropped_types: list[str] = []
    kept: list[Entity] = []

    # Performer/author values may stand as PERSON elsewhere only if they survive scrubbing
    # themselves, so they are checked first and only kept ones are allowed.
    candidates = [
        e
        for e in intent.public_entities
        if e.type in PERSON_TYPES and intent.intent_type != "document"
    ]
    allow = {e.value for e in candidates if _entity_removal(e, intent.intent_type, set()) is None}

    for entity in intent.public_entities:
        reason = _entity_removal(entity, intent.intent_type, allow)
        if reason is None:
            kept.append(entity)
            continue
        removed[reason] = removed.get(reason, 0) + 1
        if entity.type not in dropped_types:
            dropped_types.append(entity.type)

    summary = _scrub_summary(intent.summary, allow, removed)

    counts = dict(intent.redaction_counts)
    for category, n in removed.items():
        key = category.lower()
        counts[key] = counts.get(key, 0) + n

    report = ScrubReport(removed=removed, dropped_entity_types=dropped_types, kept=len(kept))
    cleaned = intent.model_copy(
        update={"summary": summary, "public_entities": kept, "redaction_counts": counts}
    )
    return cleaned, report
