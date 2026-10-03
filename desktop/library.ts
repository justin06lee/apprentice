/**
 * The library: books, how they get in, and reading them.
 *
 * Imports run one at a time on a worker thread (see ingest/worker.ts). A
 * book exists in the table from the moment it is dropped in, in state
 * "importing", so the library can show it filling in; an import that a quit
 * interrupted simply runs again at the next launch.
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { HighlightRow, ReadResult } from "../shared/api.js";
import { locate, rangeBox, type PageText, type Rect } from "../shared/pages.js";
import type {
  Annotations,
  Book,
  Highlight,
  HighlightColor,
  OpenedBook,
  ReadingPosition,
  SearchHit,
  Section,
  SectionKind,
  Version,
} from "../shared/types.js";
import { bookDir, today, type Ctx } from "./context.js";
import { tx, type Db } from "./db.js";
import type { IngestJob, IngestMessage } from "./ingest/worker.js";

/** Read this much of a chapter and it counts as read: its cards unlock, its AI jobs run. */
export const UNIT_DONE = 0.85;

interface BookRow {
  id: string;
  title: string;
  author: string | null;
  file_name: string;
  page_count: number;
  status: string;
  import_progress: number;
  import_stage: string | null;
  error: string | null;
  added_at: number;
  opened_at: number | null;
  has_cover: number;
  weight: number;
  position: string | null;
  read_weight: number;
  due: number;
  total_cards: number;
  concepts: number;
  units: number;
  time_ms: number;
}

export function highlightFromRow(r: Record<string, unknown>): Highlight {
  return {
    id: Number(r["id"]),
    bookId: String(r["book_id"]),
    page: Number(r["page"]),
    start: Number(r["start"]),
    end: Number(r["end"]),
    quote: String(r["quote"]),
    blockId: r["block_id"] === null || Number(r["block_id"]) <= 0 ? null : Number(r["block_id"]),
    unitId: r["unit_id"] === null || Number(r["unit_id"]) <= 0 ? null : Number(r["unit_id"]),
    color: String(r["color"]) as HighlightColor,
    note: String(r["note"] ?? ""),
    createdAt: Number(r["created_at"]),
    updatedAt: Number(r["updated_at"]),
  };
}

function versionFromRow(r: Record<string, unknown>): Version {
  return {
    id: Number(r["id"]),
    bookId: String(r["book_id"]),
    page: Number(r["page"]),
    start: Number(r["start"]),
    end: Number(r["end"]),
    quote: String(r["quote"]),
    text: String(r["text"]),
    source: String(r["source"]) === "ai" ? "ai" : "user",
    createdAt: Number(r["created_at"]),
    updatedAt: Number(r["updated_at"]),
  };
}

/** The chapter a page belongs to: the one most of its blocks are in, or the last to start before it. */
export function unitAt(db: Db, bookId: string, page: number): number | null {
  const byBlocks = db
    .prepare("select unit_id from blocks where book_id = ? and page = ? group by unit_id order by sum(weight) desc limit 1")
    .get(bookId, page) as { unit_id: number } | undefined;
  if (byBlocks) return Number(byBlocks.unit_id);
  const before = db
    .prepare("select id from sections where book_id = ? and is_unit = 1 and page <= ? order by page desc, ord desc limit 1")
    .get(bookId, page) as { id: number } | undefined;
  return before ? Number(before.id) : null;
}

const BOOK_SELECT = `
  select b.*,
    (select coalesce(sum(bl.weight), 0) from reads r join blocks bl on bl.id = r.block_id
       join sections u on u.id = bl.unit_id where r.book_id = b.id and u.kind in ('body', 'exercises')) as read_weight,
    (select count(*) from cards c where c.book_id = b.id and c.status = 'active' and c.due <= ?) as due,
    (select count(*) from cards c where c.book_id = b.id) as total_cards,
    (select count(*) from concept_books cb where cb.book_id = b.id) as concepts,
    (select count(*) from sections s where s.book_id = b.id and s.is_unit = 1) as units,
    (select coalesce(sum(ms), 0) from reading_time t where t.book_id = b.id) as time_ms
  from books b`;

