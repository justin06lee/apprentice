/**
 * Flashcards and their schedule, by FSRS (ts-fsrs).
 *
 * A card's whole FSRS state lives in its row, so the scheduler is stateless:
 * read the row, ask FSRS, write the row and a log entry. The log entry keeps
 * the state from before the review, which is all undo needs.
 *
 * Cards made at import wait as `pending` until their chapter has been read;
 * reading it is what puts them in rotation (see `unlockUnit`).
 */
import { fsrs, generatorParameters, Rating as FRating, State, type Card as FCard, type Grade } from "ts-fsrs";
import type {
  Card,
  CardKind,
  CardStats,
  CardWithContext,
  Rating,
  ReviewQueue,
} from "../shared/types.js";
import { startOfToday, type Ctx } from "./context.js";
import { tx } from "./db.js";
import { unitAt } from "./library.js";

interface CardRow {
  id: number;
  book_id: string;
  block_id: number | null;
  unit_id: number | null;
  page: number | null;
  kind: string;
  front: string;
  back: string;
  source: string;
  status: string;
  due: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: number | null;
  created_at: number;
}

export function cardFromRow(r: CardRow): Card {
  return {
    id: Number(r.id),
    bookId: r.book_id,
    blockId: r.block_id === null ? null : Number(r.block_id),
    unitId: r.unit_id === null ? null : Number(r.unit_id),
    page: r.page === null || r.page === undefined ? null : Number(r.page),
    kind: r.kind as CardKind,
    front: r.front,
    back: r.back,
    source: r.source as Card["source"],
    status: r.status as Card["status"],
    due: Number(r.due),
    state: Number(r.state),
    stability: r.stability,
    difficulty: r.difficulty,
    reps: Number(r.reps),
    lapses: Number(r.lapses),
    lastReview: r.last_review === null ? null : Number(r.last_review),
    createdAt: Number(r.created_at),
  };
}

function toFsrs(r: CardRow): FCard {
  return {
    due: new Date(Number(r.due)),
    stability: r.stability,
    difficulty: r.difficulty,
    elapsed_days: r.elapsed_days,
    scheduled_days: r.scheduled_days,
    learning_steps: Number(r.learning_steps),
    reps: Number(r.reps),
    lapses: Number(r.lapses),
    state: Number(r.state) as State,
    ...(r.last_review === null ? {} : { last_review: new Date(Number(r.last_review)) }),
  };
}

/** "1m", "10m", "3d", "2.1mo" — how far off a due date is. */
export function interval(ms: number): string {
  const m = ms / 60000;
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d`;
  const mo = d / 30.4;
  if (mo < 12) return `${mo < 10 ? mo.toFixed(1).replace(/\.0$/, "") : Math.round(mo)}mo`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, "")}y`;
}

export class Scheduler {
  constructor(private readonly ctx: Ctx) {}

  private engine() {
    const s = this.ctx.settings();
    return fsrs(generatorParameters({ request_retention: s.desiredRetention, enable_fuzz: true, enable_short_term: true }));
  }

  private row(id: number): CardRow {
    const r = this.ctx.db.prepare("select * from cards where id = ?").get(id) as CardRow | undefined;
    if (!r) throw new Error("That card no longer exists.");
    return r;
  }

  get(id: number): Card {
    return cardFromRow(this.row(id));
  }

  retrievability(r: Pick<CardRow, "state" | "stability" | "last_review" | "due" | "difficulty" | "elapsed_days" | "scheduled_days" | "learning_steps" | "reps" | "lapses">, now = Date.now()): number | null {
    if (Number(r.state) === State.New || r.last_review === null) return null;
    return this.engine().get_retrievability(toFsrs(r as CardRow), new Date(now), false);
  }

  private withContext(rows: Array<CardRow & { book_title: string; unit_title: string | null }>): CardWithContext[] {
    const f = this.engine();
    const now = new Date();
    return rows.map((r) => {
      const preview = f.repeat(toFsrs(r), now);
      const p = (g: Grade) => {
        const due = preview[g].card.due.getTime();
        return { due, label: interval(due - now.getTime()) };
      };
      return {
        ...cardFromRow(r),
        bookTitle: r.book_title,
        unitTitle: r.unit_title,
        preview: { 1: p(FRating.Again), 2: p(FRating.Hard), 3: p(FRating.Good), 4: p(FRating.Easy) },
      };
    });
  }

