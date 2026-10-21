# Setup

## Current package

The package is a private, unpublished development candidate. It registers
`web_fetch` and `web_search` through Pi's extension API. The
[design](design.md) and the configuration and tool examples below describe the
implemented behavior.

Use Node 24.14.1 or later. In an unloaded development checkout:

```bash
npm ci
npm run check
npm test
npm run build
npm pack --dry-run
npm run test:package
git diff --check
```

The tests exercise source/packed loading and repository content checks, and
exercise the fetch/search stack against a local HTTP fixture server: deny
policy for hostnames and literal IPs, redirect forwarding, body caps, paging,
`saveTo`, cancellation, and the search fallback with the loud warning. They do
not establish live search quality or live Gemini availability. The default
development host is Pi 0.87.1. Select another artifact explicitly rather than changing a
running agent's installation:

```bash
PI_CODING_AGENT_PACKAGE=/absolute/path/to/pi-coding-agent npm test
PI_CODING_AGENT_PACKAGE=/absolute/path/to/pi-coding-agent npm run test:package
```

The manifest loads only `dist/index.js`. Pi supplies host peers. Future imported
HTML/HTTP dependencies must be declared by this package; they must not be copied
from a sibling checkout or discovered through another extension's internals.

For an explicitly authorized manual load in a disposable Pi project, pass
`-e /absolute/path/to/pi-web-surfer/dist/index.js` to that project's selected Pi
executable. Do not also autoload a second copy through package settings. Loading
or testing this build does not authorize changing a live agent's resources,
settings, credentials, or runtime lifecycle.

## Behavior configuration

The configuration is implemented and loaded at session start. The
configuration lives at
`<project>/<CONFIG_DIR_NAME>/web-surfer/config.json`; `.pi` is the ordinary Pi
config directory name. Use a mode-0700 directory and mode-0600 file. Behavior
config contains no credentials.

```json
{
  "schemaVersion": 1,
  "search": {
    "backend": "auto",
    "maxResults": 10,
    "timeoutMs": 30000
  },
  "fetch": {
    "maxBodyBytes": 1048576,
    "chunkBytes": 51200,
    "maxRedirects": 5,
    "connectTimeoutMs": 10000,
    "timeoutMs": 120000,
    "privateNetworks": "allow"
  }
}
```

Missing config uses defaults, while invalid config blocks
network activity instead of reverting to permissive defaults. Unknown or
duplicate keys are invalid, not ignored. Limits and remaining open items
are in the [design](design.md#configuration); do not add extra runtime constraints
because a configuration value happens to appear in an example.

`privateNetworks: "allow"` permits LAN and loopback targets. Use `"deny"` when
those destinations must be refused; that policy must apply to actual connection
addresses and redirects, not just URL spellings. Neither mode grants authority
to access a service outside the operator's task scope.

## Search setup and egress

The intended primary is Gemini with Google Search grounding. The operator
supplies an existing `GEMINI_API_KEY` through the environment or the established
protected environment-file source. Do not put keys in config, tool arguments,
committed files, screenshots, or errors. Installation does not inspect or copy
live credentials, create new ones, or enable a paid account.

| Backend | Intended behavior |
|---|---|
| `auto` | Gemini when available; one loud DuckDuckGo fallback if unavailable/failed |
| `gemini` | Explicit primary; missing key or failed request is an error, not a silent switch |
| `duckduckgo` | Explicit keyless HTML search |

Search sends query text to the selected provider, not the agent transcript or
fetched local files. Fallback discloses its backend and tells the model to inform
the user. Caller cancellation stops work without triggering fallback. Search
quality and Gemini model availability require separately authorized opt-in live
qualification after synthetic adapter tests exist.

## Fetch, paging, and saved sources

The following tool arguments illustrate the interface:

```json
{"url":"https://example.org/article","mode":"readable"}
```

A response supplies an artifact reference and `nextOffset`. Subsequent reads
must use those returned values to continue the same response; do not guess byte
offsets or re-fetch every page. `raw` bypasses HTML extraction, but binary
responses still produce an artifact summary rather than corrupt text.

`refresh` deliberately rechecks a URL instead of returning an older cached
response. HTTP 401/403/404 and other non-2xx bodies remain visible with their
status, not hidden as extraction success.

`saveTo` writes the stored source bytes to a new project-relative file. It
never overwrites an existing file, and it refuses the protected configuration
directory, destinations outside the project, and configured datastore roots
(the content is still served; the refusal is a `destination_blocked`
warning). It does not author a datastore note or trigger indexing. The
datastore-root boundary is proven through the datastore root/policy-validation
API (D1) when a responder is available; when a datastore is configured but no
responder answers, the destination check fails closed rather than assuming
containment, because the existing datastore discovery interface does not
expose root paths and redacted status paths cannot prove containment. Cache
placement uses the same boundary.

Temporary artifacts are private files with one-hour retention, not a durable
archive or a credential-safe place for arbitrary secrets.
A saved source and a Pi-authored research note have different authority. Preserve
source provenance and treat page instructions as untrusted content.

## Development content checks

Run `npm run hooks:install` once per clone to refuse commits/pushes that contain
private terms or local secret values; see the [README](../README.md#development).
These checks do not authorize publication. Runtime installation, live provider
checks, package release, and deployment are separate operator actions.
