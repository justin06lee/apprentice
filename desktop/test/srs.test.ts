import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/types.js";
import type { Ctx } from "../context.js";
import { openDb } from "../db.js";
import { Scheduler } from "../srs.js";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apprentice-srs-"));
  const db = openDb(path.join(dir, "test.db"));
  db.prepare("insert into books (id, title, file_name, file_hash, status, added_at) values ('b', 'B', 'b.pdf', 'h', 'ready', 0)").run();
  db.prepare("insert into sections (id, book_id, ord, level, title, page, kind, is_unit, unit_id, weight) values (1, 'b', 0, 1, 'One', 0, 'body', 1, 1, 100)").run();
  const events: string[] = [];
  const ctx: Ctx = { db, dataDir: dir, dbPath: path.join(dir, "test.db"), emit: (e) => void events.push(e), settings: () => DEFAULT_SETTINGS };
  return { db, srs: new Scheduler(ctx), events };
}

describe("Scheduler", () => {
  test("a new card is due at once, a good answer pushes it out, undo brings it back", () => {
    const { srs } = setup();
    const card = srs.create({ bookId: "b", blockId: null, kind: "basic", front: "Q", back: "A" });
    const queue = srs.queue("b");
    expect(queue.cards.map((c) => c.id)).toEqual([card.id]);
    expect(queue.cards[0]!.preview[3].due).toBeGreaterThan(Date.now());

    const after = srs.review(card.id, 3, 1200);
    expect(after.reps).toBe(1);
    expect(after.state).not.toBe(0);
    expect(srs.stats("b").reviewedToday).toBe(1);

    const back = srs.undo(card.id)!;
    expect(back.reps).toBe(0);
    expect(back.state).toBe(0);
    expect(srs.stats("b").reviewedToday).toBe(0);
  });

  test("cards from an unread chapter wait, and finishing it unlocks them", () => {
    const { db, srs } = setup();
    db.prepare("insert into cards (book_id, unit_id, kind, front, source, status, due, created_at) values ('b', 1, 'basic', 'Q', 'auto', 'pending', 0, 0)").run();
    expect(srs.queue("b").cards.length).toBe(0);
    expect(srs.unlockUnit(1)).toBe(1);
    expect(srs.queue("b").cards.length).toBe(1);
  });
});
