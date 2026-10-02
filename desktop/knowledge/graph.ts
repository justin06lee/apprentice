/**
 * What the reader knows, concept by concept.
 *
 * Two kinds of evidence, kept apart because they mean different things:
 *
 *   exposure  how much of what the books say about a concept has been read
 *   recall    how likely the reader is to remember it right now — the FSRS
 *             retrievability of the cards that test it
 *
 * Reading alone can only make a concept "seen": mastery from exposure is
 * capped well below what recall can earn, because having read a definition
 * is not knowing it. Cards that have been reviewed carry most of the weight,
 * and their retrievability decays with time, so a concept known last month
 * and not reviewed since shows as fading.
 */
import { State } from "ts-fsrs";
import type { Card, Concept, ConceptDetail, ConceptEdge, ConceptMention, ConceptState, KnowledgeGraph } from "../../shared/types.js";
import type { Ctx } from "../context.js";
import type { Scheduler } from "../srs.js";
import { cardFromRow } from "../srs.js";

/** Most nodes a map shows at once; past this the least central drop out. */
const MAX_NODES = 1400;

interface ConceptRow {
  id: number;
  name: string;
  importance: number;
  definition: string | null;
  books: string;
}

export class Knowledge {
  constructor(
    private readonly ctx: Ctx,
    private readonly srs: Scheduler,
  ) {}

  /** Exposure and recall for every concept in scope, in two queries. */
  private evidence(bookId: string | null, ids: number[] | null) {
    const db = this.ctx.db;
    const scope = bookId ? "m.book_id = ?" : "1 = 1";
    const args: Array<string | number> = bookId ? [bookId] : [];
    const exposure = new Map<number, { total: number; read: number }>();
    const rows = db
      .prepare(
        `select m.concept_id as id, sum(m.count) as total, sum(case when r.block_id is null then 0 else m.count end) as read
         from mentions m left join reads r on r.block_id = m.block_id where ${scope} group by m.concept_id`,
      )
      .all(...args) as Array<{ id: number; total: number; read: number }>;
    for (const r of rows) exposure.set(Number(r.id), { total: Number(r.total), read: Number(r.read) });
    // Having read where a concept is defined is having met it, however
    // often the rest of the book goes on to use it.
    const defRead = new Set(
      (
        db
          .prepare(
            `select distinct cb.concept_id as id from concept_books cb join reads r on r.block_id = cb.def_block_id
             ${bookId ? "where cb.book_id = ?" : ""}`,
          )
          .all(...args) as Array<{ id: number }>
      ).map((r) => Number(r.id)),
    );

    const recall = new Map<number, { sum: number; n: number; stable: number; learning: number; cards: number }>();
    const cards = db
      .prepare(
        `select cc.concept_id as cid, c.* from card_concepts cc join cards c on c.id = cc.card_id
         where c.status = 'active' ${bookId ? "and c.book_id = ?" : ""}`,
      )
      .all(...args) as Array<Record<string, unknown>>;
    const now = Date.now();
    for (const c of cards) {
      const cid = Number(c["cid"]);
      const entry = recall.get(cid) ?? { sum: 0, n: 0, stable: 0, learning: 0, cards: 0 };
      entry.cards++;
      const R = this.srs.retrievability(c as never, now);
      if (R !== null) {
        entry.sum += R;
        entry.n++;
        if (Number(c["stability"]) >= 7) entry.stable++;
        if (Number(c["state"]) === State.Learning || Number(c["state"]) === State.Relearning) entry.learning++;
      }
      recall.set(cid, entry);
    }
    void ids;
    return { exposure, recall, defRead };
  }

  private toConcept(
    r: ConceptRow,
    ev: ReturnType<Knowledge["evidence"]>,
  ): Concept {
    const id = Number(r.id);
    const ex = ev.exposure.get(id);
    const rc = ev.recall.get(id);
    const exposure = ex && ex.total ? ex.read / ex.total : 0;
    const recall = rc && rc.n ? rc.sum / rc.n : null;
    const mastery = recall === null ? exposure * 0.4 : exposure * 0.2 + recall * 0.8;
    let state: ConceptState;
    const met = ev.defRead.has(id) || (!!ex && ex.read >= Math.min(3, ex.total));
    if (recall === null) state = met ? "seen" : "unseen";
    else if (rc!.stable > 0 && recall < 0.75) state = "fading";
    else if (recall >= 0.85 && rc!.stable >= Math.max(1, rc!.n / 2) && rc!.learning === 0) state = "known";
    else state = "learning";
    return {
      id,
      name: r.name,
      definition: r.definition,
      importance: r.importance,
      mastery: Math.round(mastery * 1000) / 1000,
      exposure: Math.round(exposure * 1000) / 1000,
      recall: recall === null ? null : Math.round(recall * 1000) / 1000,
      state,
      mentions: ex?.total ?? 0,
      cards: rc?.cards ?? 0,
      bookIds: r.books ? r.books.split(",") : [],
    };
  }

  private conceptRows(bookId: string | null, where = "", args: Array<string | number> = []): ConceptRow[] {
    // Across books a concept is as central as it is in the book where it
    // matters most; its definition comes from that book too.
    return this.ctx.db
      .prepare(
        `select c.id, c.name, max(cb.importance) as importance,
           (select cb2.definition from concept_books cb2 where cb2.concept_id = c.id and cb2.definition is not null
              ${bookId ? "and cb2.book_id = ?" : ""} order by cb2.importance desc limit 1) as definition,
           group_concat(cb.book_id) as books
         from concepts c join concept_books cb on cb.concept_id = c.id
         where ${bookId ? "cb.book_id = ?" : "1 = 1"} ${where}
         group by c.id order by importance desc limit ${MAX_NODES}`,
      )
      .all(...(bookId ? [bookId, bookId] : []), ...args) as unknown as ConceptRow[];
  }

