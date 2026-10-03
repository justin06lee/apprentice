<div align="center">

<img src="assets/apprentice.svg" alt="apprentice" width="168" />

# apprentice

**A study desk for textbooks.**<br>
*Drop in a PDF. Read its own pages, open like a book; highlight, note, sketch and ask as you go; remember it with spaced repetition; and watch a map of what you know fill in.*

</div>

---

## What it does

- **The book as printed.** You read the PDF's own pages — every figure, equation and table exactly as typeset — two at a time like an open book (one at a time in a narrow window), turned with a page-turn by arrow keys, the wheel, a swipe or the buttons beside them. Margins are trimmed so the type is as large as the window allows; a scrubber under the book shows the chapters and the pages you've read. Light, sepia and night themes, the pages included.
- **Select right on the page.** Under each page is its text layer, read from the PDF with every character's position, so a selection — or a double-click on a word, a triple-click on a paragraph — lands exactly on the printed glyphs, and can run from the left page onto the right.
- **Highlights and notes**, five colors, on any selection; a notes panel per book, searchable and exportable as Markdown.
- **Ask about any passage — or any figure.** Select text and ask, or box a figure, an equation or a table (the box tool, or Alt-drag) and the model sees it as a picture. It also reads the pages around it, your highlights and notes, and which of the chapter's concepts you know, are learning, or haven't met. Answers render Markdown and LaTeX.
- **Rewrite a passage your way** — by hand, or by asking for it (simpler, with an example, step by step…). After an explanation helped, apprentice offers to fold it into the passage. Your version is laid over the passage like a slip of paper pasted into the book, set in the book's type size; lift it and the book's text is underneath, untouched. Never pushed: it's a menu item and a quiet offer.
- **Draw** in a sketch tab beside the text — pressure-sensitive pen, shapes, arrows, text, an infinite canvas — and pin a sketch beside a passage; it waits in that page's margin.
- **Structure from the PDF.** Behind the pages, the importer reads the book's structure — chapters and sections (from its outline, or its type when it has none), paragraphs, definitions, footnotes, running heads to ignore — for the contents, search, progress, the concepts, and the model's context. It is never what you look at.
- **Flashcards with FSRS.** Cards appear as you read: each definition the book sets in bold becomes a cloze card at import, waiting until you've read its chapter; finishing a chapter has a model write a set that tests understanding. Make your own from any selection (cloze or question, or have a model write it). Reviews are scheduled by FSRS ([ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)) at the recall you choose.
- **A knowledge map** of every concept your books teach and how they relate — co-occurrence from the text, typed relations (prerequisite, part-of, example-of…) from a model — colored by what you know: not met yet, read, learning, known, fading. It tells you what to study next: the central concepts you're least secure on.
- **Progress** per chapter and per book from the pages you've actually had open long enough to read them, reading time, and where you left off.

Everything is local: one SQLite database and a folder per book.

## The model

AI features run through [yagami](../yagami) in library mode: the coding-agent CLIs already signed in on this computer — Claude Code, Codex, Gemini CLI, OpenCode and the rest of the ACP family — with **no API keys**. Pick the model for questions and rewrites, and a (faster) one for background work, in Settings. Without a signed-in CLI everything else still works; the AI features say why they're unavailable.

## Install

```sh
make            # build and package, install to ~/.local (Linux) or /Applications (macOS), launch
make update     # stop the running app, replace it with a fresh build, start it again
```

apprentice's AI features use [yagami](https://github.com/justin06lee/yagami) from a sibling checkout (`../yagami`, a `file:` dependency); clone it next to this repo before `make`.

On Linux that puts the app in `~/.local/opt/apprentice` with a desktop entry and an `apprentice` command (`apprentice book.pdf` adds and opens a book). Ubuntu 23.10+ needs an AppArmor profile for Chromium's sandbox; `make install` writes it (sudo, once — see `scripts/apparmor.sh`).

## Develop

```sh
bun install
bun run dev                          # Vite + esbuild watch + Electron
bun run dev -- --data-dir=/tmp/lib   # with a scratch library
bun run typecheck && bun run test    # APPRENTICE_TEST_PDF=thinkpython2.pdf adds a real-book parse test
bun scripts/parse.ts book.pdf --dump out.md --concepts   # what the importer makes of a PDF
bun scripts/parse.ts book.pdf --pages 61-61 --layer 61   # one page's text layer, as selection sees it
bun run icon                         # redraw the icon (scripts/icon.ts) and every PNG size in build/
```

| | |
|---|---|
| `desktop/ingest/` | the importer: `extract.ts` (MuPDF characters → styled lines), `analyze.ts` (lines → structure), `units.ts` (reading units), `concepts.ts` (terms, mentions, links, first cards), `worker.ts` (one import, one transaction); `pagetext.ts` (a page's text layer and printed area, for the page view) |
| `desktop/` | main process: `library.ts` (books, reading, annotations, search), `srs.ts` (FSRS), `knowledge/graph.ts` (mastery), `ai.ts` (yagami), `render*.ts` (page pictures, text layers, trims, regions — on a worker), `db.ts` (schema) |
| `shared/` | types, the IPC contract (`api.ts`), and `pages.ts`: the text layer's geometry, which main and window must agree on |
| `web/src/` | the window: `views/reader` (`Book.tsx` the spread, turns and pointer; `Sheet.tsx` one page and what's drawn on it; `Slip.tsx` your versions; menus), `views/panel` (ask, notes, cards, concepts, sketch), `views/review`, `views/map`, `views/sketch` |

Data lives in Electron's user-data folder (`~/.config/apprentice` on Linux): `apprentice.db` and `books/<id>/` with the source PDF and caches of rendered pages, page text layers and the book's printed area.

## License

MIT. The PDF engine, [MuPDF](https://mupdf.com), is AGPL-3.0; a build that ships it is distributed under the AGPL.
