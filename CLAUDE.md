# apprentice

Electron desktop app for studying textbook PDFs. Vite + React 19 + zustand renderer, ESM main process bundled with esbuild, SQLite via `node:sqlite` (no native modules), MuPDF (WASM) for PDFs, yagami (`../yagami`, library mode) for models, ts-fsrs for scheduling.

## Layout

- `shared/types.ts`, `shared/api.ts` — the domain and the IPC contract. Main implements `Api`; the window calls it through a proxy (`web/src/api.ts`). Add a call in all three places.
- `desktop/ingest/` — import pipeline, run on a worker thread per book. `analyze.ts` holds every structural heuristic; tune it with `bun scripts/parse.ts <pdf> --dump out.md --concepts` against real books, and keep `desktop/test/parse.test.ts` passing.
- `desktop/` — main process. `db.ts` migrations are append-only (`user_version`).
- `web/src/views/reader/Book.tsx` — the book: the PDF's own pages as a spread (or one page), page turns, and every pointer on the pages (selection, boxes, clicks on highlights); reading is the pages on screen with the reader there. `Sheet.tsx` draws one page and what's on it; `Slip.tsx` the reader's versions.
- `desktop/render-worker.ts` — everything the page view reads from the PDF, off the main thread: pictures, sizes, text layers (`ingest/pagetext.ts`), the printed area for trimming, regions for the model. `render.ts` caches them on disk; bump `TEXT_VERSION` when the text layer changes.
- `web/src/views/sketch/`, `web/src/views/map/GraphCanvas.tsx` — self-contained canvas components (sketch pad, force-directed map with its layout in a worker).
- The icon is generated: `scripts/icon.ts` draws `assets/apprentice.svg` (seeded, so reruns are identical) and `bun run icon` rasterizes it with Electron into `build/icon.png` and `build/icons/`. Edit the script, not the SVG.

## Load-bearing decisions

- The reader sees the PDF's pages, never the parsed text: the parse feeds chapters, search, progress, concepts and the model's context. Don't build a reflowed view back — it was replaced because the reflow looked bad on real books.
- Everything left on a page — highlights, versions, chat anchors — is a `Passage`: a page and offsets into that page's text layer (`shared/pages.ts`: lines joined by `\n`, one x per character). Main and window must agree on the layer, so it is built in one place (`ingest/pagetext.ts`) and measured by pure helpers in `shared/`. Selection is drawn from that geometry, not the DOM; the sheets have no DOM text.
- Reading a page reads every block the import found on it (`library.readPages`), so chapter progress, concept exposure and card unlocking still count blocks.
- Rewrites never replace the book's text: a `versions` row is laid over its passage like a slip, and lifting it is one click. Don't push rewrites — they're a menu item and an offer after an explanation.
- Concept "seen" means its definition or a few mentions have been read; mastery from reading alone is capped (`knowledge/graph.ts`). Recall comes only from FSRS retrievability of reviewed cards.
- Cards from import wait (`pending`) until their chapter is ≥85% read (`UNIT_DONE`).
- Knowledge-state colors (`--m-*` in `base.css`) were validated as a set for color-blind separation; re-run the dataviz validator if you change them.
- MuPDF.js truncates astral code points to 16 bits; `extract.ts` undoes that, and maps Linux Libertine's private-use small caps, ligatures and old-style figures.

## Commands

`bun run dev` (append `-- --data-dir=/tmp/x` for a scratch library), `bun run typecheck`, `bun run test`, `bun run build`, `make` (build + package → install → launch), `make update` (stop → uninstall → build → install → launch). Driving the dev build on Ubuntu needs `--no-sandbox` (no AppArmor profile for node_modules' Electron); the dev script adds it.
