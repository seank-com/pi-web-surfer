# pi-web-surfer

A private, unpublished standalone Pi extension with two tools:

- `web_fetch` retrieves immutable source artifacts, converts documents locally
  with Microsoft's official MarkItDown engine, and serves bounded text pages.
- `web_search` uses Gemini grounding when a key is present, or a disclosed
  keyless DuckDuckGo selection when no key is configured.

`web_fetch` requires exactly one ready, compatible pi-markdown-datastore
ownership-policy service, including for plain URL fetches and local-file reads
without `saveTo`: it must validate protected artifact placement. Missing policy
availability fails closed; `web_search` does not require that service. This is a
policy-service dependency, not a requirement for fresh search indexes.

See [design](docs/design.md) for the contract and [setup](docs/setup.md) for
installation. Pi supplies host peers; do not load the extension twice.

## Install local conversion dependencies

In an unloaded checkout, use Node 24.14.1 or later and Python 3.14 (qualified
with 3.14.6). The Python runtime dependencies are fully pinned with hashes:

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
```

For an installed package, create its interpreter environment separately, install
that package's `python/requirements.lock`, and set `WEB_SURFER_PYTHON` to the
absolute interpreter path. No installation or download occurs on tool load or
conversion. Without the override, a checkout-local `.venv/bin/python` is used
when present, otherwise `python3`. Missing dependencies return a conversion
failure with the original artifact retained. The bridge and lock ship in the
package; the environment does not.

## web_fetch

- Supply `url` (HTTP/HTTPS) or `path` (local file), or page an existing
  `artifactId` with neither source field.
- `mode: readable` is the default. HTML, PDF and DOCX use local MarkItDown;
  `raw` preserves the original representation. `operation: convert` explicitly
  converts a stored source. The official public registry enables HTML, PDF,
  DOCX and plain-text converters only; unsupported formats fail explicitly.
  Whole-ZIP, network/cloud converters and plugins are not registered. No model
  client or URL conversion API is used.
- `view: artifact` returns identity/provenance only, without source text. The
  default `view: page` returns ordinary bounded UTF-8 pages.
- Page using the returned `artifactId` and `nextOffset`. `refresh` explicitly
  fetches a new original. Converted artifacts are distinct from originals;
  `sourceArtifactId` and provenance identify their exact parent and SHA-256.
- POST/PUT `body` and `headers` accept `{{env:NAME}}`, `{{file:path}}`,
  `{{template:path,{"var":"value"}}}`, and direct artifact references.
- `{{artifact:ID}}` inserts the complete artifact's UTF-8 text literally.
  `{{artifact:ID,json}}` inserts a complete quoted JSON string value. Inserted
  content is never interpreted as more placeholders. References are project
  scoped, expire with the artifact, and recheck current ownership/origin policy.
- `saveTo` creates a new project-relative file without overwriting or indexing.
  An initial fetch/conversion saves the original bytes. Paging a chosen artifact
  saves that artifact's bytes, so use the original ID with `mode: raw` to save
  the original, or the converted ID to save Markdown.

### Convert and summarize without loading document text into context

Download/convert with metadata-only output:

```json
{"url":"https://example.org/report.pdf","view":"artifact"}
```

Use the returned **converted** artifact ID in a template file, for example
`summarize.json`:

```json
{"model":"chosen-local-model","system":"Summarize in 300 words.","prompt":{{artifact:{{source}},json}},"stream":false}
```

Then explicitly call the authorized local endpoint:

```json
{"url":"http://localhost:11434/api/generate","method":"POST","headers":{"content-type":"application/json"},"body":"{{template:summarize.json,{\"source\":\"CONVERTED_ARTIFACT_ID\"}}}"}
```

The entire converted text goes directly into the request body. No intermediate
`saveTo`, read-into-context, copy-back, or hidden model call is involved. Only the
endpoint's response is served back as a page. The calling bottle/skill owns the
prompt, endpoint authorization and response interpretation.

### ZIPs: list first, select explicitly

```json
{"path":"bundle.zip","operation":"zip-list"}
```

This reads only archive metadata: zero-based member index, name, declared
uncompressed size (an exact decimal string), and directory flag. It never
opens/decompresses members. The JSON index is its own derived, pageable artifact;
its `sourceArtifactId` identifies the original ZIP. Choose from those entries:

```json
{"artifactId":"ORIGINAL_ZIP_ID","operation":"convert","memberIndex":2,"view":"artifact"}
```

Only the selected member is decompressed. Its name is provenance, never a
filesystem extraction path. Duplicate names are distinguished by index. A
selected nested ZIP remains an immutable source to list/select again; it is
never recursively converted wholesale. Originals, selected member bytes and
converted Markdown have distinct artifact IDs and parent links.

Declared sizes inform the agent's decision, not enforcement. No package-imposed
conversion, internal-body, template, ZIP expansion, ratio, member-count or output
limits are added. There are no conversion timeouts, deadlines or retries.
Existing external-response limits and pagination remain. Caller/session
cancellation terminates owned conversion work and removes unfinished temporary
files; completed originals remain available.

## Policy, search and artifacts

HTTP uses native Node fetch, manual redirects and the minimal Undici checked-DNS
connector in deny mode. No custom HTTP/search timeouts are added. Datastore
policy-v1 must be ready for cache/save publication; absence is not empty scope.
Search remains independently usable. A supplied Gemini key never triggers an
error-based backend switch; only key absence selects DuckDuckGo automatically.

Artifacts live under `$TMPDIR/web-surfer/<project>/<request>/`, outside project
configuration and datastore roots. They are protected, immutable temporary
sources/derivatives, not authoritative notes. Existing one-hour per-artifact
retention and explicit unavailable-reference behavior apply.

## Development

Select a host explicitly with `PI_CODING_AGENT_PACKAGE=/path/to/pi-coding-agent`.
`DATASTORE_TARBALL=/path/to/datastore.tgz npm run test:integration` tests the
packed public interfaces in both companion orders, including an actual native
`web_fetch` PDF/template/synthetic-Ollama flow that verifies the complete converted
source never enters the originating model context. Tests use synthetic responses
and disposable protected projects, not live providers or agent state.

Run `npm run hooks:install` to enable private-term/secret checks before commits
and pushes. `npm run check:private -- --all` checks staged contents. Installation,
publication, live provider calls and runtime activation require separate scope.
