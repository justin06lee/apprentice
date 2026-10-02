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
import type { HighlightRow } from "../shared/api.js";
import type {
  Block,
  BlockType,
  Book,
  Highlight,
  HighlightColor,
  Mark,
  OpenedBook,
  ReadingPosition,
  SearchHit,
  Section,
  SectionKind,
  UnitContent,
} from "../shared/types.js";
import { plainText } from "../shared/inline.js";
import { bookDir, today, type Ctx } from "./context.js";
import { tx } from "./db.js";
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
  body_size: number;
  position: string | null;
  read_weight: number;
  due: number;
  total_cards: number;
  concepts: number;
  units: number;
  time_ms: number;
}

interface BlockRow {
  id: number;
  unit_id: number;
  section_id: number;
  ord: number;
  type: string;
  level: number;
  text: string;
  marks: string | null;
  refs: string | null;
  page: number;
  asset: string | null;
  width: number;
  height: number;
  boxed: number;
  label: string | null;
  custom_text: string | null;
  custom_source: string | null;
  custom_at: number | null;
}

export function blockFromRow(r: BlockRow): Block {
  const marks: Mark[] = r.marks ? JSON.parse(r.marks) : [];
  const refs: Mark[] = r.refs ? JSON.parse(r.refs) : [];
  return {
    id: Number(r.id),
    unitId: Number(r.unit_id),
    sectionId: Number(r.section_id),
    ord: Number(r.ord),
    type: r.type as BlockType,
    level: Number(r.level),
    text: r.text,
    marks: refs.length ? [...marks, ...refs] : marks,
    page: Number(r.page),
    asset: r.asset,
    width: r.width,
    height: r.height,
    boxed: Number(r.boxed),
    label: r.label,
    custom: r.custom_text === null ? null : { text: r.custom_text, source: (r.custom_source ?? "user") as "user" | "ai", at: Number(r.custom_at ?? 0) },
  };
}

