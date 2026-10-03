/**
 * The import worker: one PDF in, one book out. Runs on its own thread so the
 * window never waits on it, and talks to the main process only in progress
 * messages; the book itself goes straight into the database, in a single
 * transaction at the end, so a half-imported book never exists.
 *
 *   extract   every page read once (most of the time goes here)
 *   analyze   structure, regions, paragraphs
 *   concepts  terms, mentions, links, first cards
 *   save      one transaction
 *
 * The book is read on its own pages, so nothing here decides how it looks:
 * the structure found is what chapters, progress, search, concepts and the
 * model's context are made of.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { Mark } from "../../shared/types.js";
import { openDb, tx } from "../db.js";
import { analyze } from "./analyze.js";
import { extractConcepts } from "./concepts.js";
import { Extractor, type XPage } from "./extract.js";
import { meta, openPdf, readOutline, renderPage } from "./pdf.js";
import { blockWeight, planUnits } from "./units.js";

export interface IngestJob {
  bookId: string;
  pdf: string;
  dir: string;
  dbPath: string;
}

export type IngestMessage =
  | { type: "progress"; stage: string; progress: number }
  | { type: "done"; warnings: string[] }
  | { type: "error"; message: string };

const job = workerData as IngestJob;
const post = (m: IngestMessage) => parentPort!.postMessage(m);

/** Most of an import is reading pages; the rest share what is left. */
const STAGES = { extract: [0, 0.8], analyze: [0.8, 0.88], concepts: [0.88, 0.94], save: [0.94, 1] } as const;
let lastPost = 0;
function progress(stage: keyof typeof STAGES, fraction: number, force = false) {
  const now = Date.now();
  if (!force && now - lastPost < 120) return;
  lastPost = now;
  const [a, b] = STAGES[stage];
  post({ type: "progress", stage, progress: a + (b - a) * Math.min(1, fraction) });
}

