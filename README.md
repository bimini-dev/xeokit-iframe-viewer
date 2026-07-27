# xeokit iframe viewer (AGPL-3.0)

A small, standalone 3D model viewer built on [xeokit-sdk](https://github.com/xeokit/xeokit-sdk).
It is designed to be embedded by a host application inside an `<iframe>` and to communicate with it
**only over `postMessage`** — it has no authentication, no API access and no business logic of its own.

## About this repository

This is a **published mirror**. Development happens in a private monorepo; this repository exists so that
the complete corresponding source of the deployed viewer is publicly available, as AGPL-3.0 §13 requires.
Each commit here is a snapshot, and its message records the upstream revision it was taken from.

To find the source matching a _running_ viewer: open its About dialog (the **©** button) — it prints the
build commit, which is the upstream revision named in the corresponding sync commit message here.

Issues and pull requests are welcome but may not be actively monitored; changes are merged upstream first
and then land here on the next sync.

## Why it is a separate app

`xeokit-sdk` is licensed under **AGPL-3.0**. To keep it out of a (typically closed-source) host
application, the viewer is an independent, open-source app with its own dependency tree and its own
AGPL-3.0 license. The only contact surface with the host is the typed message protocol in
[`src/protocol.ts`](src/protocol.ts). No code is shared as a package across that boundary.

That one file is **dual-licensed `AGPL-3.0-only OR MIT`** (see [LICENSE-MIT](LICENSE-MIT)). A host may
therefore implement the contract — including by copying the file — without taking on AGPL obligations.
Everything else here is AGPL-3.0.

Per AGPL-3.0 §13, the complete corresponding source of the running viewer is available at
<https://github.com/bimini-dev/xeokit-iframe-viewer>; keep the published source in sync with whatever is
actually deployed.

## The boundary protocol

See [`src/protocol.ts`](src/protocol.ts) for the authoritative contract. Summary:

**Host → viewer:** `init`, `loadModel` (bytes + format), `setCommentMarkers`, `focusElement`,
`setCamera`, `selectElement`, `clearModel`.

**Viewer → host:** `ready`, `modelLoaded`, `loadError`, `elementSelected`, `commentMarkerClicked`,
`cameraChanged`.

Supported formats: `.xkt` and plain `.json`.

### Comment markers

The host sends a list of element ids that have comments; the viewer draws a clickable pin on each
(anchored at the element AABB centre, or an explicit world anchor). Clicking a pin emits
`commentMarkerClicked` — the host handles it however it likes (e.g. opening the comment in its own UI).
The viewer itself contains no comment/thread UI.

### Security

The host appends `?host=<its-origin>` to the iframe `src`. The viewer only accepts messages from — and
posts messages to — that origin. Without it (standalone dev) the viewer falls back to `*` with a
console warning; a real host always sets it. Anti-clickjacking is enforced via a `frame-ancestors` CSP
**response header** (set by the Vite dev server in `vite.config.ts` and by nginx in production) — not a
`<meta>` tag, which browsers ignore for that directive.

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
docker run -p 8080:8080 xeokit-viewer
```

Set `FRAME_ANCESTORS` to the origin(s) allowed to embed the viewer — it becomes the `frame-ancestors`
CSP header. It defaults to `'self'`, which blocks embedding, so a real deployment must set it:

```bash
docker run -p 8080:8080 -e FRAME_ANCESTORS="https://app.example.com" xeokit-viewer
```

See `docker/nginx.conf.template` for the rest of the server configuration.
