# Web surfer design

Status: review candidate, not implementation approval. The current package is a
loadable scaffold and registers no tools. This document describes the intended
two-tool product. Sections labeled **Proposed** require explicit resolution in
the design PR before they become implementation requirements. That PR owns
review decisions and investigation history; this document owns the resulting
product contract.

## Purpose and scope

`web_search` discovers sources; `web_fetch` retrieves and verifies them. Fetch
stores the response outside model context and serves bounded pages without
re-downloading. Search uses Gemini Google Search grounding as the keyed primary
and DuckDuckGo HTML as the keyless fallback. Fallback is visible, never disguised
as a primary result.

Fetch supports HTTP and HTTPS. Private, loopback, and LAN origins are allowed by
default; project configuration can deny them. HTTP error bodies remain readable
with their status disclosed. HTML is converted to readable Markdown; XML, JSON,
and ordinary text retain their text representation. Binary responses remain
local artifacts rather than being decoded into tool-result text.

The initial product has no browser automation, login/cookie management, hosted
extraction service, or secondary summarization-model call. Saved source references
can feed a separately designed `bottled_query`/document-query workflow; that
integration motivates the save feature but is not implemented by this package.
Downloaded content
is untrusted source material, not instructions or authoritative datastore notes.

## Package and host boundary

The standalone package exposes `dist/index.js`. Its default export is the
extension returned by `createWebSurferExtension()`. Pi is a host peer, not a
bundled runtime. The existing development host is Pi 0.87.1; other host artifacts
require explicit qualification with the source and packed-package tests.

**Proposed integration:** register both tools during extension initialization;
load project configuration and initialize session resources at `session_start`.
Do not start network requests when the extension is loaded or a session starts.
Pass each tool's cancellation signal through all owned work. Close owned
resources idempotently at `session_shutdown`. The core works without terminal UI.

Use Pi's public extension API and TypeBox tool schemas. Tool results carry
model-facing text in `content` and structured metadata in `details`; essential
warnings and paging instructions appear in text, not only in metadata. Pi does
not automatically bound arbitrary custom-tool results. Its public
`DEFAULT_MAX_BYTES` is 51,200 and `DEFAULT_MAX_LINES` is 2,000 on the qualified
host; neither constant is a mandatory product limit by itself.

Observability is optional. When installed, it owns intent decoration, validation,
and auditing. These tools must not define their own `intent` parameter or copy
observability's sanitizer. Descriptions include purpose-level intent examples,
such as "Check whether the release notes describe a changed API."

## Egress and credentials

| Operation | Recipient | Material sent |
|---|---|---|
| Fetch | Requested origin and permitted redirect destinations | URL and ordinary HTTP request metadata |
| Primary search | Google Gemini API with Google Search grounding | Query and search instruction, not the session transcript |
| Keyless search | DuckDuckGo HTML endpoint | Query |
| Source-link resolution, if enabled | Grounding-link service | The supplied source-link reference |
| Extraction and artifact paging | Local process/filesystem | Stored response bytes; no hosted extraction |

A tool's outbound requests are not model-provider payloads and do not pass
through a provider-payload redaction hook. Intentional tool egress remains an
operator policy decision. Do not send session history, system prompts, local
artifacts, or fetched page bodies to search providers as hidden context.

`GEMINI_API_KEY` comes from the operator's environment or established protected
environment-file source, never a tool argument or behavior config. No credential
discovery, creation, migration, or live provider call is part of installation.
The implementation must not echo credentials or secret-bearing upstream URLs in
errors. Errors report a sanitized host/status and stable reason, not raw SDK
exception text. No cookies or arbitrary authorization-header tool arguments are
part of this interface.

## Configuration

**Proposed configuration contract:** a project-local
`<project>/<CONFIG_DIR_NAME>/web-surfer/config.json`, with `CONFIG_DIR_NAME`
supplied by Pi. Missing config uses the defaults below. Invalid config disables
network operations and returns `config_invalid` until corrected; it never
silently enables permissive defaults. Tools remain registered so the failure is
visible. Configuration is loaded as a complete document, not partially applied.

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

