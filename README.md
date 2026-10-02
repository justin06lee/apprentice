<div align="center">

<img src="assets/apprentice.svg" alt="apprentice" width="96" />

# apprentice

**A study desk for textbooks.**<br>
*Drop in a PDF. Read it as clean, reflowed text; highlight, note, sketch and ask as you go; remember it with spaced repetition; and watch a map of what you know fill in.*

</div>

---

## What it does

- **Reads the book properly.** A textbook PDF is parsed into structure, not scraped into text: chapters and sections (from the PDF's outline, or from its type when it has none), paragraphs rejoined across lines, columns and page breaks, hyphenation undone where the book itself spells the word whole, code kept as code, footnotes linked to their markers and set under the paragraph that cites them, figures and tables cut from the page with their captions, display mathematics rendered from the page (reflowed math is unreadable), callout boxes kept as boxes, running heads and page numbers dropped. The original pages are always one click away.
- **Highlights and notes**, five colors, on any selection; a notes panel per book, searchable and exportable as Markdown.
- **Ask about any passage.** Select text and ask; the model sees the passage, the chapter around it, your highlights and notes, and which of the chapter's concepts you know, are learning, or haven't met. Answers render Markdown and LaTeX.
- **Rewrite a passage your way** — by hand, or by asking for it (simpler, with an example, step by step…). After an explanation helped, apprentice offers to fold it into the passage. Your version replaces the book's for you, marked in the margin; the book's text is always one click away. Never pushed: it's a passage menu item and a quiet offer.
- **Draw** in a sketch tab beside the text — pressure-sensitive pen, shapes, arrows, text, an infinite canvas — and pin a sketch to a passage.
- **Flashcards with FSRS.** Cards appear as you read: each definition the book sets in bold becomes a cloze card at import, waiting until you've read its chapter; finishing a chapter has a model write a set that tests understanding. Make your own from any selection (cloze or question, or have a model write it). Reviews are scheduled by FSRS ([ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)) at the recall you choose.
- **A knowledge map** of every concept your books teach and how they relate — co-occurrence from the text, typed relations (prerequisite, part-of, example-of…) from a model — colored by what you know: not met yet, read, learning, known, fading. It tells you what to study next: the central concepts you're least secure on.
- **Progress** per chapter and per book from what you've actually had on screen long enough to read, reading time, and where you left off — to the paragraph.

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
```

| | |
|---|---|
| `desktop/ingest/` | the importer: `extract.ts` (MuPDF characters → styled lines), `analyze.ts` (lines → structure), `units.ts` (reading units), `concepts.ts` (terms, mentions, links, first cards), `worker.ts` (one import, one transaction) |
| `desktop/` | main process: `library.ts` (books, reading, search), `srs.ts` (FSRS), `knowledge/graph.ts` (mastery), `ai.ts` (yagami), `render*.ts` (original pages), `db.ts` (schema) |
| `shared/` | types and the IPC contract (`api.ts`) both sides build against |
| `web/src/` | the window: `views/reader` (the column, menus, editor), `views/panel` (ask, notes, cards, concepts, sketch), `views/review`, `views/map`, `views/sketch` |

Data lives in Electron's user-data folder (`~/.config/apprentice` on Linux): `apprentice.db` and `books/<id>/` with the source PDF, cut-out figures, and a cache of rendered pages.

## License

MIT. The PDF engine, [MuPDF](https://mupdf.com), is AGPL-3.0; a build that ships it is distributed under the AGPL.
