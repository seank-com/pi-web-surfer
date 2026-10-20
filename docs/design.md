# Web surfer design

Status: design decisions D1–D14 are resolved with the owner on 2026-10-20 and
recorded in the design PR description's decision log; this document is the
resulting product contract, not implementation approval. The current package is
a loadable scaffold and registers no tools. The one outstanding dependency is
the D1 datastore root/policy-validation API, which must exist in
pi-markdown-datastore before cache placement and save publication are
implemented; the architectural choice for that boundary is made (see "saveTo
and datastore ownership"). The design PR owns review decisions and
investigation history; this document owns the resulting product contract.

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

**Integration:** register both tools during extension initialization;
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
| POST/PUT body injection | Requested origin | Injected body: literal template text plus spliced file and template content |
| Primary search | Google Gemini API with Google Search grounding | Query and search instruction, not the session transcript |
| Keyless search | DuckDuckGo HTML endpoint | Query |
| Source-link resolution | Grounding-link service | The supplied source-link reference |
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
exception text. No cookie tool arguments exist. Authorization headers are
permitted only through the `headers` map with environment-injected values;
literal credential values must not be passed as tool arguments.

## Configuration

**Configuration contract:** a project-local
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

Validation: use owner-only configuration (0700 directory, 0600 file), reject
unsafe file types, unknown/duplicate keys, and non-owned files. Numeric
sizes/timeouts are positive safe integers; redirects are nonnegative safe
integers. Body/chunk ceilings are 64 MiB and 256,000 bytes; result count is
1-10, default 10 (ratified 2026-10-20, D9/D10). No additional numeric ranges,
retry loops, cache quotas, or performance gates are implied by this document.

## web_fetch

### Input

**Input schema:**

| Field | Meaning |
|---|---|
| `url` | Required absolute HTTP(S) URL, absent when `path` is given |
| `path` | Optional local file path read instead of a URL |
| `mode` | `readable` (default) or `raw` |
| `offset` | Byte offset in the served UTF-8 text, default zero |
| `chunkBytes` | Per-call response-page byte budget |
| `maxBodyBytes` | Per-call download cap for a new fetch |
| `artifactId` | Optional returned reference pinning an existing response |
| `refresh` | Explicit new fetch, default false |
| `saveTo` | Optional project-relative destination for the stored source bytes |

The fetch-to-artifact, page-without-re-download, and explicit save feature are
core behavior. `artifactId` and `refresh`, their combination rules, and the
publication details below are refinements for correctness under concurrent
calls and changing URLs. When `artifactId` is supplied, `url` and `path` must
be omitted; supplying either against an existing artifact fails with
`artifact_error` naming the mismatch. `refresh` cannot be combined with an
`artifactId` or a nonzero paging offset.

**Local-path reads:** exactly one of `url` and `path` is required. A path read
performs no network activity, applies no origin policy, and is bound only by
the operating system: any file the process may read is a valid input. Local
reads are a deliberate operator/agent choice, not a hidden egress, so no
owner-only path discipline is imposed. The artifact is built from the file
bytes with cache identity keyed by path, file size, and modification time: a
change in size or modification time produces a fresh artifact, while a
same-size replacement that preserves the modification time may reuse the prior
representation; `refresh: true` forces a new read. Content type comes from the
file extension: `.html`/`.htm` run the same HTML extraction as a URL fetch in
`readable` mode (so a saved HTML page re-reads as paged Markdown), other
extensions serve their text, and a missing or unrecognized extension serves raw
text with no extraction. A missing or unreadable path is an `artifact_error`,
not a success with empty content.

### Network and body handling

Validate the URL scheme and the project's origin policy before a request, on
every redirect, and before serving a cached response under changed policy.
Under `privateNetworks: "deny"`, the policy check is performed within the
name-resolution step used by the connection: one authoritative lookup supplies
the address that is connected to, so the checked address and the connected
address cannot diverge. Literal IP hosts are subject to the same check.
Traffic that bypasses the process's egress, or kernel-level re-resolution
after the socket is connected, is outside this tool's scope; operators who
need network-level enforcement apply it at the gateway.

Reject a declared `Content-Length` above the download cap before reading the
body. Independently enforce the cap while consuming the decoded response
stream: a compressed response must not expand beyond the cap unnoticed. Report
`sizeActual` when known, otherwise `bytesRead` and the cap. A larger authorized
fetch can be repeated with a higher per-call cap. No automatic retry or hidden
hosted-extractor fallback is specified.

Non-2xx responses retain the body and return `http_error` as a warning with the
actual status. Extraction failure returns an honest raw-text fallback with
`extraction_failed`, not an empty successful article.

**Injected-request redirects:** a same-origin redirect (same scheme and host)
forwards the method, injected body, and headers unchanged. A cross-origin
redirect re-issues the request as a GET with no body and does not forward any
headers, so environment-injected credentials and spliced file content never
follow a redirect to a different origin. Origin policy is checked at every hop
as stated above; synthetic tests must cover both redirect shapes.

**Text contract:** UTF-8 text is served as text; invalid/unsupported
encodings and binary content use the artifact-summary path instead of lossy
replacement characters. `raw` means no HTML extraction, not arbitrary binary
bytes forced into a text block. Stored source bytes remain unchanged in either
mode. Select and declare an HTML extraction dependency based on synthetic
fixtures; no particular parser library or reference implementation is mandated.

### Artifacts, paging, and concurrency

**Artifact contract:** artifacts live in the protected temporary
namespace `$TMPDIR/web-surfer/<project-hash>/<request-key>/`, where the
request key encodes the full cache identity for that artifact (for a plain
GET, the URL hash; for an injected request, URL plus method and digest; for a
path read, path plus size and modification time), with 0700
directories and 0600 files/metadata, outside datastore roots. The project
hash is derived from the absolute working-directory path, so each project
gets its own namespace; the namespace is per-project, and URL alone never
identifies an artifact. Artifacts are intentionally ephemeral: they live in
the system temp area, not the protected project configuration directory,
which holds only durable state. Publish completed responses atomically and
never expose partial downloads as ready artifacts. Artifacts are external
source evidence, not session journals or indexable notes.

An immutable response reference pins source bytes, retrieval metadata, and its
served representation. A returned `artifactId` plus `nextOffset` pages that
response even if another call refreshes the same URL. Continuation must not
silently fetch different content after expiry. Return an explicit unavailable
artifact result so the caller can intentionally start again.

Automatic reuse applies only to plain GET requests — no body and no custom
headers — whose identity is project plus URL. A request with a non-GET method,
a body, or custom headers is never satisfied from a cached response: it always
performs a new request, and its artifact is keyed by project, URL, method, and
a digest of its sorted headers and body, so distinct requests remain distinct.
Path reads reuse only under their own identity (path, size, modification
time, as stated above). `artifactId` paging is independent of all reuse
rules.

`refresh: true` starts a new response and does not invalidate a response being
paged. Reject refresh combined with an existing artifact or a nonzero paging
offset. **Non-2xx policy:** retain error bodies for paging, but do not
reuse them for a new URL-only read; the next such read rechecks the origin.
Successful URL-only reads may reuse a fresh artifact. One-hour retention applies
per artifact; lazy expiry and a session-start cleanup remove only this package's
expired artifacts. Retention is not an aggregate cache-size guarantee. Operating-
system temp cleanup may remove artifacts before retention expires; that surfaces
as an explicit unavailable-artifact result, not a silent failure, and callers
start again deliberately.

Prepare each served representation once per artifact/mode. Byte offsets refer
to that representation, not necessarily the downloaded HTML bytes. Chunks end
on UTF-8 character boundaries; return the authoritative `nextOffset` in text
and metadata. EOF semantics: offset equal to the total length returns
an empty successful page with no continuation; negative, past-EOF, or mid-codepoint
offsets fail explicitly. No text is silently skipped between pages.

The default content-page budget is 51,200 bytes. Metadata/header bytes
are additional and must be reported honestly; do not claim the whole tool result
fits a content-only cap. Any independent line cap or search-output cap needs its
own reviewed contract. In-process operations on the same cache/publication key
must coordinate, with cancellation ownership preserved; no global worker count,
waiter timeout, or cross-process locking protocol is prescribed. Implementation
must demonstrate the chosen supported concurrency behavior in disposable tests.

### saveTo and datastore ownership

`saveTo` is a real local write, not a read-only operation. The destination stays
inside the project and outside configured datastore roots, not merely outside
today's include globs. It also stays outside the project's protected
configuration directory (`CONFIG_DIR_NAME`), which holds only durable state;
`saveTo` failures must not require a configuration rollback. Cache/save operations do not index or promote web bodies into memory. Saving never modifies Pi sessions or transport journals.

**Publication:** create a new destination without overwriting an
existing file; refuse symlink traversal and hard-link promotion; recheck the
approved destination boundary at publication. Copy source bytes to the new
file and preserve the cached response so its paging reference remains usable.
Return both artifact reference and saved path. A failed save must not destroy
the downloaded evidence or masquerade as a successful save.

**Outstanding dependency (D1, decided 2026-10-20):** the datastore-owned
root/policy-validation API is the chosen boundary for both cache placement and
save publication. The datastore's current public v1 discovery reports readiness
and store names, not authoritative root paths; its status contract does not
define a root-enumeration or destination-validation API, and model-facing
status roots are redacted, not canonical paths or a supported policy API. That
API — authoritative root enumeration plus destination validation owned by
pi-markdown-datastore — must exist before this feature is implemented.
web-surfer calls it at operation time and again at publication, and does not
infer roots from configuration files, copy the datastore's private loader or
containment algorithms, or treat a guessed config instance as proof.
Implementing that API is a separate, scoped change in pi-markdown-datastore,
tracked alongside pi-telegram-owner issue #5. Until it lands, cache placement
and saveTo publication are not implementation-ready; the architectural choice
itself is closed.

### Output

Return HTTP status, safe source/final URL, content type, fetch time, artifact
reference, served mode, total text bytes, returned bytes, offset, `nextOffset`
or EOF, and warnings. A binary result returns content type, stored byte count,
and artifact reference instead of inline body text. Status/paging warnings
also appear in the model-facing text. An error result states whether a usable
artifact remains; do not confuse a failed save with a failed network fetch.

## web_fetch body and template injection

**Body and template injection:** `web_fetch` accepts an optional `method`
(`GET` by default, `POST`, `PUT`), a `headers` map, and a `body` string,
extending the input schema. Header values and the body are top-level templates
supporting three placeholders:

- `{{env:NAME}}` resolves from the process environment at call time; an unset
  variable fails with a stable code. Only top-level templates resolve
  `{{env:}}`; it never resolves inside spliced file or template content, so
  untrusted text cannot reference credentials.
- `{{file:path}}` reads a file and splices its text in, bound only by the
  operating system: any file the process may read may be spliced.
- `{{template:path,{vars}}}` reads a template file, resolves `{{name}}`
  placeholders against the JSON variable map, and continues resolution in the
  result.

`{{file:}}` and `{{template:}}` may be spliced recursively, with a depth cap
of 3 and cycle detection; exceeding the cap or cycling fails explicitly. A JSON map
parse failure falls back to naive `key:value` parsing with a warning. Spliced
content is inserted as-is, without escaping or encoding transformation. The
literal body is a bounded payload; file and template reads follow the same
honest size-cap and reporting discipline as downloads.

POST and PUT to origins permitted by the fetch origin policy include the
injected body in the material sent. Environment-injected values must never
appear in errors, warnings, or request echoes. The mechanism supports calling
local inference endpoints with path-referenced template files ("bottles"), so
the model need not carry template text in context. Bottle prompts, endpoint
conventions, and response interpretation belong to the calling skill; no prompt
engine, endpoint registry, retry loop, or response shaping is added to this
tool.

**Body/template codes:** `env_unavailable`, `template_error`.

## web_search

`query` is required. `maxResults` ranges from 1 to 10, defaulting to
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

**Honest result contract:** Gemini returns an answer plus zero or more
attributed sources, bounded by `maxResults`; snippets are optional and never
invented. A useful answer with no sources is labeled ungrounded, not presented
as verified search evidence. Missing both usable answer and sources is a backend
failure. DuckDuckGo returns ranked title/URL entries with snippets when present;
it is not forced into a Gemini-generated answer shape.

**Source-link handling:** preserve provider attribution, order, and
content as returned by the service; do not deduplicate, re-order, or otherwise
alter the result set. Resolve Google grounding
wrappers only through the declared source-link service, sharing the search
operation's budget rather than adding per-link deadlines. Do not fetch every
source page automatically. An unresolved source retains its provider reference
and a visible warning; do not fabricate a resolved URL or drop it silently.

Results disclose backend, fallback status, answer/source availability, result
count, and warnings in text and `details`.

**Output bound:** cap the complete model-facing search text at 51,200
UTF-8 bytes, including attribution and warnings. Shorten answer/snippet text
before source attribution, preserve valid UTF-8, and disclose omissions rather
than claiming a complete answer. Reject an oversized upstream response rather
than buffering it without limit; the decoded-response cap is 1 MiB.
These independent limits require explicit PR resolution before implementing the
provider adapter; a source-count limit alone does not bound an arbitrarily long
generated answer.

## Failures and cancellation

**Result convention:** expected failures return one model-readable
text block and `details.ok: false` with a stable code. Warnings accompany usable
content with `details.ok: true`. This explicit convention does not assert that
returning an object makes Pi mark it as an execution error; the supported host
API distinguishes returned results from thrown execution failures. Unexpected
programming failures remain execution failures, not successful empty results.

Code vocabulary:

- Input/policy: `malformed_url`, `unsupported_scheme`, `config_invalid`,
  `blocked_origin`, `refused_redirect`, `redirect_limit`, `invalid_offset`.
- Transport/lifecycle: `dns_failed`, `connection_failed`, `timeout`, `cancelled`,
  `size_exceeded`, `artifact_error`, `artifact_unavailable`.
- Save/search: `destination_blocked`, `save_failed`, `key_unavailable`,
  `search_failed`.
- Body/template: `env_unavailable`, `template_error`.
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
- HTTP status/body fidelity, redirects, scheme/origin enforcement, deny policy
  for hostnames and literal IP hosts through the shared lookup, compressed-body
  caps, and parent cancellation.
- Reuse eligibility: a cached plain GET never satisfies a POST/PUT or a
  request carrying a body or headers; distinct bodies at the same URL remain
  distinct artifacts. Same-origin versus cross-origin redirect forwarding of
  method, body, and headers, with no credential or file-content forwarding
  across origins. Local-path reads: size or modification-time changes produce
  fresh artifacts, same-size preserved-mtime reuse is possible, and
  `refresh: true` forces a new read.
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
