# apprentice

Electron desktop app for studying textbook PDFs. Vite + React 19 + zustand renderer, ESM main process bundled with esbuild, SQLite via `node:sqlite` (no native modules), MuPDF (WASM) for PDFs, yagami (`../yagami`, library mode) for models, ts-fsrs for scheduling.

## Layout

- `shared/types.ts`, `shared/api.ts` — the domain and the IPC contract. Main implements `Api`; the window calls it through a proxy (`web/src/api.ts`). Add a call in all three places.
- `desktop/ingest/` — import pipeline, run on a worker thread per book. `analyze.ts` holds every structural heuristic; tune it with `bun scripts/parse.ts <pdf> --dump out.md --concepts` against real books, and keep `desktop/test/parse.test.ts` passing.
- `desktop/` — main process. `db.ts` migrations are append-only (`user_version`).
- `web/src/views/reader/UnitView.tsx` — the reading column; pointer handling is delegated from the column, reading is tracked with one IntersectionObserver.
- `web/src/views/sketch/`, `web/src/views/map/GraphCanvas.tsx` — self-contained canvas components (sketch pad, force-directed map with its layout in a worker).
- The icon is generated: `scripts/icon.ts` draws `assets/apprentice.svg` (seeded, so reruns are identical) and `bun run icon` rasterizes it with Electron into `build/icon.png` and `build/icons/`. Edit the script, not the SVG.

## Load-bearing decisions

- A block's text is drawn once, in order, inside its `[data-text]` element and nothing else is: selection offsets are character counts (`web/src/lib/selection.ts`). Typeset math is an atom of `data-len` characters.
- Highlight offsets index the block's *displayed* text: the book's, or the reader's own version run through `shared/inline.ts`'s `plainText`. Main and window must agree, so that parser lives in `shared/`.
- Rewrites never replace the book's text: `custom_text` sits beside `text`, and restoring is always one click. Don't push rewrites — they're a menu item and an offer after an explanation.
- Concept "seen" means its definition or a few mentions have been read; mastery from reading alone is capped (`knowledge/graph.ts`). Recall comes only from FSRS retrievability of reviewed cards.
- Cards from import wait (`pending`) until their chapter is ≥85% read (`UNIT_DONE`).
- Knowledge-state colors (`--m-*` in `base.css`) were validated as a set for color-blind separation; re-run the dataviz validator if you change them.
- MuPDF.js truncates astral code points to 16 bits; `extract.ts` undoes that, and maps Linux Libertine's private-use small caps, ligatures and old-style figures.

## Commands

`bun run dev` (append `-- --data-dir=/tmp/x` for a scratch library), `bun run typecheck`, `bun run test`, `bun run build`, `make` (build + package → install → launch), `make update` (stop → uninstall → build → install → launch). Driving the dev build on Ubuntu needs `--no-sandbox` (no AppArmor profile for node_modules' Electron); the dev script adds it.
