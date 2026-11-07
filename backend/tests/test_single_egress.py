"""Static guard: app/egress.py is the only module allowed to open a network client."""

import re
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent / "app"
ALLOWED = {APP_DIR / "egress.py"}

FORBIDDEN = [
    re.compile(r"httpx\.AsyncClient\("),
    re.compile(r"httpx\.Client\("),
    re.compile(r"\brequests\."),
    re.compile(r"^\s*(?:import|from)\s+requests\b", re.M),
    re.compile(r"urllib\.request"),
    re.compile(r"\baiohttp\b"),
    re.compile(r"(?<![\w.])socket\."),
    re.compile(r"^\s*(?:import|from)\s+socket\b", re.M),
]


def violations(text: str) -> list[str]:
    return [p.pattern for p in FORBIDDEN if p.search(text)]


def test_only_egress_opens_network_clients():
    offenders = {}
    for path in sorted(APP_DIR.rglob("*.py")):
        if path in ALLOWED:
            continue
        found = violations(path.read_text(encoding="utf-8"))
        if found:
            offenders[str(path.relative_to(APP_DIR.parent))] = found
    assert not offenders, f"network clients outside app/egress.py: {offenders}"


def test_scanner_catches_each_pattern():
    for snippet in [
        "import requests\n",
        "from requests import get\n",
        "requests.post(url)\n",
        "client = httpx.AsyncClient()\n",
        "client = httpx.Client(timeout=5)\n",
        "import urllib.request\n",
        "import aiohttp\n",
        "import socket\n",
        "s = socket.create_connection(addr)\n",
    ]:
        assert violations(snippet), snippet


def test_scanner_ignores_harmless_lookalikes():
    for snippet in [
        "async def ws(websocket): await websocket.send_text('x')\n",
        "def f(client: httpx.AsyncClient) -> None: ...\n",
        "requests_made = 0\n",
    ]:
        assert not violations(snippet), snippet
