# apprentice — architecture

The shape of this project, for a model that has never seen it: where to change what, the stack it is built as, how the parts connect, where things are, how to run it. Where the work stands — git, decisions, what worked and what didn't, what's open — is in catchup.md beside this file.
Don't edit this file: ruri writes it. `ruri architecture` prints it with every line numbered, and once you have read it that way you can put right what your work changed — `ruri architecture add|set|drop <section> …`. The user corrects it on the architecture page.

Apprentice is a desktop study app for learning from textbook PDFs. It combines reading and annotation with AI explanations, personalized rewrites, flashcards, sketches, and a knowledge map.

## Where to change what

- **PDF import and parsing:** desktop/ingest/extract.ts, desktop/ingest/analyze.ts, desktop/ingest/pdf.ts, desktop/ingest/worker.ts
- **Textbook structure and concepts:** desktop/ingest/units.ts, desktop/ingest/concepts.ts, desktop/knowledge/terms.ts, desktop/knowledge/graph.ts
- **Reader text and selection:** web/src/lib/text.ts, web/src/lib/selection.ts, web/src/lib/format.ts, web/src/components/ui.tsx
- **AI questions and rewrites:** desktop/ai.ts, desktop/context.ts, web/src/lib/markdown.ts
- **Library and storage:** desktop/library.ts, desktop/db.ts
- **Flashcard reviews:** desktop/srs.ts
- **PDF rendering:** desktop/render.ts, desktop/render-worker.ts
- **Sketches:** desktop/sketches.ts
- **Desktop IPC:** shared/api.ts, shared/types.ts, desktop/main.ts, desktop/preload.ts
- **Interface state and appearance:** web/src/store.ts, web/src/api.ts, web/src/styles/base.css
- **Build and parsing tools:** scripts/build-main.ts, scripts/parse.ts

## The stack, top to bottom

1. **Desktop interface** — Reader and study controls (`web/src`)
2. **Electron** — Desktop window and typed IPC (`desktop/main.ts, desktop/preload.ts, shared/api.ts`)
3. **Study services** — Import, AI, library, scheduling, and knowledge graph (`desktop`)
4. **Storage and PDF engine** — SQLite with FTS5 and MuPDF (`desktop/db.ts, desktop/ingest`)

## How it flows

- **Import a textbook:** PDF → MuPDF extraction → structure and concept analysis → SQLite library
- **Read and study:** desktop interface → typed IPC → library and study services → saved progress and annotations
- **Ask or rewrite:** selected passage and study context → AI service → explanation or personalized passage
- **Review knowledge:** generated flashcards and concepts → FSRS reviews → knowledge graph

## Where things are

- web/src — desktop interface and client state
- desktop/ingest — PDF extraction and textbook analysis
- desktop/knowledge — concepts and relationship graph
- desktop/db.ts — SQLite storage
- desktop/ai.ts — LLM study features
- desktop/srs.ts — flashcard scheduling
- desktop/main.ts — Electron main process
- desktop/preload.ts — interface bridge
- shared — domain types and IPC contract
- scripts — build and parser utilities

## What it does

- Import textbooks with text, figures, footnotes, and structure
- Read, highlight, annotate, and search across books
- Track reading position and chapter progress
- Ask an LLM questions about passages and study context
- Edit passages or save personalized AI rewrites
- Draw sketches and pin them to passages
- Generate flashcards and schedule reviews with FSRS
- Map concepts, relationships, and what you know
- Navigate with a command palette and customize reading settings