`backend` is `auto`, `gemini`, or `duckduckgo`. An explicit Gemini selection
without a usable key fails rather than overriding the operator's selection.
`privateNetworks` is `allow` or `deny`.

The reviewed transport defaults are a 1 MiB download cap, five redirects,
10-second connect timeout, 120-second total fetch attempt, 30-second search
request, and one-hour temporary-artifact retention. All fetch redirects share
the attempt budget; a hop does not restart it. A timeout is an operation failure,
not a latency acceptance test. Caller cancellation is distinct from timeout.

**Proposed remaining validation:** use owner-only configuration (0700 directory,
0600 file), reject unsafe file types, unknown/duplicate keys, and non-owned files.
Numeric sizes/timeouts are positive safe integers; redirects are nonnegative
safe integers. Proposed body/chunk ceilings are 64 MiB and 256,000 bytes.
Proposed result count is 1-10, default 10. No additional numeric ranges, retry loops, cache quotas, or
performance gates are implied by this document. These proposed ceilings and
count limits require review, not adoption by convention.

## web_fetch

### Input

**Proposed schema:**

| Field | Meaning |
|---|---|
| `url` | Required absolute HTTP(S) URL |
| `mode` | `readable` (default) or `raw` |
| `offset` | Byte offset in the served UTF-8 text, default zero |
| `chunkBytes` | Per-call response-page byte budget |
| `maxBodyBytes` | Per-call download cap for a new fetch |
| `artifactId` | Optional returned reference pinning an existing response |
| `refresh` | Explicit new fetch, default false |
| `saveTo` | Optional project-relative destination for the stored source bytes |

The fetch-to-artifact, page-without-re-download, and explicit save feature are
core behavior. `artifactId` and `refresh`, their combination rules, and the
publication details below are proposed refinements for correctness under
concurrent calls and changing URLs.

### Network and body handling

Validate the URL scheme and the project's origin policy before a request, on
every redirect, and before serving a cached response under changed policy.
Under `privateNetworks: "deny"`, checking DNS once and then independently
resolving again for the connection is insufficient: the actual connected
address must satisfy the policy. The HTTP transport must demonstrate that it
can enforce this through a supported API; do not patch its private internals.

Reject a declared `Content-Length` above the download cap before reading the
body. Independently enforce the cap while consuming the decoded response
stream: a compressed response must not expand beyond the cap unnoticed. Report
`sizeActual` when known, otherwise `bytesRead` and the cap. A larger authorized
fetch can be repeated with a higher per-call cap. No automatic retry or hidden
hosted-extractor fallback is specified.

Non-2xx responses retain the body and return `http_error` as a warning with the
actual status. Extraction failure returns an honest raw-text fallback with
`extraction_failed`, not an empty successful article.

**Proposed text contract:** UTF-8 text is served as text; invalid/unsupported
encodings and binary content use the artifact-summary path instead of lossy
replacement characters. `raw` means no HTML extraction, not arbitrary binary
bytes forced into a text block. Stored source bytes remain unchanged in either
mode. Select and declare an HTML extraction dependency based on synthetic
fixtures; no particular parser library or reference implementation is mandated.

### Artifacts, paging, and concurrency

**Proposed artifact contract:** use a protected per-project temporary namespace,
with 0700 directories and 0600 files/metadata, outside datastore roots. Cache
identity includes project identity and URL; it is not one global URL-only file.
Publish completed responses atomically and never expose partial downloads as
ready artifacts. Artifacts are external source evidence, not session journals
or indexable notes.

An immutable response reference pins source bytes, retrieval metadata, and its
served representation. A returned `artifactId` plus `nextOffset` pages that
response even if another call refreshes the same URL. Continuation must not
silently fetch different content after expiry. Return an explicit unavailable
artifact result so the caller can intentionally start again.

