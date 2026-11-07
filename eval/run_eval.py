#!/usr/bin/env python3
"""Leak / accuracy / latency eval for Latent's local pipeline.

For every screenshot in eval/expected.json this runs, fully offline:

    extract_intent -> scrub_intent -> build_queries

(from backend/app/pipeline/{extract,scrub,query}.py), serializes the scrubbed
Intent plus every SearchQuery, and counts a *leak* whenever any of that image's
``must_not_appear`` strings shows up (case-insensitive) in that output.

It prints a per-image table and totals, writes eval/results.md, and exits:

    0  no leaks
    1  at least one leak
    2  pipeline functions missing / bad arguments / an image failed to run

Usage:
    LATENT_OFFLINE=1 python eval/run_eval.py            # real run
    python eval/run_eval.py --no-scrub                  # bypass the scrubber (should leak -> exit 1)
    python eval/run_eval.py --self-test                 # check the harness itself with fake stand-ins

Offline: while the eval runs, outbound socket connections are refused unless
they go to a loopback address or to OLLAMA_HOST, so nothing can reach Tavily
or any other internet host. Only the Python standard library is used here.
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import importlib
import inspect
import ipaddress
import json
import math
import os
import socket
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, NamedTuple, TextIO
from urllib.parse import urlparse

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
BACKEND_DIR = REPO_ROOT / "backend"

EXIT_OK, EXIT_LEAK, EXIT_ERROR = 0, 1, 2


class Pipeline(NamedTuple):
    extract_intent: Callable[..., Any]
    scrub_intent: Callable[..., Any]
    build_queries: Callable[..., Any]
    warm_up: Callable[[], Any] | None = None


class PipelineMissing(RuntimeError):
    pass


# --------------------------------------------------------------------------- pipeline loading

PIPELINE_FUNCS = (
    ("app.pipeline.extract", "extract_intent", "#4 vision-extract"),
    ("app.pipeline.scrub", "scrub_intent", "#5 pii-scrubber"),
    ("app.pipeline.query", "build_queries", "#6 query-builder"),
)


def load_pipeline() -> Pipeline:
    """Import the three real pipeline functions from backend/app/pipeline."""
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))
    found: dict[str, Any] = {}
    missing: list[str] = []
    warm_up = None
    for module_name, func_name, issue in PIPELINE_FUNCS:
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:  # ImportError, or a stub that fails to import
            missing.append(f"  - {module_name}.{func_name} ({issue}): cannot import {module_name}: {exc!r}")
            continue
        func = getattr(module, func_name, None)
        if not callable(func):
            missing.append(f"  - {module_name}.{func_name} ({issue}): not defined yet")
            continue
        found[func_name] = func
        if func_name == "scrub_intent":
            warm_up = getattr(module, "warm_up", None)
    if missing:
        raise PipelineMissing(
            "run_eval: the local pipeline is not available yet:\n"
            + "\n".join(missing)
            + f"\nLooked under {BACKEND_DIR / 'app' / 'pipeline'}."
            " Merge issues #4, #5 and #6 (and install backend deps) before running the eval."
            "\nTo check this harness alone, run: python eval/run_eval.py --self-test"
        )
    return Pipeline(found["extract_intent"], found["scrub_intent"], found["build_queries"], warm_up)


# --------------------------------------------------------------------------- offline guard

class OfflineGuard:
    """Refuse outbound socket connects except loopback and OLLAMA_HOST while active."""

    def __init__(self, ollama_host: str | None = None) -> None:
        self.allowed_ips: set[str] = set()
        host = urlparse(ollama_host or os.environ.get("OLLAMA_HOST", "http://localhost:11434")).hostname
        if host:
            try:
                for info in socket.getaddrinfo(host, None):
                    self.allowed_ips.add(str(info[4][0]))
            except OSError:
                pass  # unresolvable host: only loopback stays allowed
        self._orig_connect = None
        self._orig_connect_ex = None
        self.blocked: list[str] = []

    def _check(self, sock: socket.socket, address: Any) -> None:
        if sock.family not in (socket.AF_INET, socket.AF_INET6):
            return  # unix sockets etc. stay local
        ip = str(address[0])
        try:
            if ipaddress.ip_address(ip.split("%")[0]).is_loopback:
                return
        except ValueError:
            pass  # a hostname, not an IP
        if ip in self.allowed_ips or ip in ("localhost",):
            return
        self.blocked.append(ip)
        raise ConnectionRefusedError(f"LATENT_OFFLINE: blocked outbound connection to {ip}")

    def __enter__(self) -> "OfflineGuard":
        guard = self
        self._orig_connect = socket.socket.connect
        self._orig_connect_ex = socket.socket.connect_ex
        orig_connect, orig_connect_ex = self._orig_connect, self._orig_connect_ex

        def connect(sock, address):  # type: ignore[no-untyped-def]
            guard._check(sock, address)
            return orig_connect(sock, address)

        def connect_ex(sock, address):  # type: ignore[no-untyped-def]
            guard._check(sock, address)
            return orig_connect_ex(sock, address)

        socket.socket.connect = connect  # type: ignore[method-assign]
        socket.socket.connect_ex = connect_ex  # type: ignore[method-assign]
        return self

    def __exit__(self, *exc: object) -> None:
        socket.socket.connect = self._orig_connect  # type: ignore[method-assign]
        socket.socket.connect_ex = self._orig_connect_ex  # type: ignore[method-assign]


# --------------------------------------------------------------------------- helpers

def to_jsonable(obj: Any) -> Any:
    """Pydantic models, dataclasses, dicts, lists and scalars -> plain JSON data."""
    if hasattr(obj, "model_dump"):
        return obj.model_dump(mode="json")
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return to_jsonable(dataclasses.asdict(obj))
    if isinstance(obj, dict):
        return {str(k): to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [to_jsonable(v) for v in obj]
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    return str(obj)


def field(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


async def _noop_emit(*_args: Any, **_kwargs: Any) -> None:
    return None


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


async def run_pipeline(pipeline: Pipeline, image_bytes: bytes, no_scrub: bool) -> tuple[Any, list[Any]]:
    try:
        raw = pipeline.extract_intent(image_bytes, _noop_emit)
    except TypeError:
        raw = pipeline.extract_intent(image_bytes)  # tolerate an emit-less signature
    intent = await _maybe_await(raw)
    if no_scrub:
        clean = intent
    else:
        scrubbed = await _maybe_await(pipeline.scrub_intent(intent))
        clean = scrubbed[0] if isinstance(scrubbed, tuple) else scrubbed  # (Intent, ScrubReport)
    queries = await _maybe_await(pipeline.build_queries(clean))
    return clean, list(queries or [])


def find_leaks(serialized: str, must_not_appear: list[str]) -> list[str]:
    hay = serialized.lower()
    return [s for s in must_not_appear if s and s.lower() in hay]


def entity_recall(intent: Any, must_include: list[str]) -> float | None:
    if not must_include:
        return None
    values = [str(field(e, "value", "")).lower() for e in (field(intent, "public_entities") or [])]
    hits = sum(1 for want in must_include if any(want.lower() in v for v in values))
    return hits / len(must_include)


def percentile(values: list[float], pct: float) -> float:
    """Nearest-rank percentile."""
    if not values:
        return float("nan")
    ordered = sorted(values)
    rank = max(1, math.ceil(pct / 100 * len(ordered)))
    return ordered[rank - 1]


@dataclasses.dataclass
class Row:
    file: str
    expected_intent: str
    got_intent: str = "-"
    recall: float | None = None
    leaks: list[str] = dataclasses.field(default_factory=list)
    seconds: float = 0.0
    queries: list[str] = dataclasses.field(default_factory=list)
    error: str | None = None

    @property
    def intent_ok(self) -> bool:
        return self.error is None and self.got_intent == self.expected_intent


def fmt_recall(r: float | None) -> str:
    return "n/a" if r is None else f"{r:.2f}"


# --------------------------------------------------------------------------- core

def evaluate(
    pipeline: Pipeline,
    expected: dict[str, dict[str, Any]],
    screenshots_dir: Path,
    results_path: Path | None,
    *,
    no_scrub: bool = False,
    out: TextIO = sys.stdout,
) -> int:
    """Run the eval over ``expected`` and return the process exit code."""
    if pipeline.warm_up is not None and not no_scrub:
        pipeline.warm_up()  # build the analyzer once; not counted in latency

    rows: list[Row] = []
    with OfflineGuard() as guard:
        for name, spec in expected.items():
            row = Row(file=name, expected_intent=spec["intent_type"])
            rows.append(row)
            path = screenshots_dir / name
            try:
                image_bytes = path.read_bytes()
                t0 = time.perf_counter()
                intent, queries = asyncio.run(run_pipeline(pipeline, image_bytes, no_scrub))
                row.seconds = time.perf_counter() - t0
            except Exception as exc:  # report and keep going
                row.error = f"{type(exc).__name__}: {exc}"
                continue
            serialized = json.dumps(
                {"intent": to_jsonable(intent), "queries": to_jsonable(queries)},
                ensure_ascii=False,
            )
            row.got_intent = str(field(intent, "intent_type", "-"))
            row.recall = entity_recall(intent, spec.get("must_include", []))
            row.leaks = find_leaks(serialized, spec.get("must_not_appear", []))
            row.queries = [str(field(q, "text", q)) for q in queries]

    ok_rows = [r for r in rows if r.error is None]
    recalls = [r.recall for r in ok_rows if r.recall is not None]
    latencies = [r.seconds for r in ok_rows]
    total_leaks = sum(len(r.leaks) for r in rows)
    errors = [r for r in rows if r.error]
    totals = {
        "intent_accuracy": sum(r.intent_ok for r in rows) / len(rows) if rows else 0.0,
        "mean_recall": sum(recalls) / len(recalls) if recalls else float("nan"),
        "total_leaks": total_leaks,
        "leaky_images": sum(1 for r in rows if r.leaks),
        "errors": len(errors),
        "p50": percentile(latencies, 50),
        "p95": percentile(latencies, 95),
    }

    table = render_table(rows)
    out.write(table + "\n\n" + render_totals(totals, len(rows)) + "\n")
    for r in rows:
        if r.leaks:
            out.write(f"LEAK {r.file}: {r.leaks}\n")
        if r.error:
            out.write(f"ERROR {r.file}: {r.error}\n")
    if guard.blocked:
        out.write(f"offline guard blocked connections to: {sorted(set(guard.blocked))}\n")

    if results_path is not None:
        results_path.write_text(render_markdown(rows, totals, no_scrub), encoding="utf-8")
        out.write(f"wrote {results_path}\n")

    if total_leaks > 0:
        return EXIT_LEAK
    if errors:
        return EXIT_ERROR
    return EXIT_OK


HEADERS = ("file", "expected", "got", "recall", "leaks", "seconds")


def _cells(r: Row) -> tuple[str, ...]:
    got = "ERROR" if r.error else r.got_intent + ("" if r.intent_ok else " ✗")
    return (r.file, r.expected_intent, got, fmt_recall(r.recall), str(len(r.leaks)), f"{r.seconds:.2f}")


def render_table(rows: list[Row]) -> str:
    data = [HEADERS] + [_cells(r) for r in rows]
    widths = [max(len(row[i]) for row in data) for i in range(len(HEADERS))]
    lines = ["  ".join(c.ljust(w) for c, w in zip(row, widths)) for row in data]
    lines.insert(1, "  ".join("-" * w for w in widths))
    return "\n".join(lines)


def render_totals(t: dict[str, Any], n: int) -> str:
    return (
        f"intent accuracy: {t['intent_accuracy']:.0%} ({round(t['intent_accuracy'] * n)}/{n})\n"
        f"mean entity recall: {t['mean_recall']:.2f}\n"
        f"total leaks: {t['total_leaks']} (in {t['leaky_images']} images)\n"
        f"errors: {t['errors']}\n"
        f"latency p50: {t['p50']:.2f}s  p95: {t['p95']:.2f}s"
    )


def render_markdown(rows: list[Row], t: dict[str, Any], no_scrub: bool) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    model = os.environ.get("LATENT_MODEL", "qwen2.5vl:3b")
    lines = [
        "# Latent eval results",
        "",
        f"Generated by `python eval/run_eval.py` on {stamp} · model `{model}`"
        + (" · **scrubber bypassed (--no-scrub)**" if no_scrub else ""),
        "",
        "| " + " | ".join(HEADERS) + " | queries |",
        "|" + "---|" * (len(HEADERS) + 1),
    ]
    for r in rows:
        q = "<br>".join(f"`{x}`" for x in r.queries) or ("error: " + r.error if r.error else "—")
        lines.append("| " + " | ".join(_cells(r)) + f" | {q} |")
    lines += ["", "## Totals", ""]
    lines += [f"- {line}" for line in render_totals(t, len(rows)).splitlines()]
    leaky = [r for r in rows if r.leaks]
    if leaky:
        lines += ["", "## Leaks", ""]
        lines += [f"- `{r.file}`: " + ", ".join(f"`{s}`" for s in r.leaks) for r in leaky]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- self-test

def self_test(expected: dict[str, dict[str, Any]], screenshots_dir: Path) -> int:
    """Exercise leak detection and exit codes with fake stand-ins (no backend needed)."""

    @dataclasses.dataclass
    class FakeEntity:
        type: str
        value: str

    @dataclasses.dataclass
    class FakeIntent:
        intent_type: str
        summary: str
        public_entities: list
        redaction_counts: dict
        confidence: float

    @dataclasses.dataclass
    class FakeQuery:
        text: str
        purpose: str = "context"

    by_size: dict[int, str] = {}
    for name in expected:
        by_size[(screenshots_dir / name).stat().st_size] = name
    if len(by_size) != len(expected):
        raise AssertionError("self-test needs screenshots of distinct sizes to tell them apart")

    def make_extract(leaky: bool):
        async def extract_intent(image_bytes: bytes, emit):
            await emit("extract", "start", "fake")
            spec = expected[by_size[len(image_bytes)]]
            entities = [FakeEntity("topic", v) for v in spec["must_include"]]
            summary = "public subject"
            if leaky and spec["must_not_appear"]:
                summary += " " + spec["must_not_appear"][0].upper()  # leak, different case
                entities.append(FakeEntity("place", spec["must_not_appear"][-1]))
            return FakeIntent(spec["intent_type"], summary, entities, {}, 0.9)
        return extract_intent

    planted = {s.lower() for spec in expected.values() for s in spec["must_not_appear"]}

    def fake_scrub(intent: FakeIntent):
        ents = [e for e in intent.public_entities if e.value.lower() not in planted]
        summary = " ".join(w for w in intent.summary.split() if not any(w.lower() in p for p in planted))
        return dataclasses.replace(intent, summary=summary, public_entities=ents), {"removed": {}}

    def fake_build(intent: FakeIntent):
        return [FakeQuery(" ".join(e.value for e in intent.public_entities))] if intent.public_entities else []

    def passthrough_scrub(intent):
        return intent, {"removed": {}}

    sink = open(os.devnull, "w")
    failures: list[str] = []

    def check(label: str, got: Any, want: Any) -> None:
        status = "ok" if got == want else "FAIL"
        print(f"[{status}] {label}: got {got!r}, want {want!r}")
        if got != want:
            failures.append(label)

    with tempfile.TemporaryDirectory() as tmp:
        md = Path(tmp) / "results.md"
        check("clean pipeline exits 0",
              evaluate(Pipeline(make_extract(False), fake_scrub, fake_build), expected, screenshots_dir, md, out=sink),
              EXIT_OK)
        check("clean pipeline: 100% recall written to results.md",
              "mean entity recall: 1.00" in md.read_text(), True)
        check("leaky extract + working scrubber exits 0",
              evaluate(Pipeline(make_extract(True), fake_scrub, fake_build), expected, screenshots_dir, md, out=sink),
              EXIT_OK)
        check("leaky extract + pass-through scrubber exits 1",
              evaluate(Pipeline(make_extract(True), passthrough_scrub, fake_build), expected, screenshots_dir, md,
                       out=sink),
              EXIT_LEAK)
        check("leaks listed in results.md", "## Leaks" in md.read_text(), True)
        check("--no-scrub bypasses the scrubber (exits 1)",
              evaluate(Pipeline(make_extract(True), fake_scrub, fake_build), expected, screenshots_dir, md,
                       no_scrub=True, out=sink),
              EXIT_LEAK)

        async def broken_extract(image_bytes, emit):
            raise RuntimeError("model unavailable")
        check("pipeline error exits 2",
              evaluate(Pipeline(broken_extract, fake_scrub, fake_build), expected, screenshots_dir, md, out=sink),
              EXIT_ERROR)

    check("leak match is case-insensitive", find_leaks('{"s": "hi PRIYA raman"}', ["Priya Raman"]), ["Priya Raman"])

    blocked = False
    with OfflineGuard(ollama_host="http://127.0.0.1:11434"):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.connect(("192.0.2.1", 443))  # TEST-NET-1; refused by the guard before any packet
        except ConnectionRefusedError as exc:
            blocked = "LATENT_OFFLINE" in str(exc)
        except OSError:
            pass
        finally:
            s.close()
    check("offline guard refuses non-local connections", blocked, True)

    saved_path = list(sys.path)
    sys.path.insert(0, tempfile.mkdtemp())  # empty dir; real app.pipeline may or may not exist
    try:
        try:
            load_pipeline()
            print("[skip] missing-pipeline message: real pipeline is importable")
        except PipelineMissing as exc:
            check("missing pipeline gives a clear message", "not available yet" in str(exc), True)
    finally:
        sys.path[:] = saved_path

    sink.close()
    print(f"\nself-test: {'PASS' if not failures else 'FAIL ' + str(failures)}")
    return 0 if not failures else 1


# --------------------------------------------------------------------------- CLI

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--expected", type=Path, default=EVAL_DIR / "expected.json")
    ap.add_argument("--screenshots", type=Path, default=EVAL_DIR / "screenshots")
    ap.add_argument("--results", type=Path, default=EVAL_DIR / "results.md", help="markdown report path")
    ap.add_argument("--only", nargs="+", metavar="FILE", help="run only these screenshots")
    ap.add_argument("--no-scrub", action="store_true", help="bypass scrub_intent (demonstrates leak detection)")
    ap.add_argument("--self-test", action="store_true", help="test this harness with fake pipeline stand-ins")
    args = ap.parse_args(argv)

    os.environ.setdefault("LATENT_OFFLINE", "1")
    expected: dict[str, dict[str, Any]] = json.loads(args.expected.read_text(encoding="utf-8"))
    missing_images = [n for n in expected if not (args.screenshots / n).is_file()]
    if missing_images:
        print(f"run_eval: missing screenshots: {missing_images}", file=sys.stderr)
        return EXIT_ERROR

    if args.self_test:
        return self_test(expected, args.screenshots)

    if args.only:
        unknown = [n for n in args.only if n not in expected]
        if unknown:
            print(f"run_eval: not in {args.expected.name}: {unknown}", file=sys.stderr)
            return EXIT_ERROR
        expected = {n: expected[n] for n in args.only}

    try:
        pipeline = load_pipeline()
    except PipelineMissing as exc:
        print(exc, file=sys.stderr)
        return EXIT_ERROR
    return evaluate(pipeline, expected, args.screenshots, args.results, no_scrub=args.no_scrub)


if __name__ == "__main__":
    sys.exit(main())
