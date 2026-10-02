/**
 * Sketches: drawings the reader makes beside the text, kept as strokes (so
 * they stay editable) with an SVG rendering for thumbnails.
 */
import type { Sketch, SketchData } from "../shared/types.js";
import type { Ctx } from "./context.js";

function fromRow(r: Record<string, unknown>): Sketch {
  let data: SketchData = { version: 1, strokes: [] };
  try {
    data = JSON.parse(String(r["data"])) as SketchData;
  } catch {
    // an unreadable sketch opens empty rather than not at all
  }
  return {
    id: Number(r["id"]),
    bookId: String(r["book_id"]),
    blockId: r["block_id"] === null ? null : Number(r["block_id"]),
    unitId: r["unit_id"] === null ? null : Number(r["unit_id"]),
    title: String(r["title"]),
    data,
    svg: String(r["svg"]),
    createdAt: Number(r["created_at"]),
    updatedAt: Number(r["updated_at"]),
  };
}

export class Sketches {
  constructor(private readonly ctx: Ctx) {}

  list(bookId: string): Sketch[] {
    return (this.ctx.db.prepare("select * from sketches where book_id = ? order by updated_at desc").all(bookId) as Array<Record<string, unknown>>).map(
      fromRow,
    );
  }

  get(id: number): Sketch {
    const r = this.ctx.db.prepare("select * from sketches where id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) throw new Error("That sketch no longer exists.");
    return fromRow(r);
  }

  save(input: { id?: number; bookId: string; blockId: number | null; unitId: number | null; title: string; data: SketchData; svg: string }): Sketch {
    const now = Date.now();
    const data = JSON.stringify(input.data);
    if (input.id) {
      this.ctx.db
        .prepare("update sketches set title = ?, data = ?, svg = ?, block_id = ?, unit_id = ?, updated_at = ? where id = ?")
        .run(input.title, data, input.svg, input.blockId, input.unitId, now, input.id);
      return this.get(input.id);
    }
    const r = this.ctx.db
      .prepare("insert into sketches (book_id, block_id, unit_id, title, data, svg, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.bookId, input.blockId, input.unitId, input.title, data, input.svg, now, now);
    return this.get(Number(r.lastInsertRowid));
  }

  remove(id: number): void {
    this.ctx.db.prepare("delete from sketches where id = ?").run(id);
  }
}
