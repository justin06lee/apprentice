# apprentice — architecture

The shape of this project, for a model that has never seen it: the stack it is built as, top to bottom, how the parts connect, where things are, how to run it. This is the index. Each layer has a sheet of its own in `.ruri/layers/` — where to change what inside it, how it works, its key files, its traps — so read the one for the layer you are about to work in (`ruri layer <slug>` prints it), and leave the rest. Where the work stands — git, decisions, what worked and what didn't, what's open — is in catchup.md beside this file.
Don't edit this file: ruri writes it. `ruri architecture` prints it with every line numbered, and once you have read it that way you can put right what your work changed — `ruri architecture add|set|drop <section> …`. The user corrects it on the architecture page.

Read from the repo at 95fe0bd; folded forward from finished turns since. Where it and the code disagree, the code is right.

Apprentice is a desktop study app for people learning from textbook PDFs. It opens a book's own pages as a spread you turn like paper, and adds highlights, AI explanations of passages and boxed figures, personal rewrites laid over the page like slips, flashcards, sketches, and a knowledge map.

## The stack, top to bottom

1. **App shell** — React 19, zustand, and Vite provide navigation, library, settings, shared UI, and window state. (`web/, web/src/, web/src/components/ +6 · 7 files`) → `.ruri/layers/app-shell.md`
2. **Reader** — React views show the PDF's pages as a turnable spread with trimmed margins; selection, highlights, slips, search marks and reading progress are drawn from each page's text layer. (`web/src/views/reader/`)
3. **Study tools** — React panels provide questions, notes, cards, concepts, and reviews; Markdown and KaTeX render answers. (`web/src/views/panel/, web/src/views/review/`)
4. **Visual canvases** — Canvas views draw sketches and a force-directed knowledge map with worker-based layout. (`web/src/views/sketch/, web/src/views/map/`)
5. **IPC contract** — Shared TypeScript types, the page text-layer geometry (shared/pages.ts), and the Api contract connect the renderer and main process. (`shared/`)
6. **Desktop bridge** — Electron main and preload expose the API and connect the window to desktop services. (`desktop/ · 2 files`) → `.ruri/layers/desktop-bridge.md`
7. **PDF import and rendering** — MuPDF extraction, structural analysis and import workers turn PDFs into chapters and concepts; a render worker draws pages and serves text layers, printed areas and regions. (`desktop/ingest/, desktop/ · 2 files`)
8. **Library and storage** — SQLite stores books and study data; library services handle reading and search, with files kept per book. (`desktop/ · 3 files`)
9. **Learning services** — ts-fsrs schedules card reviews; concept services calculate knowledge and mastery. (`desktop/, desktop/knowledge/ · 1 file`)
10. **AI services** — Yagami uses signed-in coding-agent CLIs for questions, rewrites, and background model work. (`desktop/ · 2 files`)
11. **Build and tooling** — Bun scripts, esbuild, Vite, electron-builder, and Make build, test, package, install, and inspect imports. (`scripts/, ./, desktop/test/ · 4 files`) → `.ruri/layers/build-tooling.md`
12. **Desktop runtime** — Electron runs the app on macOS and Linux; MuPDF runs as WASM and SQLite uses node:sqlite.

## How it flows

