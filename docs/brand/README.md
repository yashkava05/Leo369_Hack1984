# PrismLocal brand assets

`brand-sheet.png` is the source logo sheet. Everything else here is cut from it or drawn to match it.

| File | Use |
| --- | --- |
| `icon-512.png`, `icon-192.png`, `icon-128.png` | Full-colour app icon cropped from the sheet, transparent outside the rounded tile |
| `icon-48.png`, `icon-32.png`, `icon-16.png` | Small sizes, rasterized from `icon-simple.svg` so the prism and rays stay legible |
| `icon-simple.svg` | Simplified colour icon (tile, prism, beam, six rays); also the web favicon |
| `favicon.ico` | 16 + 32 + 48 px favicon |
| `icon-navy-512.png` | Square colour icon on the sheet's navy, with the glow, for places that need a full-bleed square |
| `icon-mono-white.svg`, `icon-mono-white-512.png` | One-colour white outline icon for dark backgrounds |
| `lockup-dark.png` | Icon + "PrismLocal" wordmark for dark backgrounds |
| `lockup-light.png` | Icon + wordmark for light backgrounds |
| `lockup-mono.png` | One-colour white icon + wordmark on black |

Copies used by the app live in `frontend/public/` (favicons, `brand/icon-128.png`) and
`browser-extension/icons/` (16, 32, 48, 128). The pitch deck uses `docs/brand/icon-128.png` and `icon-32.png`.

The wordmark sets "Prism" bold and "Local" in a lighter weight, in a geometric sans-serif.
