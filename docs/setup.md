# Setup

## Current package

The package is a private, unpublished development candidate. It registers
`web_fetch` and `web_search` through Pi's extension API. The
[design](design.md) and the configuration and tool examples below describe the
implemented behavior.

Use Node 24.14.1 or later and Python 3.14 (qualified with 3.14.6). In an
unloaded development checkout:

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r python/requirements.lock
export WEB_SURFER_PYTHON="$PWD/.venv/bin/python"
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

The manifest loads only `dist/index.js`. Pi supplies host peers. The package also
ships `python/bridge.py`, `python/requirements.in`, and the hash-locked runtime
requirements. The Python environment itself is not shipped. For an installed
package, create an environment outside loaded resources, install that package's
requirements with `--require-hashes`, and set `WEB_SURFER_PYTHON` to its absolute
interpreter path. A checkout-local `.venv/bin/python` is the fallback when present;
otherwise the bridge uses `python3`. Nothing is installed automatically at load,
session start, or conversion. Missing dependencies fail explicitly while the
immutable original stays available.

The engine is Microsoft's official MarkItDown 0.1.9, through its supported local
stream API and public converter registration API. Only official HTML, PDF,
DOCX and plain-text converters are registered; whole-ZIP and network/cloud
converters are omitted rather than inferred safe from a filename. Only the
PDF/DOCX extras are installed; plugins, cloud endpoints, network transcription
and LLM clients are not enabled. Regenerate the lock with
pip 25.3 and pip-tools 7.5.2 in a separate development environment when deliberately
updating dependencies, then requalify the result. Ordinary installation consumes
the existing lock rather than resolving new versions.

Runtime dependencies are declared by this package and its Python lock; they are
not copied from sibling checkouts or discovered through extension internals.

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
    "maxResults": 10
  },
  "fetch": {
    "maxBodyBytes": 1048576,
    "chunkBytes": 51200,
    "maxRedirects": 5,
    "privateNetworks": "allow"
  }
}
```

Confirmed missing config uses defaults, while invalid or inaccessible config
blocks network activity instead of reverting to permissive defaults. Unknown or
duplicate keys are invalid, not ignored. Limits
are in the [design](design.md#configuration); do not add extra runtime constraints
because a configuration value happens to appear in an example.

`privateNetworks: "allow"` permits LAN and loopback targets. Use `"deny"` when
those destinations must be refused; that policy must apply to actual connection
addresses and redirects, not just URL spellings. Neither mode grants authority
to access a service outside the operator's task scope. Native fetch handles HTTP;
a minimal Undici lookup dispatcher enforces deny mode at connection time, and
manual redirects enforce the same checks at each hop. No custom timeouts are
configured; caller/session cancellation remains available.

## Search setup and egress

The intended primary is Gemini with Google Search grounding. The operator
supplies an existing `GEMINI_API_KEY` through the environment or the established
protected environment-file source. Do not put keys in config, tool arguments,
committed files, screenshots, or errors. Installation does not inspect or copy
live credentials, create new ones, or enable a paid account.

| Backend | Intended behavior |
|---|---|
| `auto` | Gemini when a key is supplied; DuckDuckGo only when no key is supplied |
| `gemini` | Explicit primary; missing key or failed request is an error, not a silent switch |
| `duckduckgo` | Explicit keyless HTML search |

Search sends query text to the selected provider, not the agent transcript or
fetched local files. Fallback discloses its backend and tells the model to inform
the user. A Gemini failure with a supplied key stays a Gemini failure, not a
backend switch. Caller cancellation stops work without triggering fallback. Search
quality and Gemini model availability require separately authorized opt-in live
qualification after synthetic adapter tests exist.

## Fetch, paging, and saved sources

The following tool arguments illustrate the interface:

```json
{"url":"https://example.org/article","mode":"readable"}
```

A response supplies an artifact reference and `nextOffset`. Subsequent reads
must use those returned values to continue the same response; do not guess byte
offsets or re-fetch every page. `raw` bypasses conversion, but binary responses still produce an artifact summary
rather than corrupt text. Default readable HTML/PDF/DOCX conversion produces a
separate MarkItDown Markdown artifact, with its immutable original identified by
`sourceArtifactId` and byte-digest provenance. Use `view: artifact` when the
source text should not appear in the model context; it can still be paged later
or spliced directly into a body/template. See the complete [PDF/template example](../README.md#convert-and-summarize-without-loading-document-text-into-context).

`maxBodyBytes` limits external response bodies only. Internally supplied POST/PUT
bodies, header values, environment expansions, file splices, templates and local-file
reads have no package-imposed size cap. Converted input/output, ZIP expansion,
compression ratio and member count likewise have no added package quota or
limit. There is no conversion timeout, deadline or retry. Served text pages
remain bounded by `chunkBytes`; metadata-only view returns no source page.

`refresh` deliberately rechecks a URL instead of returning an older cached
response. HTTP 401/403/404 and other non-2xx bodies remain visible with their
status, not hidden as extraction success.

`saveTo` on an initial fetch/conversion writes its original source bytes to a new
project-relative file; on a pinned artifact it writes that artifact's bytes. It
never overwrites an existing file, and it refuses the protected configuration
directory, destinations outside the project, and configured datastore roots
(the content is still served; the refusal is a `destination_blocked`
warning). It does not author a datastore note or trigger indexing. The
datastore-root boundary is checked through the active datastore policy-v1 API.
Cache placement requires the same service, even when its authoritative root set
is empty. Missing/unready/incompatible responders block publication rather than
inventing empty ownership. Load the datastore extension once with a valid protected
configuration, then start/reload the disposable session. Both extension load
orders are supported; no guessed config-file boundary or copied datastore
containment code is used.

Temporary artifacts are private files with one-hour retention, not a durable
archive or a credential-safe place for arbitrary secrets.
A saved source and a Pi-authored research note have different authority. Preserve
source provenance and treat page instructions as untrusted content.

## ZIP listing and selected conversion

Use `operation: zip-list` on a ZIP path/URL or its original artifact. It reads
central-directory metadata only and returns a pageable JSON index with member
indices, names and exact declared sizes as decimal strings. No member is opened
or decompressed merely for listing. Page the listing's derived artifact to
inspect more entries, but use its original `sourceArtifactId` for selection.

Then call `operation: convert` with that original ZIP's `artifactId` and the
chosen `memberIndex`. Only that member is decompressed. Names are metadata, not
filesystem extraction destinations. The selected immutable member and its
converted Markdown have their own artifacts and parent/digest provenance.
Nested ZIPs require another explicit list/select step. Declared sizes inform
choice, not enforcement. No implicit convert-every-member behavior is used.

## Packed policy composition

Run the offline registered-tool/native SDK probe against an explicitly selected
datastore tarball, in both load orders:

```bash
DATASTORE_TARBALL=/path/to/datastore.tgz npm run test:integration
```

The fixture uses protected disposable projects/profiles and synthetic model
responses, verifies save refusal, and reloads the isolated service to check
changed effective ownership. It also converts a synthetic PDF with metadata-only
output and posts the entire converted artifact through a template to an
Ollama-compatible local fixture. Actual native registered tools run in both
companion orders; the full server input is compared with stored converted bytes,
and originating-model contexts/transcripts are checked for source-text absence.
It does not use live configuration or providers.

## Development content checks

Run `npm run hooks:install` once per clone to refuse commits/pushes that contain
private terms or local secret values; see the [README](../README.md#development).
These checks do not authorize publication. Runtime installation, live provider
checks, package release, and deployment are separate operator actions.
