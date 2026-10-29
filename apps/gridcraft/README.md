# GridCraft

The inline spreadsheet editor for `.xlsx` files. It is the official
[GridCraft](https://github.com/storytold/gridcraft) web build, pinned and served
from an internal nginx container. The web console proxies it at `/gridcraft/`;
the editor runs in an iframe with an opaque origin.

## Pin

- Version: `0.13.0`
- Release: `https://github.com/storytold/gridcraft/releases/download/v0.13.0/gridcraft-web-0.13.0.zip`
- SHA-256: `e232edde1898459f13568ca7b1f3feecb4037f0cbb8f6aec86de1a3c096af5dc`

The release is downloaded and checksum-verified at image build time. The
release's license and notice files are copied with the rest of the site.

## Upgrade

Change `GRIDCRAFT_VERSION` and `GRIDCRAFT_SHA256` together in the Dockerfile,
rebuild the image, run the manual smoke test in `docs/operations.md`, then
deploy. Check the real build's CORS headers and `application/wasm` MIME before
enabling it for the team.

Never serve a newer build under an old checksum, and never add
`allow-same-origin` to the embedding iframe: the console's bearer token is in
`localStorage`.
