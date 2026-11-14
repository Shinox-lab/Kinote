# GridCraft

The inline spreadsheet editor for `.xlsx` files. It is the official
[GridCraft](https://github.com/storytold/gridcraft) web build, pinned and served
from an internal nginx container. The web console proxies it at `/gridcraft/`;
the editor runs in an iframe with an opaque origin.

## Pin

- Version: `0.19.1`
- Release: `https://github.com/storytold/gridcraft/releases/download/v0.19.1/gridcraft-web-0.19.1.zip`
- SHA-256: `48c5d1b101befebb3c5ba3b7a14914f01c3207934813ed07dc4251b7ae116a78`

The release is downloaded and checksum-verified at image build time. The
release's license and notice files are copied with the rest of the site.

## Console bridge

GridCraft's `?host=parent` bridge only answers a same-origin parent, and the
console's iframe is sandboxed to an opaque origin. So the image also serves
`host.html`: the release's `index.html` with the canvas in page host mode
(`data-host="page"`) plus `host-relay.js`, which forwards the editor's
`gridcraft:*` events to the console as `postMessage`s and the console's
`gridcraft:open` back. The Dockerfile fails the build if the release's markup
no longer matches those edits.

## Upgrade

Change `GRIDCRAFT_VERSION` and `GRIDCRAFT_SHA256` together in the Dockerfile,
rebuild the image, run the manual smoke test in `docs/operations.md`, then
deploy. Check the real build's CORS headers and `application/wasm` MIME before
enabling it for the team.

Never serve a newer build under an old checksum, and never add
`allow-same-origin` to the embedding iframe: the console's bearer token is in
`localStorage`.