`refresh: true` starts a new response and does not invalidate a response being
paged. Reject refresh combined with an existing artifact or a nonzero paging
offset. **Proposed non-2xx policy:** retain error bodies for paging, but do not
reuse them for a new URL-only read; the next such read rechecks the origin.
Successful URL-only reads may reuse a fresh artifact. One-hour retention applies
per artifact; lazy expiry and a session-start cleanup remove only this package's
expired artifacts. Retention is not an aggregate cache-size guarantee.

Prepare each served representation once per artifact/mode. Byte offsets refer
to that representation, not necessarily the downloaded HTML bytes. Chunks end
on UTF-8 character boundaries; return the authoritative `nextOffset` in text
and metadata. Proposed EOF semantics: offset equal to the total length returns
an empty successful page with no continuation; negative, past-EOF, or mid-codepoint
offsets fail explicitly. No text is silently skipped between pages.

The proposed default content-page budget is 51,200 bytes. Metadata/header bytes
are additional and must be reported honestly; do not claim the whole tool result
fits a content-only cap. Any independent line cap or search-output cap needs its
own reviewed contract. In-process operations on the same cache/publication key
must coordinate, with cancellation ownership preserved; no global worker count,
waiter timeout, or cross-process locking protocol is prescribed. Implementation
must demonstrate the chosen supported concurrency behavior in disposable tests.

### saveTo and datastore ownership

`saveTo` is a real local write, not a read-only operation. The destination stays
inside the project and outside configured datastore roots, not merely outside
today's include globs. Cache/save operations do not index or promote web bodies
into memory. Saving never modifies Pi sessions or transport journals.

**Proposed publication:** create a new destination without overwriting an
existing file; refuse symlink traversal and hard-link promotion; recheck the
approved destination boundary at publication. Copy source bytes to the new
file and preserve the cached response so its paging reference remains usable.
Return both artifact reference and saved path. A failed save must not destroy
the downloaded evidence or masquerade as a successful save.

**Integration decision required before implementation:** the datastore's current
public v1 discovery reports readiness and store names, not authoritative root
paths. Its status contract does not define a root-enumeration or destination-
validation API. Model-facing status can display redacted paths such as
`<external>/<basename>`; those are not canonical paths or a supported policy API.

The datastore's operator config path and JSON format are documented. A
config-backed policy adapter is therefore a possible design choice, not a claim
that every config file is private. Before using it, explicitly establish its
supported cross-extension contract: identify the effective project/config
instance, when roots are resolved/refreshed, and how the publication check stays
consistent with datastore ownership. Do not copy the dependency's private
loader/containment algorithms or silently treat a guessed config instance as
proof. The alternative is a datastore-owned root/policy-validation interface.

The design PR must choose and authorize that boundary for both cache placement
and save publication. Neither option is implemented or approved here. Until it
is resolved, this required feature is not implementation-ready. Changing another
component's contract or implementation requires separate scoped approval.

### Output

Return HTTP status, safe source/final URL, content type, fetch time, artifact
reference, served mode, total text bytes, returned bytes, offset, `nextOffset`
or EOF, and warnings. A binary result returns content type, stored byte count,
and artifact reference instead of inline body text. Status/paging warnings
also appear in the model-facing text. An error result states whether a usable
artifact remains; do not confuse a failed save with a failed network fetch.

## web_search

`query` is required. **Proposed** `maxResults` ranges from 1 to 10, defaulting to
configured `maxResults`. Search never receives the full conversation as hidden
context. The keyed backend uses `gemini-2.5-flash` with `google_search` grounding;
model availability and its response adapter require opt-in live qualification,
not an assertion based solely on old research.

`auto` uses Gemini when a key is available and DuckDuckGo HTML otherwise. A
primary authentication, quota, network, timeout, or invalid-response failure may
make one fallback attempt in auto mode. Cancellation never triggers fallback.
Explicit backend selection never silently selects another backend. No additional
retries, provider catalog, or fan-out are specified.

Fallback results include this model-facing warning:

```text
[WARNING: Results from fallback path, inform the user that primary path failed!]
```

When no key is available, explain that the primary is unavailable; do not imply
an API request failed when none was attempted. Both-backend failure reports
sanitized per-backend causes.

