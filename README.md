# InkSync

**A self-hosted, LAN-based PDF study and annotation tool for synchronized reading and handwriting across devices.**

InkSync lets you open a PDF on a computer and connect phones or other devices on the same local network. Every connected device views the same document while handwritten annotations are synchronized in real time.

Design idea: the computer provides the document, each client renders it locally, and the server only synchronizes the state and annotations that need to be shared.

---

## Features

- **Shared PDF viewing** — upload a PDF once, open it on the computer and any connected device; each document gets a content-based identifier.
- **LAN-first** — runs on your computer, devices connect via its local IP. No cloud account or external service required.
- **Client-side rendering** — PDF parsing/rendering happens on the client via PDF.js in a Web Worker; the server just stores and serves files.
- **Local caching** — PDFs are cached via IndexedDB (primary) and a Service Worker (where supported), so zoom/pan/navigation don't re-download the file.
- **Real-time sync** — strokes, erases, undo, and camera/view state sync over WebSockets; new clients get the current state on join.
- **Handwriting/annotation** — pen, highlighter, eraser, multiple colors, pressure-sensitive width where available. Annotations are stored separately from the PDF.
- **Touch controls** — one finger draws, two fingers pan or pinch-zoom depending on the initial gesture, with a dead zone to avoid misclassification.
- **Mouse/stylus support** — same annotation pipeline as touch; stylus pressure affects width; touch is briefly rejected after stylus input to reduce palm-touch errors.
- **Device-independent positioning** — annotations are stored in PDF page coordinates, not screen coordinates, so strokes stay anchored across zoom levels and devices.
- **Optimized zoom rendering** — existing bitmaps are scaled during active gestures, high-quality render happens after the gesture settles, and only near-viewport pages stay rendered.
- **Undo/erase** — undo removes the calling author's last stroke; eraser removes strokes via hit-testing.
- **Auto-reconnect** — WebSocket reconnects automatically with exponential backoff.
- **Wake Lock** — keeps the writer's screen awake during a session, where supported.
- **Multiple writers** — more than one writing client can join the same document room.
- **E2E tests** — cover touch gestures, stylus drawing, cross-device coordinates, and rendering regressions.

---

## What it's for

Use the large screen of a computer to read, and the touch interaction of a phone/tablet to write, at the same time:

1. Open a PDF on your computer.
2. Connect your phone to the same LAN.
3. Open the generated writer link on the phone.
4. Read on the computer, write on the phone — everything stays synchronized.

The server doesn't stream or repeatedly render the PDF — clients fetch it once, render it locally, and only sync lightweight state.

---

## Architecture

```text
                    ┌──────────────────────┐
                    │      InkSync Server  │
                    │   Python + aiohttp   │
                    │  PDF storage         │
                    │  WebSocket sync      │
                    │  Annotation storage  │
                    └──────────┬───────────┘
                               │
                    Local Network / LAN
                               │
              ┌────────────────┴────────────────┐
      ┌───────▼────────┐                ┌───────▼────────┐
      │ Computer       │                │ Phone / Tablet │
      │ Reader         │                │ Writer         │
      │ Local render   │                │ Local render   │
      │ Mouse / Pen    │                │ Touch input    │
      └────────────────┘                └────────────────┘
```

**Server** — a single Python (`aiohttp`) app. Serves the web app, handles PDF uploads/storage, creates per-document sync rooms, hosts the WebSocket endpoint, and persists annotations and camera state. It does not render PDF pages.

**Client** — plain JavaScript, no framework or build step. Each client downloads and caches the PDF, renders it with PDF.js, handles zoom/pan locally, and sends only sync-relevant data.

---

## Synchronization model

Each PDF is its own sync room. The server tracks connected clients, strokes, current camera state, and sync messages for new strokes, erasing, undo, and camera/view position.

Camera state is document-relative, not screen-relative:

```json
{ "page": 17, "fx": 0.52, "fy": 0.41 }
```

Zoom is intentionally **not** shared — each device can zoom independently while pointing at the same document location, since phone and computer screens differ a lot.

---

## Annotations

Annotations are stored separately from the PDF and never modify the original file. A stroke carries its page, mode, color, width, points, pressure (if available), and author/stroke identity, all in **PDF page coordinates** rather than screen coordinates — so it stays anchored across devices, zoom levels, and screen sizes:

```json
{
  "page": 17,
  "mode": "pen",
  "color": "...",
  "width": 3,
  "points": [
    { "x": 0.423, "y": 0.681, "p": 0.7 },
    { "x": 0.431, "y": 0.689, "p": 0.8 }
  ]
}
```

## Touch interaction

- **One finger** → draw.
- **Two fingers, moving together, stable distance** → pan.
- **Two fingers, distance changing** → pinch-zoom.

Intent is detected from the initial movement and then locked for the rest of the gesture, with a dead zone to prevent accidental switching. The system also handles a second finger joining mid-draw, one finger lifting mid-gesture, and stylus/touch overlap.

---

## Rendering & performance

- Only a limited number of nearby pages (up to six) stay actively rendered, each as a PDF bitmap canvas + a transparent annotation canvas.
- Large pages can use region-based rendering instead of rendering the full page at extreme resolution.
- During an active pinch, the existing bitmap is scaled cheaply; a high-quality re-render happens once the gesture settles.

## Caching

IndexedDB is the primary PDF cache (documents are identified by content hash), since InkSync typically runs over plain HTTP on a LAN where Service Workers may not apply. A Service Worker adds a secondary cache-first layer where supported. Once cached, zoom/pan/navigation/annotation don't require re-downloading the PDF.

---

## Project structure

