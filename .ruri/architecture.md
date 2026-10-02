# apprentice — architecture

The shape of this project, for a model that has never seen it: the stack it is built as, top to bottom, how the parts connect, where things are, how to run it. This is the index. Each layer has a sheet of its own in `.ruri/layers/` — where to change what inside it, how it works, its key files, its traps — so read the one for the layer you are about to work in (`ruri layer <slug>` prints it), and leave the rest. Where the work stands — git, decisions, what worked and what didn't, what's open — is in catchup.md beside this file.
Don't edit this file: ruri writes it. `ruri architecture` prints it with every line numbered, and once you have read it that way you can put right what your work changed — `ruri architecture add|set|drop <section> …`. The user corrects it on the architecture page.

Read from the repo at 95fe0bd; folded forward from finished turns since. Where it and the code disagree, the code is right.

Apprentice is a desktop study app for people learning from textbook PDFs. It combines reflowed reading and annotation with AI explanations, personalized rewrites, flashcards, sketches, and a knowledge map.

## The stack, top to bottom

1. **App shell** — React 19, zustand, and Vite provide navigation, library, settings, shared UI, and window state. (`web/, web/src/, web/src/components/ +6 · 7 files`) → `.ruri/layers/app-shell.md`
2. **Reader** — React views display chapters and original pages, handle selections, notes, passage edits, search, and reading progress. (`web/src/views/reader/`)
3. **Study tools** — React panels provide questions, notes, cards, concepts, and reviews; Markdown and KaTeX render answers. (`web/src/views/panel/, web/src/views/review/`)
4. **Visual canvases** — Canvas views draw sketches and a force-directed knowledge map with worker-based layout. (`web/src/views/sketch/, web/src/views/map/`)
5. **IPC contract** — Shared TypeScript types, inline-text parsing, and the Api contract connect the renderer and main process. (`shared/`)
6. **Desktop bridge** — Electron main and preload expose the API and connect the window to desktop services. (`desktop/ · 2 files`) → `.ruri/layers/desktop-bridge.md`
7. **PDF import and rendering** — MuPDF extraction, structural analysis, import workers, and page rendering turn PDFs into readable books and assets. (`desktop/ingest/, desktop/ · 2 files`)
8. **Library and storage** — SQLite stores books and study data; library services handle reading and search, with files kept per book. (`desktop/ · 3 files`)
9. **Learning services** — ts-fsrs schedules card reviews; concept services calculate knowledge and mastery. (`desktop/, desktop/knowledge/ · 1 file`)
10. **AI services** — Yagami uses signed-in coding-agent CLIs for questions, rewrites, and background model work. (`desktop/ · 2 files`)
11. **Build and tooling** — Bun scripts, esbuild, Vite, electron-builder, and Make build, test, package, install, and inspect imports. (`scripts/, ./, desktop/test/ · 4 files`) → `.ruri/layers/build-tooling.md`
12. **Desktop runtime** — Electron runs the app on macOS and Linux; MuPDF runs as WASM and SQLite uses node:sqlite.

## How it flows

- **Import a textbook:** Library (web/src/views/library/Library.tsx) → IPC proxy (web/src/api.ts) → Electron bridge (desktop/preload.ts) → Import worker (desktop/ingest/worker.ts) → MuPDF extraction and structure (desktop/ingest/extract.ts, desktop/ingest/analyze.ts) → SQLite and book files (desktop/db.ts)
- **Read and annotate:** Reader (web/src/views/reader/Reader.tsx) → Reading column and selection (web/src/views/reader/UnitView.tsx) → IPC proxy (web/src/api.ts) → Library service (desktop/library.ts) → SQLite (desktop/db.ts)
- **Ask about a passage:** Ask panel (web/src/views/panel/Ask.tsx) → IPC proxy (web/src/api.ts) → Study context (desktop/context.ts) → Yagami integration (desktop/ai.ts) → Signed-in coding-agent CLI
- **Review and update knowledge:** Review view (web/src/views/review/Review.tsx) → IPC proxy (web/src/api.ts) → FSRS scheduling (desktop/srs.ts) → Knowledge graph (desktop/knowledge/graph.ts) → SQLite (desktop/db.ts) → Knowledge map (web/src/views/map/KnowledgeMap.tsx)

## Where things are

- desktop/ — Electron main process, storage, AI, rendering, and learning services
- desktop/ingest/ — PDF extraction, structure, concepts, and import worker
- desktop/knowledge/ — concept terms and mastery graph
- desktop/test/ — desktop tests, including PDF parsing
- shared/ — domain types, inline-text parser, and IPC contract
- web/src/views/reader/ — reading column, selection tools, search, and page view
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
- bun scripts/parse.ts book.pdf --dump out.md --concepts — inspect a PDF import
- bun run build — build the web and main processes
- make — build, package, install, and launch
- make update — replace and relaunch the installed app

## Conventions

- Use Bun for installation, scripts, and tests; yagami is a sibling file dependency at ../yagami.
- Add API calls in shared/api.ts, the desktop implementation, and web/src/api.ts.
- Keep SQLite user_version migrations append-only.
- Tune import heuristics against real books with scripts/parse.ts and keep desktop/test/parse.test.ts passing.
- Keep selectable block text solely in its data-text element; selection offsets count displayed characters.
- Keep the book text beside custom_text, and offer rewrites without pushing them.
- Cap mastery earned from reading alone; reviewed-card recall comes from FSRS retrievability.
- Re-run the dataviz validator if knowledge-state colors change.

## What it does

- Import textbooks with chapters, figures, footnotes, mathematics, and structure
- Read reflowed text or inspect the original PDF pages
- Highlight, annotate, and search within or across books
- Track reading position, time, and chapter progress
- Ask an LLM questions using passages and study context
- Edit passages or save personalized AI rewrites
- Draw sketches and pin them to passages
- Generate flashcards and schedule reviews with FSRS
- Map concepts, relationships, and what you know
- Navigate with a command palette and customize reading settings
