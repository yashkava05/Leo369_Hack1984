# Recorded Tavily responses (DEMO_FALLBACK)

Live Tavily responses for the demo queries, one `<query-slug>.json` per query, saved on the demo
laptop by `scripts/record_tavily.py`. With `DEMO_FALLBACK=1` the backend serves one of these only
when the live Tavily call for exactly that request (query text, topic and domains) fails or times
out, and the terminal labels it "(recorded result)". A request the egress guard blocks (air-gap
on, PII) is never replaced.

Each file holds `query`, `recorded_at`, `request` (the body that was sent; never the API key) and
`response` (Tavily's JSON as returned).

The `.json` files are git-ignored: they are real web results that can name real people, and repo
fixtures must use fake data only. Keep them on the demo laptop. See `docs/DEMO.md` ("Fallback
plan") for when and how to record them.
