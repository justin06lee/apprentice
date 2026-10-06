# apprentice — PDF import and rendering

One layer of apprentice's stack, owning `desktop/ingest/, desktop/render.ts, desktop/render-worker.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer pdf-import` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer pdf-import add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer imports PDFs into book structure and serves the PDF pages used by the reader. MuPDF extraction gathers page data, whole-book analysis identifies sections and regions, and the import worker saves the result in one transaction. A separate render worker draws pages and returns text layers, trim, sizes, and regions; import structure does not determine page appearance.

## Where to change what

- **PDF opening, outline, and drawing:** desktop/ingest/pdf.ts
- **Page text and graphics extraction:** desktop/ingest/extract.ts
- **Chapters, blocks, and page regions:** desktop/ingest/analyze.ts
- **Reading unit boundaries:** desktop/ingest/units.ts
- **Concepts, links, and first cards:** desktop/ingest/concepts.ts
- **Import progress and database save:** desktop/ingest/worker.ts
- **Page text geometry and trim:** desktop/ingest/pagetext.ts, desktop/render-worker.ts
- **Page rendering and cache:** desktop/render.ts, desktop/render-worker.ts

## How it works

- **Import:** desktop/ingest/worker.ts opens the PDF and reads its outline → desktop/ingest/extract.ts reads each page into lines, images, and shapes → desktop/ingest/analyze.ts identifies structure and regions across the whole book → desktop/ingest/units.ts plans reading units → desktop/ingest/concepts.ts finds terms, links, and first cards → desktop/ingest/worker.ts saves the book in one transaction
- **Page request:** desktop/render.ts checks its disk or in-memory cache and sends a worker request → desktop/render-worker.ts opens or reuses the PDF → desktop/ingest/pdf.ts renders a page or region, or desktop/ingest/pagetext.ts builds text and trim data → desktop/render-worker.ts replies to desktop/render.ts

## Key files

- desktop/ingest/worker.ts — runs the import and saves the completed book
- desktop/ingest/analyze.ts — turns whole-book page data into blocks, sections, and regions
- desktop/ingest/extract.ts — extracts styled lines, images, and vector shapes
- desktop/render.ts — coordinates render requests and caches pages and text
- desktop/render-worker.ts — serves page images, sizes, text, trim, and regions
- desktop/ingest/pagetext.ts — builds page text geometry and trim
- desktop/ingest/concepts.ts — finds concepts, mentions, links, and first cards
- desktop/ingest/units.ts — plans chapter-sized reading units
- desktop/ingest/pdf.ts — wraps shared MuPDF opening, outline, and rendering calls

## Rules and traps

- Keep semantic classification in whole-book analysis; extraction only preserves the page data needed for those decisions.
- Preserve the import worker’s single-transaction save so a partially imported book is not stored.
- The reader displays the PDF’s own pages; imported structure supports navigation and study data rather than deciding appearance.
- Bump TEXT_VERSION in desktop/render.ts when text-layer shape or extraction changes so old caches are ignored.

## What it talks to

- IPC contract — page text, trim, regions, and study types use shared contracts
- Desktop bridge — the main process uses desktop/render.ts for page requests and receives import progress
- Library and storage — the import worker writes the completed book to SQLite
- Reader — rendered pages and text geometry support page display and interaction
- Learning services — concept extraction uses term matching from the knowledge service