function run(): string[] {
  const data = fs.readFileSync(job.pdf);
  const doc = openPdf(data);
  const count = doc.countPages();
  const info = meta(doc);
  const outline = readOutline(doc);

  const ex = new Extractor(doc);
  const pages: XPage[] = [];
  for (let i = 0; i < count; i++) {
    pages.push(ex.page(i));
    progress("extract", (i + 1) / count);
  }
  progress("analyze", 0, true);
  const book = analyze(pages, ex.fonts, outline, info);
  const plan = planUnits(book.sections, book.blocks, count);
  const db = openDb(job.dbPath);
  const baseBlock = Number((db.prepare("select coalesce(max(id), 0) as m from blocks").get() as { m: number }).m) + 1;
  const baseSection = Number((db.prepare("select coalesce(max(id), 0) as m from sections").get() as { m: number }).m) + 1;
  const blockId = (i: number) => baseBlock + i;
  const sectionId = (i: number) => baseSection + i;

  try {
    const first = doc.loadPage(0);
    const [x0, , x1] = first.getBounds();
    const cover = renderPage(first, 480 / Math.max(1, x1 - x0));
    fs.writeFileSync(path.join(job.dir, "cover.jpg"), cover.data);
    first.destroy();
  } catch {
    // no cover; the library draws a typeset one
  }

  progress("concepts", 0, true);
  const sectionOf = plan.blockSection;
  const unitIndexOf = sectionOf.map((s) => plan.sections[s]!.unit);
  const kinds = sectionOf.map((s) => plan.sections[s]!.kind);
  const found = extractConcepts(book.blocks, kinds, unitIndexOf);
  progress("save", 0, true);

  const footnoteIds = new Map<string, number>();
  book.blocks.forEach((b, i) => {
    if (b.fnKey) footnoteIds.set(b.fnKey, blockId(i));
  });

  const weights = book.blocks.map((b) => blockWeight(b.type, b.text));
  const unitWeight = new Map<number, number>();
  book.blocks.forEach((_, i) => {
    const u = unitIndexOf[i]!;
    unitWeight.set(u, (unitWeight.get(u) ?? 0) + weights[i]!);
  });
  const readable = (k: string) => k === "body" || k === "exercises";
  let bookWeight = 0;
  for (const [u, w] of unitWeight) if (readable(plan.sections[u]!.kind)) bookWeight += w;

  const now = Date.now();
  tx(db, () => {
    const insSection = db.prepare(
      `insert into sections (id, book_id, parent_id, ord, level, title, page, block_id, kind, is_unit, unit_id, weight)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    plan.sections.forEach((s, i) => {
      insSection.run(
        sectionId(i),
        job.bookId,
        s.parent === null ? null : sectionId(s.parent),
        i,
        s.level,
        s.title.slice(0, 300),
        s.page,
        s.blockIndex >= 0 && book.blocks[s.blockIndex]?.type === "heading" ? blockId(s.blockIndex) : null,
        s.kind,
        s.isUnit ? 1 : 0,
        sectionId(s.unit),
        s.isUnit ? (unitWeight.get(i) ?? 0) : 0,
      );
    });

    const insBlock = db.prepare(
      `insert into blocks (id, book_id, unit_id, section_id, ord, type, level, text, marks, page, bbox, asset, width, height, boxed, label, refs, weight)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    book.blocks.forEach((b, i) => {
      const refs: Mark[] = (b.refs ?? []).flatMap((r) => {
        const id = footnoteIds.get(r.key);
        return id ? [{ s: r.s, e: r.e, f: 8, ref: id }] : [];
      });
      insBlock.run(
        blockId(i),
        job.bookId,
        sectionId(unitIndexOf[i]!),
        sectionId(sectionOf[i]!),
        i,
        b.type,
        b.level,
        b.text,
        b.marks.length ? JSON.stringify(b.marks) : null,
        b.page,
        b.bbox ? JSON.stringify(b.bbox.map((v) => Math.round(v * 10) / 10)) : null,
        null,
        0,
        0,
        b.boxed,
        b.label,
        refs.length ? JSON.stringify(refs) : null,
        weights[i]!,
      );
    });

    // Concepts are shared across books by key.
    const insConcept = db.prepare("insert into concepts (key, name, created_at) values (?, ?, ?) on conflict(key) do nothing");
    const conceptId = db.prepare("select id from concepts where key = ?");
    const insCB = db.prepare(
      `insert into concept_books (concept_id, book_id, importance, def_block_id, definition, source) values (?, ?, ?, ?, ?, 'auto')
       on conflict(concept_id, book_id) do update set importance = excluded.importance`,
    );
    const insMention = db.prepare(
      "insert into mentions (concept_id, block_id, book_id, unit_id, count, is_def) values (?, ?, ?, ?, ?, ?) on conflict do nothing",
    );
    const ids = new Map<string, number>();
    for (const c of found.concepts) {
      insConcept.run(c.key, c.name, now);
      const id = Number((conceptId.get(c.key) as { id: number }).id);
      ids.set(c.key, id);
      insCB.run(id, job.bookId, c.importance, c.defBlock === null ? null : blockId(c.defBlock), c.definition);
      for (const [b, n] of c.mentions) insMention.run(id, blockId(b), job.bookId, sectionId(unitIndexOf[b]!), n, b === c.defBlock ? 1 : 0);
    }
    const insEdge = db.prepare(
      "insert into edges (a, b, book_id, weight, kind, label) values (?, ?, ?, ?, 'cooccur', null) on conflict do update set weight = excluded.weight",
    );
    for (const e of found.edges) {
      const a = ids.get(e.a);
      const b = ids.get(e.b);
      if (a === undefined || b === undefined || a === b) continue;
      insEdge.run(Math.min(a, b), Math.max(a, b), job.bookId, e.weight);
    }
    const insCard = db.prepare(
      `insert into cards (book_id, block_id, unit_id, page, kind, front, back, source, status, due, created_at)
       values (?, ?, ?, ?, ?, ?, ?, 'auto', 'pending', ?, ?)`,
    );
    const insCardConcept = db.prepare("insert into card_concepts (card_id, concept_id) values (?, ?) on conflict do nothing");
    for (const c of found.cards) {
      const r = insCard.run(job.bookId, blockId(c.block), sectionId(unitIndexOf[c.block]!), book.blocks[c.block]!.page, c.kind, c.front, c.back, now, now);
      for (const key of c.concepts) {
        const id = ids.get(key);
        if (id !== undefined) insCardConcept.run(Number(r.lastInsertRowid), id);
      }
    }

    db.prepare(
      `update books set title = coalesce(?, title), author = ?, page_count = ?, body_size = ?, weight = ?, warnings = ?,
         has_cover = ?, status = 'ready', import_progress = 1, import_stage = null, error = null where id = ?`,
    ).run(
      book.title,
      book.author,
      count,
      book.bodySize,
      bookWeight,
      book.warnings.length ? JSON.stringify(book.warnings) : null,
      fs.existsSync(path.join(job.dir, "cover.jpg")) ? 1 : 0,
      job.bookId,
    );
  });
  db.close();
  return book.warnings;
}

try {
  const warnings = run();
  post({ type: "done", warnings });
} catch (error) {
  post({ type: "error", message: error instanceof Error ? error.message : String(error) });
}