**Proposed honest result contract:** Gemini returns an answer plus zero or more
attributed sources, bounded by `maxResults`; snippets are optional and never
invented. A useful answer with no sources is labeled ungrounded, not presented
as verified search evidence. Missing both usable answer and sources is a backend
failure. DuckDuckGo returns ranked title/URL entries with snippets when present;
it is not forced into a Gemini-generated answer shape.

**Proposed source-link handling:** preserve provider attribution; deduplicate
sources without inventing links or citation order. Resolve Google grounding
wrappers only through the declared source-link service, sharing the search
operation's budget rather than adding per-link deadlines. Do not fetch every
source page automatically. An unresolved source retains its provider reference
and a visible warning; do not fabricate a resolved URL or drop it silently.

Results disclose backend, fallback status, answer/source availability, result
count, and warnings in text and `details`.

**Proposed output bound:** cap the complete model-facing search text at 51,200
UTF-8 bytes, including attribution and warnings. Shorten answer/snippet text
before source attribution, preserve valid UTF-8, and disclose omissions rather
than claiming a complete answer. Reject an oversized upstream response rather
than buffering it without limit; the proposed decoded-response cap is 1 MiB.
These independent limits require explicit PR resolution before implementing the
provider adapter; a source-count limit alone does not bound an arbitrarily long
generated answer.

## Failures and cancellation

**Proposed result convention:** expected failures return one model-readable
text block and `details.ok: false` with a stable code. Warnings accompany usable
content with `details.ok: true`. This explicit convention does not assert that
returning an object makes Pi mark it as an execution error; the supported host
API distinguishes returned results from thrown execution failures. Unexpected
programming failures remain execution failures, not successful empty results.

Proposed code vocabulary:

- Input/policy: `malformed_url`, `unsupported_scheme`, `config_invalid`,
  `blocked_origin`, `refused_redirect`, `redirect_limit`, `invalid_offset`.
- Transport/lifecycle: `dns_failed`, `connection_failed`, `timeout`, `cancelled`,
  `size_exceeded`, `artifact_error`, `artifact_unavailable`.
- Save/search: `destination_blocked`, `save_failed`, `key_unavailable`,
  `search_failed`.
- Content warnings: `http_error`, `extraction_failed`, `source_unresolved`,
  `ungrounded_answer`.

Codes, result fields, and the distinction between policy rejection and I/O
failure require review; they are not an instruction to create a large error
framework. Cancellation stops owned requests and publication, cleans unfinished
artifacts, and leaves completed evidence intact. Shutdown must not leave work
continuing invisibly or start a fallback after its parent has ended.

## Implementation and verification boundary

Keep registration/configuration, HTTP/artifact handling, extraction, and the two
search adapters independently testable. Prefer a small host adapter over a
monorepo-shaped shared-module hierarchy. Declare imported runtime dependencies;
use public Pi exports and supported dependency APIs only. Source from external
reference projects is not an implementation input: author the code from the
reviewed contract and preserve any applicable attribution.

Future acceptance tests must demonstrate:

- Source and packed extension loading on each claimed host version, with no
  duplicate Pi runtime or implicit companion dependency.
- Missing/invalid configuration, explicit backend pins, and no network at load.
- HTTP status/body fidelity, redirects, scheme/origin enforcement, real address
  policy under deny, compressed-body caps, and parent cancellation.
- Stable UTF-8 paging with refresh races, expiry, concurrent callers, unchanged
  source bytes, and explicit artifact/save failure outcomes.
- Destination/cache policy through the chosen supported integration, including
  indexed-root rejection, symlink aliases, existing targets, and successful save.
- Synthetic Gemini answers with absent grounding, empty snippets, unresolved
  source links, and backend failures; DuckDuckGo fixtures; loud fallback; no
  fallback after cancellation; complete result-size reporting.

Use synthetic providers, local HTTP fixtures, and disposable protected projects
by default. Live search/fetch qualification is opt-in and separately authorized.
No historical monorepo pass/fail counts, skip counts, timing assertions, or
performance gates become this package's baseline. Until implementation exists,
the existing tests establish scaffold loading and packaging only.
