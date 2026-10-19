# pi-web-surfer
A standalone Pi extension for web research.

The current package is a loadable scaffold and registers no tools. The proposed
`web_search` and artifact-backed, paged `web_fetch` contracts are in
[design](docs/design.md); [setup](docs/setup.md) distinguishes current development
commands from the candidate feature configuration. Implementation follows design
review, not the presence of those documents.

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
packed tarball. Select a different host artifact explicitly:

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