function newId(): string {
  return Date.now().toString(36).slice(-6) + randomBytes(3).toString("hex");
}

export class Library {
  private queue: string[] = [];
  private running: { bookId: string; worker: Worker } | null = null;
  /** Import progress lives here between the worker's messages and the next DB write. */
  private live = new Map<string, { progress: number; stage: string }>();

  constructor(
    private readonly ctx: Ctx,
    private readonly workerPath: string,
    private readonly onUnitRead: (bookId: string, unitId: number) => void,
  ) {}

  // ── books ──────────────────────────────────────────────────────────────

  private toBook(r: BookRow): Book {
    const live = this.live.get(r.id);
    return {
      id: r.id,
      title: r.title,
      author: r.author,
      pageCount: Number(r.page_count),
      status: r.status as Book["status"],
      importProgress: live?.progress ?? Number(r.import_progress),
      importStage: live?.stage ?? r.import_stage,
      error: r.error,
      addedAt: Number(r.added_at),
      openedAt: r.opened_at === null ? null : Number(r.opened_at),
      cover: Number(r.has_cover) ? `apprentice://book/${r.id}/cover.jpg?v=${r.added_at}` : null,
      readFraction: r.weight ? Math.min(1, Number(r.read_weight) / Number(r.weight)) : 0,
      dueCards: Number(r.due),
      totalCards: Number(r.total_cards),
      conceptCount: Number(r.concepts),
      unitCount: Number(r.units),
      timeMs: Number(r.time_ms),
    };
  }

  list(): Book[] {
    const rows = this.ctx.db
      .prepare(`${BOOK_SELECT} order by coalesce(b.opened_at, b.added_at) desc`)
      .all(Date.now()) as unknown as BookRow[];
    return rows.map((r) => this.toBook(r));
  }

  book(id: string): Book {
    const r = this.ctx.db.prepare(`${BOOK_SELECT} where b.id = ?`).get(Date.now(), id) as BookRow | undefined;
    if (!r) throw new Error("That book is no longer in the library.");
    return this.toBook(r);
  }

  private changed(id: string): void {
    try {
      this.ctx.emit("books.changed", this.book(id));
    } catch {
      // removed meanwhile
    }
  }

  // ── import ─────────────────────────────────────────────────────────────

