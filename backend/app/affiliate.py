"""Affiliate tagging hook for outbound shop, book and ticket links.

`tag_url` is where a partner tag would be appended to merchant links (the business model).
It returns the URL unchanged for now; cards.py already routes every commercial URL through it.
"""


def tag_url(url: str) -> str:
    return url
