"""On-device URL extraction never becomes an outbound query or a persisted history row."""

import io
from unittest.mock import AsyncMock, Mock

import pytest
from PIL import Image

from app import jobs, library
from app.pipeline import runner
from app.pipeline.image_links import ScreenshotIntent, VisibleLink, link_cards, visible_url


def test_preserves_visible_paths_case_and_query_when_adding_https():
    assert (
        visible_url("forms.example/AbC42?ref=profile") == "https://forms.example/AbC42?ref=profile"
    )
    assert visible_url("https://go.example/CaSe") == "https://go.example/CaSe"


@pytest.mark.parametrize(
    "url",
    [
        "",
        "javascript:alert(1)",
        "data:text/html,test",
        "file:///tmp/file",
        "ftp://files.example/a",
        "http://localhost/private",
        "http://127.0.0.1/a",
        "https://notes.internal/a",
        "https://user:pass@folio.example/a",
        "https://folio.example/?token=private-value",
        "https://folio.example:bad/a",
        "https://[",
        "not a url",
        "careers.example/…",
        "careers.example/...",
    ],
)
def test_invalid_private_and_cut_off_links_are_not_clickable(url):
    assert visible_url(url) is None


def test_extracts_complete_links_but_never_guesses_a_hidden_suffix():
    cards = link_cards(
        [
            VisibleLink(label="My website", url="folio.example"),
            VisibleLink(label="Apply", url="forms.example/AbC42"),
            VisibleLink(label="Repeat", url="https://folio.example"),
            VisibleLink(label="Internship board", url="careers.example/jobs/…", truncated=True),
            VisibleLink(label="Visually incomplete", url="jobs.example", truncated=True),
        ]
    )
    assert len(cards) == 4
    assert [card.url for card in cards] == [
        "https://folio.example",
        "https://forms.example/AbC42",
        None,
        None,
    ]
    assert all(card.source == "on-device" for card in cards)
    assert cards[0].actions[0].label == "Open link"
    assert cards[0].actions[1].text == cards[0].url
    assert not cards[-1].actions and "incomplete" in cards[-1].title


async def test_link_list_returns_local_cards_without_search_or_persistence(monkeypatch):
    intent = ScreenshotIntent(
        intent_type="other",
        summary="Links visible in the screenshot",
        public_entities=[],
        redaction_counts={"handle": 1},
        confidence=1,
        visible_links=[
            VisibleLink(label="My website", url="folio.example"),
            VisibleLink(label="Internship", url="jobs.example/…", truncated=True),
        ],
    )
    extract = AsyncMock(return_value=intent)
    search = AsyncMock(side_effect=AssertionError("URL extraction must not search"))
    save = Mock(side_effect=AssertionError("Unreviewed URLs must not be persisted"))
    monkeypatch.setattr(runner, "extract_intent", extract)
    monkeypatch.setattr(runner.search_mod, "search", search)
    monkeypatch.setattr(library, "save_quietly", save)
    monkeypatch.setattr(
        runner,
        "scrub_intent",
        lambda value: (
            value,
            type("Report", (), {"removed": {}, "kept": 0})(),
        ),
    )
    data = io.BytesIO()
    Image.new("RGB", (80, 80)).save(data, format="PNG")
    job = jobs.create_job()
    try:
        await runner.run_job(job.job_id, data.getvalue(), "links.png")
        assert job.result.status == "done"
        assert job.result.queries == [] and job.result.egress == []
        assert len(job.result.cards) == 2
        assert job.result.cards[0].url == "https://folio.example"
        assert all(event.local for event in job.events)
        assert "visible_links" not in job.result.model_dump()["intent"]
        assert library.get(job.job_id) is None
        search.assert_not_called()
        save.assert_not_called()
    finally:
        jobs.JOBS.pop(job.job_id, None)


def test_ocr_reads_links_panel_but_preserves_uncertainty_and_truncation():
    from app.pipeline.image_links import links_from_lines

    lines = [
        "Sample creator",
        "Links",
        "My website",
        "folio.example",
        "Apply",
        "forms.example/AbC42",
        "Product",
        "go.example/Fake|GReel2",
        "Internships",
        "careers.example/jobs/…",
    ]
    links = links_from_lines(lines)
    assert len(links) == 4
    cards = link_cards(links)
    assert [card.url for card in cards] == [
        "https://folio.example",
        "https://forms.example/AbC42",
        None,
        None,
    ]
    assert cards[2].subtitle == "go.example/Fake|GReel2"
    assert cards[3].subtitle == "careers.example/jobs/…"
    assert links_from_lines(["Private email", "folio.example", "jobs.example"]) == []


def test_native_ocr_uses_stdin_without_image_files_or_network(monkeypatch):
    import json
    import shutil
    import subprocess
    import sys

    from app.pipeline.image_links import native_image_links

    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(shutil, "which", lambda _: "/usr/bin/swift")

    def recognize(command, **kwargs):
        assert command[-1].endswith("read_text.swift")
        assert kwargs["input"] == b"in-memory-pixels"
        assert kwargs["stderr"] == subprocess.DEVNULL
        return type(
            "Result", (), {"stdout": json.dumps(["Links", "Website", "folio.example"]).encode()}
        )()

    monkeypatch.setattr(subprocess, "run", recognize)
    assert native_image_links(b"in-memory-pixels")[0].url == "folio.example"
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(
        subprocess, "run", lambda *_args, **_kwargs: pytest.fail("No Swift on Windows")
    )
    assert native_image_links(b"in-memory-pixels") == []
