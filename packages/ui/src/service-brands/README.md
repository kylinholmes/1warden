# Local website and service icons

Curated SVG geometry and brand colors from [Simple Icons](https://github.com/simple-icons/simple-icons), pinned to **16.34.0**.
`sources.json` preserves each icon's upstream source, brand guidelines and any supplied license information.
The library geometry is unchanged. The appearance setting offers original artwork
without an added tile, or a consistent padded tile. Original artwork keeps its own
background, if any; monochrome marks retain theme-aware contrast.

## Official original-color artwork

New Chinese services and Web3 exchanges use unmodified official site favicons,
touch icons or published brand assets. `overrides.ts` records the originating
official page and asset URL; `sources.json` also records each downloaded asset's
SHA-256. We do not recolor these resources with a theme color or turn them into
single-path monochrome marks. Downloads reject HTML challenge pages, unexpected
image signatures, oversized images and SVGs containing active/external content.
The older Simple Icons entries remain separately attributed.

Google uses its official multicolor G PNG, downloaded unchanged from
<https://developers.google.com/static/identity/images/g-logo.png>, instead of the library's monochrome path.
Source and brand guidelines: <https://developers.google.com/identity/branding-guidelines>.
`overrides.ts` records the upstream asset and `sources.json` distinguishes it from Simple Icons.
Official trademarks and site artwork are not covered by the Simple Icons collection's CC0 dedication.

The Simple Icons collection is CC0; individual brands retain their trademark rights and may have separate terms.
Read `LICENSE.simple-icons.md`, `DISCLAIMER.simple-icons.md` and the per-brand references in `sources.json`.
These are identification marks, not claims of affiliation, endorsement or website safety.

## Update

1. Add an icon ID and its verified service domains to `catalog.ts`; optional keywords are for directory search only.
2. Prefer original-color official artwork: add its source page, public asset URL and local filename to `overrides.ts`.
3. Run `bun run build:service-icons` at the repository root (requires network access).
4. Review generated artwork and source/licensing metadata before building the clients.

The generated files are committed. Normal Windows, mobile and extension builds do not download icons or require the full Simple Icons package.
Rendering a bundled icon makes no request to Simple Icons, a CDN or the vault's favicon endpoint.

## Matching

- Match a complete domain or its dot-delimited subdomains, longest match first.
- Item summaries preserve service hostnames (for example `cloud.tencent.com`); unknown-site favicon requests and avatar colors retain the existing registrable-domain behavior.
- Match only the existing icon domain, never arbitrary item-title substrings or usernames.
- Do not map shared hosting suffixes (`github.io`, `vercel.app`, `netlify.app`, etc.) to provider logos.
- Credit cards keep their separate payment-network icons.
- Unknown sites retain the existing server favicon and local fallback behavior.
- This presentation mapping does not affect URL matching, autofill or credential access.
