# xeokit iframe viewer (AGPL-3.0)

A small, standalone 3D model viewer built on [xeokit-sdk](https://github.com/xeokit/xeokit-sdk).
It is embedded by a host application inside an `<iframe>` and communicates with it **only over
`postMessage`** — it has no authentication, no API access and no business logic of its own.

## License

`xeokit-sdk` is licensed under **AGPL-3.0**, and so is this viewer. It is a standalone application
with its own dependency tree, its own build and its own origin — not a library. The only contact
surface with an embedding host is the typed message protocol in [`src/protocol.ts`](src/protocol.ts),
exchanged over `postMessage`. No code is shared as a package across that boundary, in either direction.

That one file is **dual-licensed `AGPL-3.0-only OR MIT`** (see [LICENSE-MIT](LICENSE-MIT)). A host may
therefore implement the contract — including by copying the file — without taking on AGPL obligations.
Everything else here is AGPL-3.0.

Per AGPL-3.0 §13, this repository is the complete corresponding source of the running viewer. The
about dialog (the **©** button) prints the version and commit of the build being served.

## Protocol

See [`src/protocol.ts`](src/protocol.ts) for the authoritative contract. Supported model formats are
`.xkt` and plain `.json`.

The host appends `?host=<its-origin>` to the iframe `src`. The viewer only accepts messages from — and
posts messages to — that origin; without it (standalone dev) it falls back to `*` with a console
warning. Anti-clickjacking is enforced via a `frame-ancestors` CSP **response header** (set by the Vite
dev server in `vite.config.ts` and by nginx in production) — not a `<meta>` tag, which browsers ignore
for that directive.

## Development

```bash
pnpm install
pnpm dev            # http://localhost:5273
```

Open `http://localhost:5273/?dev` to enable a local file picker / drag-and-drop for `.xkt`/`.json`
without a host — handy for testing the viewer in isolation.

```bash
pnpm build          # static bundle → dist/
pnpm preview
```

## Deployment

`pnpm build` produces a static `dist/`. Serve it from any static host on its own origin, and point the
embedding application's iframe at that origin.

A ready-made image is included — it builds with this directory as the context:

```bash
docker build -f docker/Dockerfile --target viewer -t xeokit-viewer .
docker run -p 8080:8080 -e FRAME_ANCESTORS="https://app.example.com" xeokit-viewer
```

`FRAME_ANCESTORS` becomes the `frame-ancestors` CSP header — the origin(s) allowed to embed the
viewer. It defaults to `'self'`, which blocks embedding, so a real deployment must set it. See
`docker/nginx.conf.template` for the rest of the server configuration.
