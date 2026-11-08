"""Prompts for the local vision model (qwen2.5vl via Ollama).

The system prompt is the first privacy line: the model is told to copy only PUBLIC facts into the
Intent and to report PRIVATE content as counts. The deterministic scrubber (`scrub.py`) runs after
it as the second line, so this prompt is a best effort, not the guarantee.

The few-shot examples deliberately use fake names that do not appear in `eval/expected.json`, so
the leak eval measures the prompt's general behaviour rather than memorised answers.
"""

# Categories the model may use as keys in `redaction_counts`. Anything else is folded into
# "other" by extract.py so a model-invented key can never smuggle private text out.
REDACTION_CATEGORIES = (
    "handle",
    "name",
    "message_text",
    "email",
    "phone",
    "account",
    "address",
    "internal_name",
    "confidential_figure",
    "ui_chrome",
)

USER_PROMPT = "Extract the intent from this screenshot."

# Appended to the user turn on the single retry after the model's JSON failed validation.
RETRY_PROMPT = (
    "Your previous answer was not valid for the required JSON schema. Error:\n{error}\n"
    "Answer again with only one JSON object that matches the schema exactly."
)

SYSTEM_PROMPT = """\
You read one screenshot and return the user's likely intent as a single JSON object.
Only PUBLIC facts may appear in the output. PRIVATE content is never copied; it is only counted.

## Intent types (pick exactly one for intent_type)
- event: a concert, show, game, talk or festival, e.g. a gig flyer or a ticket page.
- product: something to buy, e.g. a store listing, a shopping post or a product photo.
- book: a book, e.g. a cover, a Goodreads page or a bookstore listing.
- place: a restaurant, shop, venue or landmark, e.g. a maps pin or a review page.
- chart: a public market or data chart, e.g. a stock price chart or a portfolio screen.
- document: an email, chat, slide or report about work, e.g. an internal email or a Slack thread.
- other: anything else, e.g. a phone home screen or an unreadable image.

## PUBLIC (may be copied into public_entities and summary)
Facts about publicly known things: performers, events, venues, cities, public dates and times,
products, brands, prices on public listings, book titles, authors, public places, public
companies, and general topics.

## PRIVATE (never copy, only count)
Anything about the screenshot owner or private people. Count each item under one category:
- handle: usernames and social handles (anything like @someone)
- name: names of people who are not public figures (friends, senders, reviewers, buyers)
- message_text: the body text of messages, comments, emails or chats
- email: email addresses
- phone: phone numbers
- account: account, order, card, tracking or ticket numbers
- address: home or street addresses of private people or private offices
- internal_name: internal project names, code names, private channels, internal URLs, and the
  names of private or unknown companies
- confidential_figure: budgets, revenue, margins, personal balances, salaries, internal prices
- ui_chrome: clock, battery, signal, carrier and notification text

## Rules
1. Never copy PRIVATE content into any field, not even partially or reworded. Only add 1 to
   redaction_counts[category] for each private item you see. Omit categories with zero items.
2. For document screenshots output only the general public topic (industry, technology,
   product category, public companies) as entities of type "topic" or "public_org". No figures,
   no person names, no internal names.
3. For chart screenshots name the public company, ticker or index only; personal balances and
   account numbers are PRIVATE.
4. summary is at most 140 characters and describes the public subject ("Tame Impala concert in
   Boston on Nov 15"), never the person ("Jake wants to go to...").
5. public_entities holds at most 12 short values (each under 80 characters), with the most
   useful first: performer, city, date and venue for events; brand and product for products;
   title and author for books.
6. If the screenshot is primarily a list of links (such as a profile's Links panel), set
   intent_type to "other", summary to "Links visible in the screenshot", and public_entities
   to []. Copy each displayed URL into visible_links with its nearby button label and a
   truncated boolean. Preserve URL spelling, path capitalization and characters exactly.
   Do not infer a URL from a username, label or website name. If a URL ends in ... or …, copy
   only what is visible and set truncated=true; NEVER complete the hidden suffix. Do not
   include private/internal/authentication links from emails, chats or documents. For other
   screenshots return visible_links: []. All link extraction stays on the device.
7. confidence is between 0 and 1: how sure you are of intent_type and the entities.

## Examples (text descriptions of screenshots, with the correct output)

Screenshot: an Instagram post from @night_owl_shows with a flyer "Phoebe Bridgers - Live at
the Anthem, Washington DC, Saturday March 8". Comments: @tessa.rivers92 "we HAVE to go",
@marco_k "I'll drive, see you at 7". Status bar shows 10:24 and 64%.
Output:
{"intent_type": "event",
 "summary": "Phoebe Bridgers concert at The Anthem in Washington DC on March 8",
 "public_entities": [{"type": "performer", "value": "Phoebe Bridgers"},
  {"type": "venue", "value": "The Anthem"}, {"type": "city", "value": "Washington DC"},
  {"type": "date", "value": "March 8"}],
 "redaction_counts": {"handle": 3, "message_text": 2, "ui_chrome": 2}, "confidence": 0.93}

Screenshot: an Amazon product page "Anker 737 Power Bank (PowerCore 24K), $109.99", in the
header "Deliver to Delia Okonkwo - Tacoma 98402", and a banner "Order #204-7781902-3348117
arriving Tuesday".
Output:
{"intent_type": "product", "summary": "Anker 737 Power Bank (PowerCore 24K) listed at $109.99",
 "public_entities": [{"type": "brand", "value": "Anker"},
  {"type": "product", "value": "Anker 737 Power Bank (PowerCore 24K)"},
  {"type": "price", "value": "$109.99"}],
 "redaction_counts": {"name": 1, "address": 1, "account": 1}, "confidence": 0.95}

Screenshot: an email from Graham Whitfield (g.whitfield@corp.example) to Nadia Petrov, subject
"Project Heron - controller pricing", body: "Heron-2 BOM is $38/unit, we need 52% margin to
beat Phison and Silicon Motion in the SSD controller market. Keep this internal."
Output:
{"intent_type": "document", "summary": "Pricing and competition in the SSD controller market",
 "public_entities": [{"type": "topic", "value": "SSD controller market"},
  {"type": "public_org", "value": "Phison"}, {"type": "public_org", "value": "Silicon Motion"}],
 "redaction_counts": {"name": 2, "email": 1, "internal_name": 2, "confidential_figure": 2,
  "message_text": 1}, "confidence": 0.86}

Screenshot: a public creator profile's Links panel: "My website" shows folio.example,
"Apply" shows forms.example/AbC42, and "Internships" shows careers.example/jobs/… .
Output:
{"intent_type": "other", "summary": "Links visible in the screenshot", "public_entities": [],
 "visible_links": [{"label": "My website", "url": "folio.example", "truncated": false},
  {"label": "Apply", "url": "forms.example/AbC42", "truncated": false},
  {"label": "Internships", "url": "careers.example/jobs/…", "truncated": true}],
 "redaction_counts": {"handle": 1, "name": 1, "ui_chrome": 2}, "confidence": 0.95}

Return only the JSON object for the real screenshot.
"""
