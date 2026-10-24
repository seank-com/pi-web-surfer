# pi-web-surfer

A standalone Pi extension for web research. It registers two tools:

- **`web_fetch`** — fetch an HTTP(S) URL (or read a local file), store the
  source bytes in a protected temporary artifact, and serve bounded pages
  without re-downloading. Supports POST/PUT with template-injected bodies and
  headers, readable (HTML→Markdown) and raw modes, project-relative `saveTo`,
  and an origin policy that can deny private networks.
- **`web_search`** — search the web via Google Gemini grounding (primary,
  requires `GEMINI_API_KEY`) with a keyless DuckDuckGo fallback that is always
  disclosed with a loud warning.

The full contracts, error and warning code vocabulary, and design decisions
(D1–D14) are in [design](docs/design.md); [setup](docs/setup.md) covers
installation and configuration.

## Tools

### `web_fetch`

Fetch a URL or read a local file as stored, paged source evidence.

- `url` (absolute HTTP(S)) **or** `path` (local file; no network) — exactly one.
- `mode`: `readable` (default; HTML extracted to Markdown) or `raw`.
- Paging: pass the returned `artifactId` plus `offset`/`nextOffset` to
  continue. Paging is per representation, so keep the same `mode`. `refresh`
  forces a new fetch.
- POST/PUT with `body` and `headers`. Bodies and header values accept
  `{{env:NAME}}`, `{{file:path}}`, and `{{template:path,{"var":"value"}}}`
  placeholders (`env` resolves only at the top level).
- `saveTo`: project-relative destination for the stored source bytes. It never
  overwrites and refuses the protected config directory, datastore roots, and
  destinations outside the project (reported as a `destination_blocked`
  warning; the fetched content is still served).

### `web_search`

- `query` (required). `maxResults` 1–10 (default from project config, 10).
- Results preserve provider order and content; ungrounded answers are labeled.
- Fallback results carry:
  `[WARNING: Gemini key is not configured; using DuckDuckGo.]`
- With a supplied Gemini key, provider failures remain Gemini failures; no error-triggered fallback occurs.

HTTP uses Node's native `fetch`, with a minimal declared Undici checked-lookup
dispatcher in deny mode and manual redirect validation. No custom timeouts are
added; caller and session cancellation remain supported.

Cache/save publication requires the active datastore public policy-v1 service.
Missing policy is not proof of empty ownership. Search remains independently usable.

## Artifacts

Fetched source bytes are stored under a protected temporary namespace
(`$TMPDIR/web-surfer/<project>/<request>/`), not in the project or in
`.pi`. Pages are served from the artifact so repeated reads and paging do not
re-download. Artifacts expire after one hour and are cleaned at session start.

## Configuration

Configuration is read from `<project>/.pi/web-surfer/config.json` (0600, owned
by the current user; the file and its directory are validated). When the file
is absent the defaults apply; when it is present but invalid, network
operations are disabled until it is corrected. See [setup](docs/setup.md).

## Quick start

This is a local `0.1.0` candidate; it has not been published to npm.

```bash
npm ci
npm run check
npm test
npm run build
npm pack --dry-run
npm run test:package
pi -e ./dist/index.js
```

See [setup](docs/setup.md) and [design](docs/design.md).

## Development

Tests load the extension through the real Pi loader from source and from the
packed tarball, and exercise the fetch/search stack against a local HTTP
fixture server (deny policy, redirects, body caps, paging, `saveTo`, and the
search fallback). Select a different host artifact explicitly:

```bash
PI_CODING_AGENT_PACKAGE=/path/to/pi-coding-agent npm test
PI_CODING_AGENT_PACKAGE=/path/to/pi-coding-agent npm run test:package
```

To keep private terms and secrets out of commits, run `npm run hooks:install`
once per clone. Commits and pushes are then refused when an added line or a
commit message contains a line of `~/.pii` (one term per line, matched
case-insensitively; `#` lines are comments) or a value of 8 or more characters
from `~/.env`. `PRIVATE_TERMS_FILE` and `PRIVATE_SECRETS_FILE` select other
files. `npm run check:private -- --all` checks every staged file, including
unchanged ones.

Only compiled JS, declarations, docs, README, LICENSE, and package metadata ship.
