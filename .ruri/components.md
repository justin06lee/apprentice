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
Reading screen: contents with progress rings, the reflowed chapter column (headings, code, math images, footnotes, callouts), top bar. Text lives only inside [data-text] so selection offsets are char counts.
Its files: web/src/views/reader/Reader.tsx, web/src/views/reader/UnitView.tsx, web/src/views/reader/BlockView.tsx, web/src/views/reader/Toc.tsx, web/src/views/reader/state.ts, web/src/styles/reader.css
Reaches into: web/src/styles/base.css, web/src/lib/selection.ts, web/src/lib/text.ts
Tags: screen, reading, typography
Screenshot (read it if you need to see it): /tmp/ruri-ab-all/config/uploads/1f712ee9-875d-4125-9e39-94aacee394ea-mcp-bridge-blob-1790902337945-syuc0p.png

## selection-toolbar — the selection toolbar
Floats over selected text: five highlight colors, Note, Ask, Explain, Card, Copy (keys H N A C). Same file holds the highlight popover, the passage ⋯ menu and the footnote peek.
Its files: web/src/views/reader/menus.tsx
Reaches into: web/src/components/ui.tsx, web/src/styles/reader.css
Tags: popover, highlight, reader
Screenshot (read it if you need to see it): /tmp/ruri-ab-all/config/uploads/e39c9290-574a-4ca3-840d-814ecb6a9971-shot-24.png

## study-panel — the study panel
Right-hand panel in the reader with tabs Ask (streaming chat with passage context and the rewrite offer), Notes, Cards, Concepts, Sketch.
Its files: web/src/views/panel/Panel.tsx, web/src/views/panel/Ask.tsx, web/src/views/panel/Notes.tsx, web/src/views/panel/Cards.tsx, web/src/views/panel/Concepts.tsx, web/src/views/panel/SketchTab.tsx, web/src/styles/panel.css
Reaches into: web/src/lib/markdown.ts, web/src/lib/stream.ts
Tags: panel, chat, ai
Screenshot (read it if you need to see it): /tmp/ruri-ab-all/config/uploads/2b61ed97-bd35-4a48-9fef-afdc2c6fffb5-mcp-bridge-blob-1790901534992-naulbt.png

## rewrite-card — the rewrite card
Streams an AI rewrite of a passage under it, with style chips and Use this / Again; same file has the inline editor for writing your own version. Accepted text goes to custom_text, the book's text stays.
Its files: web/src/views/reader/BlockEditor.tsx
Tags: ai, editor, reader
Screenshot (read it if you need to see it): /tmp/ruri-ab-all/config/uploads/76037e13-728e-42d3-aa40-8bb0a1d1e675-mcp-bridge-blob-1790901553063-otk4wz.png

## sketch-pad — the sketch pad
Infinite-canvas drawing pad: pressure pen (perfect-freehand), marker, line, arrow, shapes, text, eraser, pan/zoom, undo. initial is read on mount (key it to switch); sketchToSvg makes thumbnails with ink as currentColor.
Its files: web/src/views/sketch/SketchPad.tsx, web/src/views/sketch/render.ts, web/src/styles/sketch.css
Tags: canvas, drawing
Screenshot (read it if you need to see it): /tmp/ruri-ab-all/config/uploads/f26b5524-d5cf-4b68-87fc-ea3c1157b54f-shot-68.png

## review-card — the review card
Flashcard review screen: card with Space to reveal, Again/Hard/Good/Easy showing FSRS's next interval, undo/edit/see-in-book, and a 14-day forecast when caught up.
Its files: web/src/views/review/Review.tsx, web/src/styles/review.css
Tags: flashcards, fsrs, screen
Screenshot (read it if you need to see it): /tmp/ruri-ab-all/config/uploads/5180dee4-eff4-469b-ae80-43736a1c1531-mcp-bridge-blob-1790902136776-zsphf2.png

## library-shelf — the library shelf
Library screen: continue-reading hero, grid of book covers with progress and due counts, import progress veils, add-textbook tile.
Its files: web/src/views/library/Library.tsx, web/src/styles/library.css
Tags: screen, library, books
Screenshot (read it if you need to see it): /tmp/ruri-ab-all/config/uploads/49fdce69-cde3-4c98-86e1-db3046342cb3-mcp-bridge-blob-1790902124318-ko7ujn.png

## knowledge-map — the knowledge map
Force-directed concept graph (canvas, d3-force in a module worker — needs the app:// origin, not file://) colored by knowledge state, with state tiles, study-next list and concept detail beside it. State colors are validated tokens (--m-*).
Its files: web/src/views/map/KnowledgeMap.tsx, web/src/views/map/GraphCanvas.tsx, web/src/views/map/layout.worker.ts, web/src/styles/map.css, web/src/styles/graph.css
Reaches into: web/src/styles/base.css
Tags: graph, canvas, screen, dataviz
Screenshot (read it if you need to see it): /tmp/ruri-ab-all/config/uploads/10d9f52f-a13e-450d-8c20-1244da1a4789-mcp-bridge-blob-1790902831706-m61cv8.png
