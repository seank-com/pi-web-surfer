# pi-web-surfer
A simple extension for Pi that allows an agent to surf the web

## Development

To keep private terms and secrets out of commits, run
`git config core.hooksPath .githooks` once per clone (Node 24.14.1 or later).
Commits and pushes are then refused when an added line or a commit message
contains a line of `~/.pii` (one term per line, matched case-insensitively;
`#` lines are comments) or a value of 8 or more characters from `~/.env`.
`PRIVATE_TERMS_FILE` and `PRIVATE_SECRETS_FILE` select other files.
`node scripts/check-private-terms.ts --all` checks every staged file, including
unchanged ones.