```text
InkSync/
├── run_windows.bat
├── run_linux.sh
├── run_mac.command
├── server.py
├── preflight.py
│
├── web/
│   ├── index.html
│   ├── reader.html
│   ├── writer.html
│   ├── sw.js
│   ├── css/style.css
│   ├── js/
│   │   ├── pdf-core.js
│   │   ├── sync.js
│   │   ├── idb-cache.js
│   │   └── strokes.js
│   └── vendor/pdfjs/
│
└── tests/
    ├── test-setup.mjs
    ├── touch-e2e.mjs
    ├── pen-e2e.mjs
    ├── coord-e2e.mjs
    ├── ghost-test.mjs
    ├── jitter-test.mjs
    ├── drift-test.mjs
    ├── pdf-map-probe.mjs
    ├── no-blank-test.mjs
    └── fixtures/
        ├── 3675713f0f24.pdf
        ├── 6a92c8471c4d.pdf
        └── 6a92c8471c4d.meta.json
```

| Component | Purpose |
|---|---|
| `server.py` | HTTP server, PDF upload/storage, WebSocket sync, persistence |
| `preflight.py` | Pre-launch diagnostic run automatically by the launcher scripts (Python version, `aiohttp`, required files, `docs/` writability, port availability); reports OK/WARN/FAIL and can trigger an auto-install of `aiohttp` into a private `.venv` |
| `web/index.html` | Main interface and PDF upload |
| `web/reader.html` | Computer/reader interface |
| `web/writer.html` | Touch-focused writing interface |
| `web/js/pdf-core.js` | PDF viewer, rendering, zoom, pan, coordinate conversion |
| `web/js/sync.js` | WebSocket sync and reconnection |
| `web/js/idb-cache.js` | IndexedDB PDF caching |
| `web/js/strokes.js` | Annotation rendering and hit-testing |
| `web/sw.js` | Service Worker caching |
| `web/vendor/pdfjs/` | Vendored PDF.js |
| `tests/` | Browser-based E2E regression tests |
| `tests/test-setup.mjs` | Copies fixtures into `docs/` before a test run and cleans up sidecar files after |
| `tests/fixtures/` | Sample PDFs used by the E2E tests (not user data) |

---

## Getting started

**Requirements:** Python 3.10+, `aiohttp`, a modern Chromium-based browser, and a shared local network. Node.js is only needed for the E2E test suite.

```bash
# install the one Python dependency
python3 -m pip install aiohttp
```

**Start the server:**

```bash
# Linux
chmod +x run_linux.sh && ./run_linux.sh

# macOS
chmod +x run_mac.command && ./run_mac.command

# Windows
run_windows.bat
```

Or directly on any platform: `python3 server.py` (`python server.py` on Windows).

Each launcher script runs `preflight.py` first (checking Python version, `aiohttp`, required files, and port availability) before starting the server. If `aiohttp` is missing, the launcher can auto-install it into a private `.venv`. Running `server.py` directly skips this check.

The server listens on port `8765` and binds to all interfaces, printing detected LAN addresses on startup — typically something like `http://192.168.x.x:8765/`.

**Connect a phone:**

1. Start InkSync on the computer and open the printed LAN address there.
2. Upload a PDF and open the reader interface.
3. Open the generated writer URL on the phone (same LAN, Chrome on Android recommended).

No native app needed — InkSync is built around the mobile browser.

Runs on Linux, Windows, and macOS; the launcher scripts just start the same Python server on each OS.

---

## Security considerations

InkSync is built for trusted local networks, not hostile ones. Currently there is no authentication, no user accounts, no built-in TLS/HTTPS, and no per-document access control — **any device that can reach the server can access and annotate its documents.** Do not expose it to the public internet without adding a security layer in front of it.

---

## Testing

Browser-based E2E tests (via Chrome DevTools Protocol) cover touch gesture classification, one/two-finger drawing and gestures, stylus input, cross-device coordinates, camera sync, stale/ghost annotation detection, and blank-frame regressions during zoom. Requires Node.js and a Chromium/Chrome install; no npm dependencies needed.

---

## Current limitations

- No authentication, TLS/HTTPS, or per-document access control.
- No document library UI (listing/reopening/deleting stored docs).
- Port `8765` is fixed; no env-based configuration yet.
- Erasing is stroke-level, not pixel/segment-level.
- No text or shape annotation tools.
- A stroke stays tied to the page it started on.
- Undo only covers the requesting author's most recent stroke.
- Reader-side touch input is intentionally not used for drawing.

## Roadmap

Document library UI, configurable port, optional auth, HTTPS/TLS, more annotation tools, partial erasing, better session management, multi-document workflows, and a more polished setup experience.

---

## Dependencies

**Runtime:** Python ≥ 3.10, `aiohttp`, and a modern browser (ES modules, Pointer Events, IndexedDB, WebSockets).
**Frontend:** vanilla JS, PDF.js, browser APIs — no build pipeline.
**Testing (optional):** Node.js + Chrome/Chromium.

## Third-party software

InkSync vendors PDF.js (Apache License 2.0) for client-side PDF parsing/rendering — see the bundled distribution for its license terms. InkSync itself does not currently specify a project-wide license.

---

## Contributing

Bug reports and improvements welcome. When touching the viewer or sync system, preserve these invariants:

1. Annotation coordinates stay document/PDF-based, not screen-based.
2. Zoom/pan never change a stroke's actual document location.
3. Normal viewing shouldn't re-download the PDF.
4. Touch gestures keep the one-finger/two-finger model, with intent classified before locking.
5. Performance optimizations must not introduce blank frames or stale annotations.
6. The original PDF stays separate from the annotation layer.