- **Import a textbook:** Library (web/src/views/library/Library.tsx) → IPC proxy (web/src/api.ts) → Electron bridge (desktop/preload.ts) → Import worker (desktop/ingest/worker.ts) → MuPDF extraction and structure (desktop/ingest/extract.ts, desktop/ingest/analyze.ts) → SQLite and book files (desktop/db.ts)
- **Read and annotate:** Reader (web/src/views/reader/Reader.tsx) → Book view and selection (web/src/views/reader/Book.tsx) → Page sheets and slips (web/src/views/reader/Sheet.tsx, web/src/views/reader/Slip.tsx) → IPC proxy (web/src/api.ts) → Library service (desktop/library.ts) → SQLite (desktop/db.ts)
- **Ask about a passage or region:** Ask panel (web/src/views/panel/Ask.tsx) → IPC proxy (web/src/api.ts) → Pages around it and a picture of a boxed region (desktop/render.ts) → Yagami integration (desktop/ai.ts) → Signed-in coding-agent CLI
- **Review and update knowledge:** Review view (web/src/views/review/Review.tsx) → IPC proxy (web/src/api.ts) → FSRS scheduling (desktop/srs.ts) → Knowledge graph (desktop/knowledge/graph.ts) → SQLite (desktop/db.ts) → Knowledge map (web/src/views/map/KnowledgeMap.tsx)
- **Show a page:** Book view (web/src/views/reader/Book.tsx) → apprentice:// pages and reader.pageText (desktop/main.ts) → Page renderer and caches (desktop/render.ts) → Render worker (desktop/render-worker.ts) → Text layer and printed area (desktop/ingest/pagetext.ts)

## Where things are

- desktop/ — Electron main process, storage, AI, rendering, and learning services
- desktop/ingest/ — PDF extraction, structure, concepts, and import worker
- desktop/knowledge/ — concept terms and mastery graph
- desktop/test/ — desktop tests, including PDF parsing
- shared/ — domain types, page text-layer geometry, and IPC contract
- web/src/views/reader/ — the book view: spread and page turns, page sheets, slips, menus, page bar, view menu, search, contents
- web/src/views/panel/ — ask, notes, cards, concepts, and sketch tabs
- web/src/views/review/ — flashcard review
- web/src/views/map/ — knowledge map and layout worker
- web/src/views/sketch/ — drawing canvas and rendering
- web/src/ — app shell, store, API proxy, components, and styles
- scripts/ — development, builds, icon generation, and PDF inspection
- assets/ — generated app icon SVG
- build/ — packaged app icons and platform icon sizes
- Makefile — packaging, installation, updates, and launch
- CLAUDE.md — project architecture and implementation rules

## How to run it

- bun install — install dependencies
- bun run dev — run Vite, esbuild watch, and Electron
- bun run dev -- --data-dir=/tmp/lib — develop with a scratch library
- bun run typecheck && bun run test — check types and run desktop tests
- bun scripts/parse.ts book.pdf --dump out.md --concepts — inspect a PDF import (--layer N prints a page's text layer)
- bun run build — build the web and main processes
- make — build, package, install, and launch
- make update — replace and relaunch the installed app

## Conventions

- Use Bun for installation, scripts, and tests; yagami is a sibling file dependency at ../yagami.
- Add API calls in shared/api.ts, the desktop implementation, and web/src/api.ts.
- Keep SQLite user_version migrations append-only.
- Tune import heuristics against real books with scripts/parse.ts and keep desktop/test/parse.test.ts passing.
- Anchor anything on a page as a Passage: a page and offsets into its text layer (shared/pages.ts); selection is drawn from that geometry, never the DOM.
- Lay the reader's versions over the book's text, never change it, and offer rewrites without pushing them.
- Cap mastery earned from reading alone; reviewed-card recall comes from FSRS retrievability.
- Re-run the dataviz validator if knowledge-state colors change.
- Show the PDF's own pages; the parsed structure feeds chapters, search, progress, concepts and model context, never the view.

## What it does

- Import textbooks and learn their chapters, sections, definitions and concepts
- Read the PDF's own pages as a two-page spread, turned like paper, with trimmed margins and night pages
- Highlight, annotate, and search within or across books
- Track reading position, time, and chapter progress
- Ask an LLM about passages or boxed figures, with the surrounding pages and study context
- Write or AI-rewrite passages as slips laid over the page
- Draw sketches and pin them to pages
- Generate flashcards and schedule reviews with FSRS
- Map concepts, relationships, and what you know
- Navigate with a command palette, a page scrubber, and page and theme settings