  graph(bookId: string | null): KnowledgeGraph {
    const rows = this.conceptRows(bookId);
    const ev = this.evidence(bookId, null);
    const nodes = rows.map((r) => this.toConcept(r, ev));
    const ids = new Set(nodes.map((n) => n.id));
    const edgeRows = this.ctx.db
      .prepare(
        `select a, b, kind, max(weight) as weight, max(label) as label from edges
         ${bookId ? "where book_id = ?" : ""} group by a, b, kind`,
      )
      .all(...(bookId ? [bookId] : [])) as Array<{ a: number; b: number; kind: string; weight: number; label: string | null }>;
    const edges: ConceptEdge[] = [];
    for (const e of edgeRows) {
      const a = Number(e.a);
      const b = Number(e.b);
      if (!ids.has(a) || !ids.has(b)) continue;
      edges.push({ a, b, weight: e.weight, kind: e.kind as ConceptEdge["kind"], label: e.label });
    }
    return { nodes, edges };
  }

  unit(unitId: number): KnowledgeGraph {
    const u = this.ctx.db.prepare("select book_id from sections where id = ?").get(unitId) as { book_id: string } | undefined;
    if (!u) return { nodes: [], edges: [] };
    const rows = this.conceptRows(u.book_id, "and c.id in (select concept_id from mentions where unit_id = ?)", [unitId]);
    const ev = this.evidence(u.book_id, null);
    const nodes = rows.map((r) => this.toConcept(r, ev));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = this.graph(u.book_id).edges.filter((e) => ids.has(e.a) && ids.has(e.b));
    return { nodes, edges };
  }

  concept(conceptId: number): ConceptDetail {
    const db = this.ctx.db;
    const rows = this.conceptRows(null, "and c.id = ?", [conceptId]);
    if (!rows.length) throw new Error("That concept is no longer in the library.");
    const ev = this.evidence(null, [conceptId]);
    const concept = this.toConcept(rows[0]!, ev);

    const mentionRows = db
      .prepare(
        `select m.block_id, m.book_id, m.unit_id, m.is_def, coalesce(b.custom_text, b.text) as text, k.title as book_title,
           u.title as unit_title, (r.block_id is not null) as read
         from mentions m join blocks b on b.id = m.block_id join books k on k.id = m.book_id join sections u on u.id = m.unit_id
         left join reads r on r.block_id = m.block_id
         where m.concept_id = ? order by m.is_def desc, k.title, b.ord limit 60`,
      )
      .all(conceptId) as Array<Record<string, unknown>>;
    const needle = concept.name.toLowerCase();
    const mentions: ConceptMention[] = mentionRows.map((r) => {
      const text = String(r["text"]);
      const at = Math.max(0, text.toLowerCase().indexOf(needle));
      const from = Math.max(0, at - 90);
      const to = Math.min(text.length, at + needle.length + 150);
      return {
        bookId: String(r["book_id"]),
        bookTitle: String(r["book_title"]),
        blockId: Number(r["block_id"]),
        unitId: Number(r["unit_id"]),
        unitTitle: String(r["unit_title"]),
        snippet: `${from ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`,
        isDefinition: Number(r["is_def"]) === 1,
        read: Number(r["read"]) === 1,
      };
    });

    const cards: Card[] = (
      db
        .prepare("select c.* from card_concepts cc join cards c on c.id = cc.card_id where cc.concept_id = ? order by c.status, c.id")
        .all(conceptId) as never[]
    ).map(cardFromRow);

    const neighborRows = (
      db
        .prepare(
          `select case when a = ? then b else a end as other, (a = ?) as selfIsA, max(weight) as weight, max(label) as label
           from edges where a = ? or b = ? group by other order by weight desc limit 16`,
        )
        .all(conceptId, conceptId, conceptId, conceptId) as Array<{ other: number; selfIsA: number; weight: number; label: string | null }>
    ).map((n) => ({ ...n, label: relationPhrase(n.label, Number(n.selfIsA) === 1) }));
    const neighbors: ConceptDetail["neighbors"] = [];
    if (neighborRows.length) {
      const nrows = this.conceptRows(null, `and c.id in (${neighborRows.map(() => "?").join(",")})`, neighborRows.map((n) => Number(n.other)));
      const nev = this.evidence(null, null);
      const byId = new Map(nrows.map((r) => [Number(r.id), this.toConcept(r, nev)]));
      for (const n of neighborRows) {
        const c = byId.get(Number(n.other));
        if (c) neighbors.push({ concept: c, weight: n.weight, label: n.label });
      }
    }
    return { concept, mentions, cards, neighbors };
  }
}

/**
 * A stored relation, said from the selected concept's side: what the
 * neighbor is *to it*. Edges are stored low id first; a label ending in
 * "←" runs from b to a.
 */
function relationPhrase(label: string | null, selfIsA: boolean): string | null {
  if (!label) return null;
  const reversed = label.endsWith("←");
  const kind = reversed ? label.slice(0, -1) : label;
  // Is the neighbor the "from" end of the relation?
  const neighborIsFrom = reversed ? selfIsA : !selfIsA;
  switch (kind) {
    case "prerequisite":
      return neighborIsFrom ? "needed first" : "builds on it";
    case "part-of":
      return neighborIsFrom ? "a part of it" : "the whole";
    case "example-of":
      return neighborIsFrom ? "an example" : "the general case";
    case "generalizes":
      return neighborIsFrom ? "more general" : "a special case";
    case "contrasts":
      return "a contrast";
    default:
      return null;
  }
}
