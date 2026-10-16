# Setup

Build the local candidate with `npm ci && npm run build`, then pass
`-e /path/to/pi-web-surfer/dist/index.js` to a compatible Pi host. The manifest
exposes the same entry for Pi package discovery.

## Development

Run `npm run hooks:install` once per clone to refuse commits and pushes that
contain private terms or secrets; see the README for what is checked.