  /**
   * What to review now: everything due that is in (re)learning first, then
   * reviews by due date, with new cards — up to the day's allowance —
   * mixed in among them so a session never ends in a wall of unfamiliar ones.
   */
  queue(bookId: string | null, limit = 200): ReviewQueue {
    const db = this.ctx.db;
    const now = Date.now();
    const day = startOfToday();
    const s = this.ctx.settings();
    const where = bookId ? "and c.book_id = ?" : "";
    const args = bookId ? [bookId] : [];
    const select = `select c.*, b.title as book_title, u.title as unit_title from cards c
      join books b on b.id = c.book_id left join sections u on u.id = c.unit_id`;
    const due = db
      .prepare(`${select} where c.status = 'active' and c.state != 0 and c.due <= ? ${where} order by (c.state = 2), c.due limit ?`)
      .all(now, ...args, limit) as unknown as Array<CardRow & { book_title: string; unit_title: string | null }>;
    const introduced = Number(
      (
        db
          .prepare(`select count(distinct card_id) as n from review_log where review >= ? and state = 0 ${bookId ? "and book_id = ?" : ""}`)
          .get(day, ...args) as { n: number }
      ).n,
    );
    const allowance = Math.max(0, s.newCardsPerDay - introduced);
    const fresh = db
      .prepare(`${select} where c.status = 'active' and c.state = 0 ${where} order by c.unit_id, c.id limit ?`)
      .all(...args, Math.min(allowance, limit)) as unknown as Array<CardRow & { book_title: string; unit_title: string | null }>;
    const reviewedToday = Number(
      (db.prepare(`select count(*) as n from review_log where review >= ? ${bookId ? "and book_id = ?" : ""}`).get(day, ...args) as { n: number }).n,
    );

    // Interleave: one new card after every few reviews.
    const mixed: typeof due = [];
    const gap = fresh.length ? Math.max(1, Math.floor(due.length / fresh.length)) : Infinity;
    let fi = 0;
    due.forEach((c, i) => {
      mixed.push(c);
      if ((i + 1) % gap === 0 && fi < fresh.length) mixed.push(fresh[fi++]!);
    });
    while (fi < fresh.length) mixed.push(fresh[fi++]!);

    return {
      cards: this.withContext(mixed.slice(0, limit)),
      dueCount: due.length,
      newCount: fresh.length,
      reviewedToday,
    };
  }

