# Web surfer design

The package is a standalone Pi extension with one entry, `dist/index.js`. Its
default export is the extension produced by `createWebSurferExtension()`, which
Pi calls with its extension API at load. Tools are registered through that API;
the extension has no runtime dependencies beyond the Pi host.

The entry currently registers no tools, so loading it does not change an agent's
behavior.
