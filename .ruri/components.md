# Component library

Every piece of this project's interface ruri has on file: the user's own
name for it, its handle, its files, and a picture. When the user names
something here, this is what they mean — go straight to its files rather
than searching for their words. Before building interface, look here
first and reuse what exists: `ruri show <slug>` reads one with its code,
`ruri add <slug>` copies it into place, `ruri help` says the rest.

ruri maintains this file. Don't edit it by hand; it is rewritten whenever
the library changes.

## reader — the reader
Reading screen: the PDF's own pages as a two-page spread (one in a narrow window) with page-turns, trimmed margins, contents with progress rings, top bar and the page bar. Pointer handling and selection live in Book.tsx against each page's text layer (shared/pages.ts); Sheet.tsx draws one page and what's on it.
Its files: web/src/views/reader/Reader.tsx, web/src/views/reader/Book.tsx, web/src/views/reader/Sheet.tsx, web/src/views/reader/Toc.tsx, web/src/views/reader/state.ts, web/src/styles/reader.css
Reaches into: web/src/styles/base.css, web/src/lib/pages.ts, shared/pages.ts
Tags: screen, reading, pdf
Screenshots, newest first (read them if you need to see it): /home/justin06lee/.config/ruri/uploads/e9f450e1-5149-43ca-b2e1-88a387852ca9-shot-36.png, /home/justin06lee/.config/ruri/uploads/1f712ee9-875d-4125-9e39-94aacee394ea-mcp-bridge-blob-1790902337945-syuc0p.png

## selection-toolbar — the selection toolbar
Floats over a selection on the page: five highlight colors, Note, Ask, Explain, Card, and ⋯ for Rewrite, Write it my way, Sketch beside it, Copy (keys H N A C). Same file holds the highlight popover and the menu for a boxed region.
Its files: web/src/views/reader/menus.tsx
Reaches into: web/src/components/ui.tsx, web/src/styles/reader.css
Tags: popover, highlight, reader
Screenshots, newest first (read them if you need to see it): /home/justin06lee/.config/ruri/uploads/85b0f0ee-6ea4-4fd7-b6c0-ec454f778ec9-shot-9.png, /home/justin06lee/.config/ruri/uploads/e39c9290-574a-4ca3-840d-814ecb6a9971-shot-24.png

## study-panel — the study panel
Right-hand panel in the reader with tabs Ask (streaming chat with passage context and the rewrite offer), Notes, Cards, Concepts, Sketch.
Its files: web/src/views/panel/Panel.tsx, web/src/views/panel/Ask.tsx, web/src/views/panel/Notes.tsx, web/src/views/panel/Cards.tsx, web/src/views/panel/Concepts.tsx, web/src/views/panel/SketchTab.tsx, web/src/styles/panel.css
Reaches into: web/src/lib/markdown.ts, web/src/lib/stream.ts
Tags: panel, chat, ai
Screenshot (read it if you need to see it): /home/justin06lee/.config/ruri/uploads/2b61ed97-bd35-4a48-9fef-afdc2c6fffb5-mcp-bridge-blob-1790901534992-naulbt.png
Its code has changed since that picture — if you change it, `ruri edit study-panel --shot <new picture>`

## rewrite-card — the rewrite card
The reader's own versions of passages, laid over the page like pasted slips in the book's type size (tab: show the book's text, edit, rewrite again, remove), and the bench that writes one in place — by hand, or streamed from a model with style chips and Use this / Again.
Its files: web/src/views/reader/Slip.tsx
Tags: ai, editor, reader
Screenshots, newest first (read them if you need to see it): /home/justin06lee/.config/ruri/uploads/0f350e91-729f-4aef-8601-1c50a7a643b4-shot-37.png, /home/justin06lee/.config/ruri/uploads/76037e13-728e-42d3-aa40-8bb0a1d1e675-mcp-bridge-blob-1790901553063-otk4wz.png

## sketch-pad — the sketch pad
Infinite-canvas drawing pad: pressure pen (perfect-freehand), marker, line, arrow, shapes, text, eraser, pan/zoom, undo. initial is read on mount (key it to switch); sketchToSvg makes thumbnails with ink as currentColor.
Its files: web/src/views/sketch/SketchPad.tsx, web/src/views/sketch/render.ts, web/src/styles/sketch.css
Tags: canvas, drawing
Screenshot (read it if you need to see it): /home/justin06lee/.config/ruri/uploads/f26b5524-d5cf-4b68-87fc-ea3c1157b54f-shot-68.png

## review-card — the review card
Flashcard review screen: card with Space to reveal, Again/Hard/Good/Easy showing FSRS's next interval, undo/edit/see-in-book, and a 14-day forecast when caught up.
Its files: web/src/views/review/Review.tsx, web/src/styles/review.css
Tags: flashcards, fsrs, screen
Screenshot (read it if you need to see it): /home/justin06lee/.config/ruri/uploads/5180dee4-eff4-469b-ae80-43736a1c1531-mcp-bridge-blob-1790902136776-zsphf2.png
Its code has changed since that picture — if you change it, `ruri edit review-card --shot <new picture>`

## library-shelf — the library shelf
Library screen: continue-reading hero, grid of book covers with progress and due counts, import progress veils, add-textbook tile.
Its files: web/src/views/library/Library.tsx, web/src/styles/library.css
Tags: screen, library, books
Screenshot (read it if you need to see it): /home/justin06lee/.config/ruri/uploads/49fdce69-cde3-4c98-86e1-db3046342cb3-mcp-bridge-blob-1790902124318-ko7ujn.png
Its code has changed since that picture — if you change it, `ruri edit library-shelf --shot <new picture>`

## knowledge-map — the knowledge map
Force-directed concept graph (canvas, d3-force in a module worker — needs the app:// origin, not file://) colored by knowledge state, with state tiles, study-next list and concept detail beside it. State colors are validated tokens (--m-*).
Its files: web/src/views/map/KnowledgeMap.tsx, web/src/views/map/GraphCanvas.tsx, web/src/views/map/layout.worker.ts, web/src/styles/map.css, web/src/styles/graph.css
Reaches into: web/src/styles/base.css
Tags: graph, canvas, screen, dataviz
Screenshot (read it if you need to see it): /home/justin06lee/.config/ruri/uploads/10d9f52f-a13e-450d-8c20-1244da1a4789-mcp-bridge-blob-1790902831706-m61cv8.png
Its code has changed since that picture — if you change it, `ruri edit knowledge-map --shot <new picture>`

## page-bar — the page bar
Strip under the book: open chapter with "n of m" and Mark read, a scrubber over the whole book (chapter ticks, pages read painted on a canvas, drag to go), and the page number that takes a page to go to.
Its files: web/src/views/reader/PageBar.tsx
Reaches into: web/src/styles/reader.css, web/src/views/reader/Book.tsx
Tags: reader, navigation, progress
Screenshot (read it if you need to see it): /home/justin06lee/.config/ruri/uploads/8a6d4818-d498-4ade-bd70-827cf43a584b-shot-35.png

## view-menu — the view menu
Popover from the open-book button in the reader's top bar: theme, one or two pages, page size (+/−, Fit), trim margins, page-turn, darken pages at night. All of it is Settings, so it persists.
Its files: web/src/views/reader/ViewMenu.tsx
Reaches into: web/src/styles/reader.css, web/src/views/reader/Reader.tsx
Tags: reader, popover, settings
Screenshot (read it if you need to see it): /home/justin06lee/.config/ruri/uploads/7a43eb44-3815-4862-9f40-d3a8e565a585-shot-34.png