  importFiles(paths: string[]): string[] {
    const ids: string[] = [];
    for (const file of paths) {
      if (!/\.pdf$/i.test(file)) continue;
      const data = fs.readFileSync(file);
      const hash = createHash("sha256").update(data).digest("hex");
      const existing = this.ctx.db.prepare("select id, status from books where file_hash = ?").get(hash) as
        | { id: string; status: string }
        | undefined;
      if (existing) {
        if (existing.status === "error") this.retry(existing.id);
        ids.push(existing.id);
        continue;
      }
      const id = newId();
      const dir = bookDir(this.ctx, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "source.pdf"), data);
      const title = path
        .basename(file)
        .replace(/\.pdf$/i, "")
        .replace(/[_]+/g, " ")
        .trim();
      this.ctx.db
        .prepare("insert into books (id, title, file_name, file_hash, status, added_at) values (?, ?, ?, ?, 'importing', ?)")
        .run(id, title, path.basename(file), hash, Date.now());
      ids.push(id);
      this.enqueue(id);
      this.changed(id);
    }
    return ids;
  }

  /** Imports a quit interrupted. */
  resume(): void {
    const rows = this.ctx.db.prepare("select id from books where status = 'importing' order by added_at").all() as Array<{ id: string }>;
    for (const r of rows) this.enqueue(r.id);
  }

  retry(bookId: string): void {
    this.clearContent(bookId);
    this.ctx.db.prepare("update books set status = 'importing', error = null, import_progress = 0 where id = ?").run(bookId);
    this.enqueue(bookId);
    this.changed(bookId);
  }

  private enqueue(bookId: string): void {
    if (this.queue.includes(bookId) || this.running?.bookId === bookId) return;
    this.queue.push(bookId);
    this.next();
  }

  private next(): void {
    if (this.running) return;
    const bookId = this.queue.shift();
    if (!bookId) return;
    const dir = bookDir(this.ctx, bookId);
    // A previous attempt may have left half its rows; start clean.
    this.clearContent(bookId);
    const job: IngestJob = { bookId, pdf: path.join(dir, "source.pdf"), dir, dbPath: this.ctx.dbPath };
    const worker = new Worker(this.workerPath, { workerData: job, resourceLimits: { maxOldGenerationSizeMb: 3072 } });
    this.running = { bookId, worker };
    let settled = false;
    let lastWrite = 0;
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      this.live.delete(bookId);
      if (error) {
        this.ctx.db.prepare("update books set status = 'error', error = ?, import_stage = null where id = ?").run(error, bookId);
      }
      this.running = null;
      void worker.terminate();
      this.changed(bookId);
      this.next();
    };
    worker.on("message", (m: IngestMessage) => {
      if (m.type === "progress") {
        this.live.set(bookId, { progress: m.progress, stage: m.stage });
        if (Date.now() - lastWrite > 1500) {
          lastWrite = Date.now();
          this.ctx.db.prepare("update books set import_progress = ?, import_stage = ? where id = ?").run(m.progress, m.stage, bookId);
        }
        this.changed(bookId);
      } else if (m.type === "done") finish(null);
      else finish(m.message);
    });
    worker.on("error", (e: Error) => finish(e.message));
    worker.on("exit", (code) => {
      if (!settled) finish(code === 0 ? null : "The importer stopped unexpectedly. Try importing this book again.");
    });
  }

  private clearContent(bookId: string): void {
    tx(this.ctx.db, () => {
      // Highlights, versions and page reads stay: they belong to pages, and the pages have not changed.
      for (const table of ["blocks", "sections", "mentions", "edges", "concept_books", "cards", "reads"])
        this.ctx.db.prepare(`delete from ${table} where book_id = ?`).run(bookId);
    });
  }

  remove(bookId: string): void {
    if (this.running?.bookId === bookId) {
      void this.running.worker.terminate();
      this.running = null;
    }
    this.queue = this.queue.filter((id) => id !== bookId);
    tx(this.ctx.db, () => {
      this.ctx.db.prepare("delete from books where id = ?").run(bookId);
      // Concepts no book mentions any more.
      this.ctx.db.prepare("delete from concepts where id not in (select concept_id from concept_books)").run();
    });
    fs.rmSync(bookDir(this.ctx, bookId), { recursive: true, force: true });
    this.ctx.emit("books.removed", { id: bookId });
    this.next();
  }

  rename(bookId: string, title: string): void {
    const t = title.trim();
    if (!t) return;
    this.ctx.db.prepare("update books set title = ? where id = ?").run(t.slice(0, 300), bookId);
    this.changed(bookId);
  }

  sourcePath(bookId: string): string {
    return path.join(bookDir(this.ctx, bookId), "source.pdf");
  }

  // ── reading ────────────────────────────────────────────────────────────

  sections(bookId: string): Section[] {
    const rows = this.ctx.db
      .prepare(
        `select s.*, case when s.is_unit = 1 then
           (select coalesce(sum(b.weight), 0) from reads r join blocks b on b.id = r.block_id where r.unit_id = s.id)
           else 0 end as read_weight
         from sections s where s.book_id = ? order by s.ord`,
      )
      .all(bookId) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const weight = Number(r["weight"]);
      const read = Number(r["read_weight"]);
      return {
        id: Number(r["id"]),
        parentId: r["parent_id"] === null ? null : Number(r["parent_id"]),
        unitId: Number(r["unit_id"]),
        level: Number(r["level"]),
        title: String(r["title"]),
        page: Number(r["page"]),
        blockId: r["block_id"] === null ? null : Number(r["block_id"]),
        kind: String(r["kind"]) as SectionKind,
        isUnit: Number(r["is_unit"]) === 1,
        readFraction: weight ? Math.min(1, read / weight) : 0,
        weight,
      };
    });
  }

  async open(bookId: string): Promise<OpenedBook> {
    this.ctx.db.prepare("update books set opened_at = ? where id = ?").run(Date.now(), bookId);
    const book = this.book(bookId);
    if (book.status !== "ready") throw new Error("This book is still being imported.");
    const raw = (this.ctx.db.prepare("select position from books where id = ?").get(bookId) as { position: string | null }).position;
    let position: ReadingPosition | null = null;
    try {
      const p = raw ? (JSON.parse(raw) as { page?: number; unitId?: number; blockId?: number | null }) : null;
      if (typeof p?.page === "number") position = { page: p.page };
      else if (p?.blockId) position = this.pageOfBlock(p.blockId);
      else if (p?.unitId) {
        // Saved by the reflowed reader: the chapter it was in.
        const u = this.ctx.db.prepare("select page from sections where id = ?").get(p.unitId) as { page: number } | undefined;
        position = u ? { page: Number(u.page) } : null;
      }
    } catch {
      position = null;
    }
    // Figures cut out for the reflowed reader, from before the book was read on its pages.
    void fs.promises.rm(path.join(bookDir(this.ctx, bookId), "assets"), { recursive: true, force: true });
    const [sizes, trim] = await Promise.all([this.ctx.pages.sizes(bookId), this.ctx.pages.trim(bookId).catch(() => null)]);
    return { book, sections: this.sections(bookId), position, sizes, trim };
  }

  private pageOfBlock(blockId: number): ReadingPosition | null {
    const b = this.ctx.db.prepare("select page from blocks where id = ?").get(blockId) as { page: number } | undefined;
    return b ? { page: Number(b.page) } : null;
  }

  savePosition(bookId: string, position: ReadingPosition): void {
    this.ctx.db.prepare("update books set position = ? where id = ?").run(JSON.stringify({ page: position.page }), bookId);
  }

  /**
   * The block a stretch of a page falls in — the one whose box holds most of
   * it — which is how a highlight or a card knows its chapter. Falls back to
   * the chapter the page belongs to when the import found no block there.
   */
  async anchor(bookId: string, page: number, start: number, end: number): Promise<{ blockId: number | null; unitId: number | null }> {
    const db = this.ctx.db;
    const blocks = db.prepare("select id, unit_id, bbox from blocks where book_id = ? and page = ? and bbox is not null").all(bookId, page) as Array<{
      id: number;
      unit_id: number;
      bbox: string;
    }>;
    if (blocks.length) {
      let box: Rect | null = null;
      try {
        box = rangeBox(await this.ctx.pages.text(bookId, page), start, end);
      } catch {
        box = null;
      }
      if (box) {
        const [x, y] = [(box[0] + box[2]) / 2, (box[1] + Math.min(box[3], box[1] + 14)) / 2];
        let best: { id: number; unit_id: number } | null = null;
        let bestD = Infinity;
        for (const b of blocks) {
          const r = JSON.parse(b.bbox) as Rect;
          const dx = x < r[0] ? r[0] - x : x > r[2] ? x - r[2] : 0;
          const dy = y < r[1] ? r[1] - y : y > r[3] ? y - r[3] : 0;
          if (dx + dy < bestD) {
            bestD = dx + dy;
            best = b;
          }
        }
        if (best) return { blockId: Number(best.id), unitId: Number(best.unit_id) };
      }
    }
    return { blockId: blocks[0] ? Number(blocks[0].id) : null, unitId: unitAt(db, bookId, page) };
  }

  async annotations(bookId: string): Promise<Annotations> {
    await this.placeLegacy(bookId);
    const db = this.ctx.db;
    const highlights = (
      db.prepare("select * from highlights where book_id = ? and page is not null and start >= 0 order by page, start").all(bookId) as Array<
        Record<string, unknown>
      >
    ).map(highlightFromRow);
    const versions = (
      db.prepare("select * from versions where book_id = ? and start >= 0 order by page, start").all(bookId) as Array<Record<string, unknown>>
    ).map(versionFromRow);
    const sketches = (
      db.prepare("select id, page, y, title from sketches where book_id = ? and page is not null order by page").all(bookId) as Array<{
        id: number;
        page: number;
        y: number | null;
        title: string;
      }>
    ).map((r) => ({ id: Number(r.id), page: Number(r.page), y: Number(r.y ?? 60), title: r.title }));
    const chats = (
      db
        .prepare(
          `select c.id, c.page, (select m.start from chat_messages m where m.chat_id = c.id and m.page = c.page order by m.id limit 1) as start
           from chats c where c.book_id = ? and c.page is not null`,
        )
        .all(bookId) as Array<{ id: number; page: number; start: number | null }>
    ).map((r) => ({ id: Number(r.id), page: Number(r.page), start: r.start === null ? null : Number(r.start) }));
    // Pages read on the page view, and pages whose every passage was read
    // in the reflowed reader before it.
    const read = (
      db
        .prepare(
          `select page from page_reads where book_id = ?
           union
           select b.page from blocks b left join reads r on r.block_id = b.id where b.book_id = ?
           group by b.page having count(*) = count(r.block_id)`,
        )
        .all(bookId, bookId) as Array<{ page: number }>
    ).map((r) => Number(r.page));
    return { highlights, versions, sketches, chats, read };
  }

  /**
   * Marks made on the reflowed text carry a block's page and their words;
   * find the words on the page (or the next, for a passage that ran over)
   * and anchor them there. Words that cannot be found are left as they are.
   */
  private async placeLegacy(bookId: string): Promise<void> {
    const db = this.ctx.db;
    const waiting = [
      ...(db.prepare("select id, page, quote, 'highlights' as tbl from highlights where book_id = ? and start < 0 and page is not null").all(bookId) as Array<{
        id: number;
        page: number;
        quote: string;
        tbl: string;
      }>),
      ...(db.prepare("select id, page, quote, 'versions' as tbl from versions where book_id = ? and start < 0").all(bookId) as Array<{
        id: number;
        page: number;
        quote: string;
        tbl: string;
      }>),
    ];
    for (const w of waiting) {
      for (const page of [Number(w.page), Number(w.page) + 1]) {
        let text: PageText;
        try {
          text = await this.ctx.pages.text(bookId, page);
        } catch {
          continue;
        }
        const at = locate(text, w.quote);
        if (!at) continue;
        db.prepare(`update ${w.tbl === "versions" ? "versions" : "highlights"} set page = ?, start = ?, end = ? where id = ?`).run(page, at[0], at[1], w.id);
        break;
      }
    }
  }

  private unitFraction(unitId: number): number {
    const r = this.ctx.db
      .prepare(
        `select s.weight as weight,
           (select coalesce(sum(b.weight), 0) from reads r join blocks b on b.id = r.block_id where r.unit_id = s.id) as read
         from sections s where s.id = ?`,
      )
      .get(unitId) as { weight: number; read: number } | undefined;
    if (!r) return 0;
    return Number(r.weight) ? Math.min(1, Number(r.read) / Number(r.weight)) : 1;
  }

  /**
   * Pages read. Reading a page reads every passage the import found on it,
   * which is what chapter progress, the knowledge map and the cards that
   * wait on a chapter are all counted in.
   */
  readPages(bookId: string, reads: Array<{ page: number; dwellMs: number }>, unlock: (unitId: number) => number): ReadResult {
    const db = this.ctx.db;
    const pages = reads.map((r) => r.page);
    if (!pages.length) return { units: [], unlocked: 0 };
    const marks = pages.map(() => "?").join(",");
    const units = (
      db.prepare(`select distinct unit_id from blocks where book_id = ? and page in (${marks})`).all(bookId, ...pages) as Array<{ unit_id: number }>
    ).map((r) => Number(r.unit_id));
    const before = new Map(units.map((u) => [u, this.unitFraction(u)]));
    const now = Date.now();
    tx(db, () => {
      const putPage = db.prepare(
        `insert into page_reads (book_id, page, at, dwell_ms) values (?, ?, ?, ?)
         on conflict(book_id, page) do update set dwell_ms = dwell_ms + excluded.dwell_ms`,
      );
      const putBlocks = db.prepare(
        `insert into reads (block_id, book_id, unit_id, at, dwell_ms) select id, book_id, unit_id, ?, 0 from blocks where book_id = ? and page = ?
         on conflict(block_id) do nothing`,
      );
      for (const r of reads) {
        putPage.run(bookId, r.page, now, Math.round(r.dwellMs));
        putBlocks.run(now, bookId, r.page);
      }
    });
    return this.afterReading(bookId, before, unlock);
  }

  markUnit(bookId: string, unitId: number, read: boolean, unlock: (unitId: number) => number): ReadResult {
    const db = this.ctx.db;
    const before = new Map([[unitId, this.unitFraction(unitId)]]);
    tx(db, () => {
      if (read) {
        db.prepare(
          `insert into reads (block_id, book_id, unit_id, at, dwell_ms) select id, book_id, unit_id, ?, 0 from blocks where unit_id = ?
           on conflict(block_id) do nothing`,
        ).run(Date.now(), unitId);
        db.prepare(
          `insert into page_reads (book_id, page, at, dwell_ms) select distinct book_id, page, ?, 0 from blocks where unit_id = ?
           on conflict(book_id, page) do nothing`,
        ).run(Date.now(), unitId);
      } else {
        db.prepare("delete from reads where unit_id = ?").run(unitId);
        db.prepare("delete from page_reads where book_id = ? and page in (select distinct page from blocks where unit_id = ?)").run(bookId, unitId);
      }
    });
    return this.afterReading(bookId, before, unlock);
  }

  private afterReading(bookId: string, before: Map<number, number>, unlock: (unitId: number) => number): ReadResult {
    const units: ReadResult["units"] = [];
    let unlocked = 0;
    let crossed = false;
    for (const [unitId, was] of before) {
      const readFraction = this.unitFraction(unitId);
      units.push({ unitId, readFraction });
      if (readFraction >= UNIT_DONE) {
        unlocked += unlock(unitId);
        if (was < UNIT_DONE) this.onUnitRead(bookId, unitId);
      }
      if (Math.floor(was * 20) !== Math.floor(readFraction * 20)) crossed = true;
    }
    if (unlocked) this.ctx.emit("cards.changed", { bookId });
    if (crossed || unlocked) this.changed(bookId);
    return { units, unlocked };
  }

  addTime(bookId: string, ms: number): void {
    if (!(ms > 0) || ms > 3_600_000) return;
    this.ctx.db
      .prepare("insert into reading_time (book_id, day, ms) values (?, ?, ?) on conflict(book_id, day) do update set ms = ms + excluded.ms")
      .run(bookId, today(), Math.round(ms));
  }

  search(query: string, bookId: string | null): SearchHit[] {
    const words = query
      .normalize("NFKC")
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .slice(0, 8);
    if (!words.length) return [];
    // Every word must appear; the last may still be being typed.
    const match = words.map((w, i) => `"${w.replace(/"/g, "")}"${i === words.length - 1 ? "*" : ""}`).join(" ");
    const rows = this.ctx.db
      .prepare(
        `select f.rowid as id, snippet(blocks_fts, 0, char(1), char(2), '…', 14) as snippet,
           b.book_id as book_id, b.unit_id as unit_id, b.page as page, k.title as book_title, u.title as unit_title
         from blocks_fts f join blocks b on b.id = f.rowid join books k on k.id = b.book_id join sections u on u.id = b.unit_id
           join sections sec on sec.id = b.section_id
         where blocks_fts match ? ${bookId ? "and b.book_id = ?" : ""} and b.type not in ('equation')
           -- A contents page or an index names everything and teaches nothing.
           and sec.kind not in ('contents', 'index') and u.kind not in ('contents', 'index')
         order by rank limit 60`,
      )
      .all(match, ...(bookId ? [bookId] : [])) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      bookId: String(r["book_id"]),
      bookTitle: String(r["book_title"]),
      blockId: Number(r["id"]),
      unitId: Number(r["unit_id"]),
      page: Number(r["page"]),
      unitTitle: String(r["unit_title"]),
      snippet: String(r["snippet"]),
    }));
  }

  locate(blockId: number): { bookId: string; unitId: number; page: number; box: Rect | null } | null {
    const r = this.ctx.db.prepare("select book_id, unit_id, page, bbox from blocks where id = ?").get(blockId) as
      | { book_id: string; unit_id: number; page: number; bbox: string | null }
      | undefined;
    if (!r) return null;
    return { bookId: r.book_id, unitId: Number(r.unit_id), page: Number(r.page), box: r.bbox ? (JSON.parse(r.bbox) as Rect) : null };
  }

  // ── the reader's own versions ──────────────────────────────────────────

  saveVersion(input: { id?: number; bookId: string; page: number; start: number; end: number; quote: string; text: string; source: "user" | "ai" }): Version {
    const db = this.ctx.db;
    const text = input.text.replace(/\r\n?/g, "\n").trim();
    if (!text) throw new Error("A version needs some text.");
    const now = Date.now();
    let id = input.id;
    if (id) {
      db.prepare("update versions set text = ?, source = ?, updated_at = ? where id = ?").run(text, input.source, now, id);
    } else {
      // One version per passage: writing over the same words replaces it.
      const same = db
        .prepare("select id from versions where book_id = ? and page = ? and start = ? and end = ?")
        .get(input.bookId, input.page, input.start, input.end) as { id: number } | undefined;
      if (same) {
        id = Number(same.id);
        db.prepare("update versions set text = ?, source = ?, updated_at = ? where id = ?").run(text, input.source, now, id);
      } else {
        id = Number(
          db
            .prepare(
              `insert into versions (book_id, page, start, end, quote, text, source, created_at, updated_at)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(input.bookId, input.page, input.start, input.end, input.quote, text, input.source, now, now).lastInsertRowid,
        );
      }
    }
    const row = db.prepare("select * from versions where id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error("That version no longer exists.");
    return versionFromRow(row);
  }

  removeVersion(id: number): void {
    this.ctx.db.prepare("delete from versions where id = ?").run(id);
  }

  // ── highlights ─────────────────────────────────────────────────────────

  async addHighlight(input: { bookId: string; page: number; start: number; end: number; quote: string; color: HighlightColor; note?: string }): Promise<Highlight> {
    const at = await this.anchor(input.bookId, input.page, input.start, input.end);
    const now = Date.now();
    const r = this.ctx.db
      .prepare(
        `insert into highlights (book_id, block_id, unit_id, page, start, end, quote, color, note, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.bookId, at.blockId ?? 0, at.unitId ?? 0, input.page, input.start, input.end, input.quote, input.color, input.note ?? "", now, now);
    return highlightFromRow(this.ctx.db.prepare("select * from highlights where id = ?").get(Number(r.lastInsertRowid)) as Record<string, unknown>);
  }

  updateHighlight(id: number, patch: { color?: HighlightColor; note?: string }): Highlight {
    const h = this.ctx.db.prepare("select * from highlights where id = ?").get(id) as Record<string, unknown> | undefined;
    if (!h) throw new Error("That highlight no longer exists.");
    this.ctx.db
      .prepare("update highlights set color = ?, note = ?, updated_at = ? where id = ?")
      .run(patch.color ?? String(h["color"]), patch.note ?? String(h["note"]), Date.now(), id);
    return highlightFromRow(this.ctx.db.prepare("select * from highlights where id = ?").get(id) as Record<string, unknown>);
  }

  removeHighlight(id: number): void {
    this.ctx.db.prepare("delete from highlights where id = ?").run(id);
  }

  highlights(bookId: string): HighlightRow[] {
    const rows = this.ctx.db
      .prepare(
        `select h.*, u.title as unit_title from highlights h left join sections u on u.id = h.unit_id
         where h.book_id = ? and h.page is not null order by h.page, h.start`,
      )
      .all(bookId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...highlightFromRow(r), unitTitle: r["unit_title"] === null ? "" : String(r["unit_title"]) }));
  }
}