export function highlightFromRow(r: Record<string, unknown>): Highlight {
  return {
    id: Number(r["id"]),
    bookId: String(r["book_id"]),
    blockId: Number(r["block_id"]),
    unitId: Number(r["unit_id"]),
    start: Number(r["start"]),
    end: Number(r["end"]),
    quote: String(r["quote"]),
    onCustom: Number(r["on_custom"]) === 1,
    color: String(r["color"]) as HighlightColor,
    note: String(r["note"] ?? ""),
    createdAt: Number(r["created_at"]),
    updatedAt: Number(r["updated_at"]),
  };
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
      bodySize: Number(r.body_size) || 10,
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

  open(bookId: string): OpenedBook {
    this.ctx.db.prepare("update books set opened_at = ? where id = ?").run(Date.now(), bookId);
    const book = this.book(bookId);
    const raw = (this.ctx.db.prepare("select position from books where id = ?").get(bookId) as { position: string | null }).position;
    let position: ReadingPosition | null = null;
    try {
      position = raw ? (JSON.parse(raw) as ReadingPosition) : null;
    } catch {
      position = null;
    }
    return { book, sections: this.sections(bookId), position };
  }

  unit(bookId: string, unitId: number): UnitContent {
    const db = this.ctx.db;
    const blocks = (db.prepare("select * from blocks where unit_id = ? order by ord").all(unitId) as unknown as BlockRow[]).map(blockFromRow);
    const highlights = (db.prepare("select * from highlights where unit_id = ? order by start").all(unitId) as Array<Record<string, unknown>>).map(
      highlightFromRow,
    );
    const read = (db.prepare("select block_id from reads where unit_id = ?").all(unitId) as Array<{ block_id: number }>).map((r) =>
      Number(r.block_id),
    );
    const sketches = (
      db
        .prepare("select id, block_id, title, svg, updated_at from sketches where book_id = ? and unit_id = ? order by updated_at desc")
        .all(bookId, unitId) as Array<Record<string, unknown>>
    ).map((r) => ({
      id: Number(r["id"]),
      blockId: r["block_id"] === null ? null : Number(r["block_id"]),
      title: String(r["title"]),
      svg: String(r["svg"]),
      updatedAt: Number(r["updated_at"]),
    }));
    const cards = db
      .prepare("select sum(status = 'pending') as pending, sum(status = 'active') as active from cards where unit_id = ?")
      .get(unitId) as { pending: number | null; active: number | null };
    const chats = (
      db.prepare("select distinct block_id from chats where book_id = ? and block_id is not null").all(bookId) as Array<{ block_id: number }>
    ).map((r) => Number(r.block_id));
    return {
      unitId,
      blocks,
      highlights,
      read,
      sketches,
      cards: { pending: Number(cards.pending ?? 0), active: Number(cards.active ?? 0) },
      chats,
    };
  }

  savePosition(bookId: string, position: ReadingPosition): void {
    this.ctx.db.prepare("update books set position = ? where id = ?").run(JSON.stringify(position), bookId);
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

  /** Records reads, and when that finishes a chapter, unlocks what was waiting on it. */
  markRead(bookId: string, unitId: number, reads: Array<{ blockId: number; dwellMs: number }>, unlock: (unitId: number) => number) {
    const before = this.unitFraction(unitId);
    const now = Date.now();
    tx(this.ctx.db, () => {
      const put = this.ctx.db.prepare(
        `insert into reads (block_id, book_id, unit_id, at, dwell_ms) values (?, ?, ?, ?, ?)
         on conflict(block_id) do update set dwell_ms = dwell_ms + excluded.dwell_ms`,
      );
      for (const r of reads) put.run(r.blockId, bookId, unitId, now, Math.round(r.dwellMs));
    });
    return this.afterReading(bookId, unitId, before, unlock);
  }

  markUnit(bookId: string, unitId: number, read: boolean, unlock: (unitId: number) => number) {
    const before = this.unitFraction(unitId);
    if (read) {
      this.ctx.db
        .prepare(
          `insert into reads (block_id, book_id, unit_id, at, dwell_ms) select id, book_id, unit_id, ?, 0 from blocks where unit_id = ?
           on conflict(block_id) do nothing`,
        )
        .run(Date.now(), unitId);
    } else this.ctx.db.prepare("delete from reads where unit_id = ?").run(unitId);
    return this.afterReading(bookId, unitId, before, unlock);
  }

  private afterReading(bookId: string, unitId: number, before: number, unlock: (unitId: number) => number) {
    const readFraction = this.unitFraction(unitId);
    let unlocked = 0;
    if (readFraction >= UNIT_DONE) {
      unlocked = unlock(unitId);
      if (before < UNIT_DONE) this.onUnitRead(bookId, unitId);
    }
    if (unlocked) this.ctx.emit("cards.changed", { bookId });
    if (Math.floor(before * 20) !== Math.floor(readFraction * 20) || unlocked) this.changed(bookId);
    return { readFraction, unlocked };
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
           b.book_id as book_id, b.unit_id as unit_id, k.title as book_title, u.title as unit_title
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
      unitTitle: String(r["unit_title"]),
      snippet: String(r["snippet"]),
    }));
  }

  locate(blockId: number): { bookId: string; unitId: number } | null {
    const r = this.ctx.db.prepare("select book_id, unit_id from blocks where id = ?").get(blockId) as
      | { book_id: string; unit_id: number }
      | undefined;
    return r ? { bookId: r.book_id, unitId: Number(r.unit_id) } : null;
  }

  // ── the reader's own text ──────────────────────────────────────────────

  editBlock(blockId: number, text: string | null, source: "user" | "ai" = "user"): Block {
    const db = this.ctx.db;
    const before = db.prepare("select * from blocks where id = ?").get(blockId) as BlockRow | undefined;
    if (!before) throw new Error("That passage no longer exists.");
    const clean = text === null ? null : text.replace(/\r\n?/g, "\n").trim();
    const restoring = clean === null || clean === before.text;
    tx(db, () => {
      if (restoring) db.prepare("update blocks set custom_text = null, custom_source = null, custom_at = null where id = ?").run(blockId);
      else db.prepare("update blocks set custom_text = ?, custom_source = ?, custom_at = ? where id = ?").run(clean, source, Date.now(), blockId);
      // Highlights follow their words into the new text, or wait for the
      // text they were made on to come back.
      const now = restoring ? before.text : plainText(clean!);
      const hs = db.prepare("select * from highlights where block_id = ?").all(blockId) as Array<Record<string, unknown>>;
      for (const h of hs) {
        const quote = String(h["quote"]);
        const at = now.indexOf(quote);
        if (at >= 0) db.prepare("update highlights set start = ?, end = ?, on_custom = ? where id = ?").run(at, at + quote.length, restoring ? 0 : 1, h["id"] as number);
      }
    });
    return blockFromRow(db.prepare("select * from blocks where id = ?").get(blockId) as unknown as BlockRow);
  }

  // ── highlights ─────────────────────────────────────────────────────────

  addHighlight(input: { bookId: string; blockId: number; start: number; end: number; quote: string; color: HighlightColor; note?: string }): Highlight {
    const b = this.ctx.db.prepare("select unit_id, custom_text from blocks where id = ?").get(input.blockId) as
      | { unit_id: number; custom_text: string | null }
      | undefined;
    if (!b) throw new Error("That passage no longer exists.");
    const now = Date.now();
    const r = this.ctx.db
      .prepare(
        `insert into highlights (book_id, block_id, unit_id, start, end, quote, on_custom, color, note, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.bookId, input.blockId, b.unit_id, input.start, input.end, input.quote, b.custom_text === null ? 0 : 1, input.color, input.note ?? "", now, now);
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
        `select h.*, u.title as unit_title, coalesce(b.custom_text, b.text) as block_text from highlights h
         join blocks b on b.id = h.block_id join sections u on u.id = h.unit_id
         where h.book_id = ? order by b.ord, h.start`,
      )
      .all(bookId) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const h = highlightFromRow(r);
      const text = String(r["block_text"]);
      const from = Math.max(0, h.start - 80);
      const to = Math.min(text.length, h.end + 80);
      return {
        ...h,
        unitTitle: String(r["unit_title"]),
        context: `${from ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`,
      };
    });
  }
}