  review(cardId: number, rating: Rating, durationMs: number): Card {
    const r = this.row(cardId);
    const now = new Date();
    const { card, log } = this.engine().next(toFsrs(r), now, rating as Grade);
    tx(this.ctx.db, () => {
      this.ctx.db
        .prepare(
          `update cards set due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, learning_steps = ?,
             reps = ?, lapses = ?, state = ?, last_review = ? where id = ?`,
        )
        .run(
          card.due.getTime(),
          card.stability,
          card.difficulty,
          card.elapsed_days,
          card.scheduled_days,
          card.learning_steps,
          card.reps,
          card.lapses,
          card.state,
          now.getTime(),
          cardId,
        );
      this.ctx.db
        .prepare(
          `insert into review_log (card_id, book_id, rating, state, due, stability, difficulty, elapsed_days, last_elapsed_days,
             scheduled_days, learning_steps, review, duration_ms) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          cardId,
          r.book_id,
          log.rating,
          log.state,
          log.due.getTime(),
          log.stability,
          log.difficulty,
          log.elapsed_days,
          log.last_elapsed_days,
          log.scheduled_days,
          log.learning_steps,
          log.review.getTime(),
          Math.round(durationMs),
        );
    });
    this.ctx.emit("cards.changed", { bookId: r.book_id });
    return this.get(cardId);
  }

  /** Take back the last review of a card. */
  undo(cardId: number): Card | null {
    const r = this.row(cardId);
    const log = this.ctx.db.prepare("select * from review_log where card_id = ? order by id desc limit 1").get(cardId) as
      | {
          id: number;
          rating: number;
          state: number;
          due: number;
          stability: number;
          difficulty: number;
          elapsed_days: number;
          last_elapsed_days: number;
          scheduled_days: number;
          learning_steps: number;
          review: number;
        }
      | undefined;
    if (!log) return null;
    const prev = this.engine().rollback(toFsrs(r), {
      rating: log.rating as FRating,
      state: log.state as State,
      due: new Date(Number(log.due)),
      stability: log.stability,
      difficulty: log.difficulty,
      elapsed_days: log.elapsed_days,
      last_elapsed_days: log.last_elapsed_days,
      scheduled_days: log.scheduled_days,
      learning_steps: Number(log.learning_steps),
      review: new Date(Number(log.review)),
    });
    tx(this.ctx.db, () => {
      this.ctx.db
        .prepare(
          `update cards set due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, learning_steps = ?,
             reps = ?, lapses = ?, state = ?, last_review = ? where id = ?`,
        )
        .run(
          prev.due.getTime(),
          prev.stability,
          prev.difficulty,
          prev.elapsed_days,
          prev.scheduled_days,
          prev.learning_steps,
          prev.reps,
          prev.lapses,
          prev.state,
          prev.last_review ? prev.last_review.getTime() : null,
          cardId,
        );
      this.ctx.db.prepare("delete from review_log where id = ?").run(log.id);
    });
    this.ctx.emit("cards.changed", { bookId: r.book_id });
    return this.get(cardId);
  }

  create(input: {
    bookId: string;
    blockId?: number | null;
    page?: number | null;
    kind: CardKind;
    front: string;
    back: string;
    source?: Card["source"];
    status?: Card["status"];
  }): Card {
    const block = input.blockId
      ? (this.ctx.db.prepare("select unit_id, page from blocks where id = ?").get(input.blockId) as { unit_id: number; page: number } | undefined)
      : undefined;
    const page = input.page ?? (block ? Number(block.page) : null);
    const unit = block ? Number(block.unit_id) : page === null ? null : unitAt(this.ctx.db, input.bookId, page);
    const now = Date.now();
    const r = this.ctx.db
      .prepare(
        `insert into cards (book_id, block_id, unit_id, page, kind, front, back, source, status, due, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.bookId, input.blockId ?? null, unit, page, input.kind, input.front, input.back, input.source ?? "user", input.status ?? "active", now, now);
    const id = Number(r.lastInsertRowid);
    this.ctx.emit("cards.changed", { bookId: input.bookId });
    return this.get(id);
  }

  update(id: number, patch: { front?: string; back?: string; status?: "active" | "suspended" }): Card {
    const r = this.row(id);
    this.ctx.db
      .prepare("update cards set front = ?, back = ?, status = ? where id = ?")
      .run(patch.front ?? r.front, patch.back ?? r.back, patch.status ?? r.status, id);
    this.ctx.emit("cards.changed", { bookId: r.book_id });
    return this.get(id);
  }

  remove(id: number): void {
    const r = this.row(id);
    this.ctx.db.prepare("delete from cards where id = ?").run(id);
    this.ctx.emit("cards.changed", { bookId: r.book_id });
  }

  list(bookId: string, unitId?: number | null): Card[] {
    const rows = (
      unitId
        ? this.ctx.db.prepare("select * from cards where book_id = ? and unit_id = ? order by id").all(bookId, unitId)
        : this.ctx.db.prepare("select * from cards where book_id = ? order by unit_id, id").all(bookId)
    ) as unknown as CardRow[];
    return rows.map(cardFromRow);
  }

  /** A chapter has been read: its waiting cards go into rotation. */
  unlockUnit(unitId: number): number {
    const r = this.ctx.db
      .prepare("update cards set status = 'active', due = ? where unit_id = ? and status = 'pending'")
      .run(Date.now(), unitId);
    return Number(r.changes);
  }

  stats(bookId: string | null): CardStats {
    const db = this.ctx.db;
    const where = bookId ? "where book_id = ?" : "";
    const args = bookId ? [bookId] : [];
    const counts = db
      .prepare(
        `select count(*) as total,
           sum(status = 'active') as active, sum(status = 'pending') as pending,
           sum(status = 'active' and state != 0 and due <= ?) as due,
           sum(status = 'active' and state = 0) as fresh
         from cards ${where}`,
      )
      .get(Date.now(), ...args) as Record<string, number | null>;
    const day = startOfToday();
    const reviewedToday = Number(
      (db.prepare(`select count(*) as n from review_log where review >= ? ${bookId ? "and book_id = ?" : ""}`).get(day, ...args) as { n: number }).n,
    );
    const reviewed = db
      .prepare(`select * from cards where status = 'active' and state != 0 ${bookId ? "and book_id = ?" : ""}`)
      .all(...args) as unknown as CardRow[];
    let sum = 0;
    let n = 0;
    for (const r of reviewed) {
      const R = this.retrievability(r);
      if (R !== null) {
        sum += R;
        n++;
      }
    }
    const forecast = new Array<number>(14).fill(0);
    const dayMs = 86_400_000;
    for (const r of reviewed) {
      const d = Math.floor((Number(r.due) - day) / dayMs);
      forecast[Math.max(0, Math.min(13, d))]! += d < 14 ? 1 : 0;
    }
    return {
      total: Number(counts["total"] ?? 0),
      active: Number(counts["active"] ?? 0),
      pending: Number(counts["pending"] ?? 0),
      due: Number(counts["due"] ?? 0),
      newCards: Number(counts["fresh"] ?? 0),
      reviewedToday,
      retention: n ? sum / n : null,
      forecast,
    };
  }
}
