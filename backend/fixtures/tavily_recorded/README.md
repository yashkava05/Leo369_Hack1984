# Recorded Tavily responses (DEMO_FALLBACK)

Real Tavily responses for the demo queries, one `<query-slug>.json` per query, saved by
`scripts/record_tavily.py`. With `DEMO_FALLBACK=1` the backend serves one of these only when the
live Tavily call for exactly that query fails or times out, and the terminal labels it
"(recorded result)". A request the egress guard blocks (air-gap on, PII) is never replaced.

Each file holds `query` (must equal the query text exactly), `recorded_at`, `request` (the body
that was sent; never the API key) and `response` (Tavily's JSON as returned).

See `docs/DEMO.md` ("Fallback plan") for when and how to record them.
