/**
 * Reading on the page: pages read become chapters read (and unlock what
 * waited on them), marks find their chapter, and what was made on the old
 * reflowed text finds its place on the page.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PageText } from "../../shared/pages.js";
import { DEFAULT_SETTINGS } from "../../shared/types.js";
import type { Ctx } from "../context.js";
import { openDb } from "../db.js";
import { Library } from "../library.js";

function text(page: number, lines: string[]): PageText {
  let t = "";
  const out: PageText["lines"] = [];
  lines.forEach((l, i) => {
    if (i) t += "\n";
    const y0 = 100 + i * 12;
    out.push({ x0: 50, y0, x1: 50 + l.length * 5, y1: y0 + 10, s: t.length, xs: Array.from({ length: l.length + 1 }, (_, k) => 50 + k * 5), b: 0 });
    t += l;
  });
  return { page, width: 400, height: 600, text: t, lines: out, ink: null };
}

const PAGES = [text(0, ["A process is a running program.", "It has state."]), text(1, ["Scheduling picks which process runs.", "More on that later."])];

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apprentice-reading-"));
  const db = openDb(path.join(dir, "test.db"));
  db.exec(`
    insert into books (id, title, file_name, file_hash, status, added_at, weight) values ('b', 'B', 'b.pdf', 'h', 'ready', 0, 100);
    insert into sections (id, book_id, ord, level, title, page, kind, is_unit, unit_id, weight) values (1, 'b', 0, 1, 'One', 0, 'body', 1, 1, 100);
    insert into blocks (id, book_id, unit_id, section_id, ord, type, text, page, bbox, weight) values
      (10, 'b', 1, 1, 0, 'paragraph', 'A process is a running program. It has state.', 0, '[50,100,250,122]', 40),
      (11, 'b', 1, 1, 1, 'paragraph', 'Scheduling picks which process runs. More on that later.', 1, '[50,100,250,122]', 60);
    insert into cards (book_id, block_id, unit_id, kind, front, back, source, status, due, created_at) values ('b', 10, 1, 'basic', 'Q', 'A', 'auto', 'pending', 0, 0);
  `);
  const finished: number[] = [];
  const ctx: Ctx = {
    db,
    dataDir: dir,
    dbPath: path.join(dir, "test.db"),
    emit: () => {},
    settings: () => DEFAULT_SETTINGS,
    pages: {
      text: async (_b, page) => PAGES[page]!,
      sizes: async () => [
        [400, 600],
        [400, 600],
      ],
      trim: async () => null,
      region: () => Promise.reject(new Error("no pictures in this test")),
    },
  };
  const unlock = (unitId: number) =>
    Number(db.prepare("update cards set status = 'active' where unit_id = ? and status = 'pending'").run(unitId).changes);
  return { db, library: new Library(ctx, "", (_b, u) => void finished.push(u)), unlock, finished };
}

describe("reading on the page", () => {
  test("pages read become the chapter read, and its waiting cards join the reviews", async () => {
    const { library, unlock, finished } = setup();
    const first = library.readPages("b", [{ page: 0, dwellMs: 4000 }], unlock);
    expect(first.units[0]!.readFraction).toBeCloseTo(0.4);
    expect(first.unlocked).toBe(0);
    const second = library.readPages("b", [{ page: 1, dwellMs: 4000 }], unlock);
    expect(second.units[0]!.readFraction).toBe(1);
    expect(second.unlocked).toBe(1);
    expect(finished).toEqual([1]);
    expect((await library.annotations("b")).read.sort()).toEqual([0, 1]);
  });

  test("a highlight knows the block, and so the chapter, it was made in", async () => {
    const { library } = setup();
    const h = await library.addHighlight({ bookId: "b", page: 1, start: 0, end: 10, quote: "Scheduling", color: "yellow" });
    expect(h.blockId).toBe(11);
    expect(h.unitId).toBe(1);
    expect(library.highlights("b").map((x) => x.unitTitle)).toEqual(["One"]);
  });

  test("one version per passage: writing over the same words replaces it", () => {
    const { library } = setup();
    const p = { bookId: "b", page: 0, start: 0, end: 31, quote: "A process is a running program." };
    const a = library.saveVersion({ ...p, text: "Mine.", source: "user" });
    const b = library.saveVersion({ ...p, text: "Mine, again.", source: "ai" });
    expect(b.id).toBe(a.id);
    expect(b.text).toBe("Mine, again.");
    expect(b.source).toBe("ai");
  });

  test("marks made on the reflowed text are placed on their page when the book opens", async () => {
    const { db, library } = setup();
    db.prepare(
      `insert into highlights (book_id, block_id, unit_id, page, start, end, quote, color, note, created_at, updated_at)
       values ('b', 11, 1, 0, -1, -1, 'which process runs', 'green', '', 0, 0)`,
    ).run();
    const a = await library.annotations("b");
    expect(a.highlights).toHaveLength(1);
    // It ran over to the next page; that is where it was found.
    expect(a.highlights[0]!.page).toBe(1);
    expect(PAGES[1]!.text.slice(a.highlights[0]!.start, a.highlights[0]!.end)).toBe("which process runs");
  });

  test("a position saved by the reflowed reader opens on its block's page", async () => {
    const { db, library } = setup();
    db.prepare(`update books set position = '{"unitId":1,"blockId":11,"offset":0}' where id = 'b'`).run();
    expect((await library.open("b")).position).toEqual({ page: 1 });
  });
});
