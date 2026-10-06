# apprentice — Reader

One layer of apprentice's stack, owning `web/src/views/reader/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer reader` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer reader add|set|drop <section> …`. Where it and the code disagree, the code is right.

The reader opens a PDF as a turnable spread, or a single page in a narrow window, with optional margin trimming. Book handles page navigation and pointer selection; Sheet draws the page image and overlays positioned from text-layer geometry. A shared reader store keeps the current book, page, annotations, and tools in sync across the view.

## Where to change what

- **Page layout, turning, selection, and reading progress:** web/src/views/reader/Book.tsx, web/src/views/reader/state.ts
- **Page image and overlays:** web/src/views/reader/Sheet.tsx, web/src/views/reader/Slip.tsx
- **Selection, highlight, and region actions:** web/src/views/reader/menus.tsx, web/src/views/reader/Book.tsx
- **Reader layout and side panel:** web/src/views/reader/Reader.tsx, web/src/views/reader/state.ts
- **Passage rewrites:** web/src/views/reader/Slip.tsx, web/src/views/reader/Sheet.tsx
- **Contents and page navigation:** web/src/views/reader/Toc.tsx, web/src/views/reader/PageBar.tsx, web/src/views/reader/state.ts
- **Search and page marks:** web/src/views/reader/SearchBox.tsx, web/src/views/reader/Sheet.tsx
- **Flashcards from passages:** web/src/views/reader/CardComposer.tsx
- **Theme, page count, zoom, and turn settings:** web/src/views/reader/ViewMenu.tsx

## How it works

- **Open and read:** Reader opens the book through the reader store → Book chooses the visible spread and page scale → Sheet draws each page image and its overlays → Book tracks time spent with visible pages as reading progress
- **Select and annotate:** Book handles a drag across one or two pages → Text-layer geometry resolves a passage, or the drag defines a region → menus offers actions for the selection, highlight, or region → Sheet draws the resulting marks and slips
- **Search within a book:** SearchBox collects a query and displays hits → Opening a hit navigates to its page → Sheet marks matching words on the page

## Key files

- web/src/views/reader/Book.tsx — spread layout, page turns, pointer selection, and reading progress
- web/src/views/reader/state.ts — shared state for the open book, page, annotations, and reader tools
- web/src/views/reader/Sheet.tsx — page image and text-aligned overlays
- web/src/views/reader/Reader.tsx — reader layout, contents, book, and study panel
- web/src/views/reader/menus.tsx — actions for selections, highlights, and boxed regions
- web/src/views/reader/Slip.tsx — passage versions and the rewrite bench
- web/src/views/reader/PageBar.tsx — chapter progress, book scrubber, and page entry
- web/src/views/reader/Toc.tsx — chapters, sections, and page navigation
- web/src/views/reader/SearchBox.tsx — book search, hit navigation, and query terms for marks
- web/src/views/reader/CardComposer.tsx — flashcard drafting from a passage

## Rules and traps

- Keep selection pointer handling in Book so a drag can cross pages; Sheet handles pointers only for slips and pins marked data-ui.
- Position text-based overlays from page text-layer coordinates using the page scale, so they align with the printed glyphs.
- A passage version covers the page text as a slip; it does not change the PDF text.
- Reader state resets when a book opens; Book decides spread layout and page size while other views navigate by page.

## What it talks to

- App shell — Reader uses shared UI, settings, navigation, page-text helpers, and styles.
- Study tools — Reader loads the study panel beside the book and opens card drafting from passages.
- IPC contract — page geometry, annotation types, and API types define reader data.
- Library and storage — API calls load book data, search hits, annotations, and reading progress.
- PDF import and rendering — page images and text layers supply the content and geometry Sheet and Book use.
