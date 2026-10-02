/**
 * The model, through yagami: whichever coding-agent CLIs are signed in on
 * this machine (Claude Code, Codex, Gemini, …) — no API keys.
 *
 * Four things use it:
 *
 *   ask       questions about the book, answered with the passage, the
 *             chapter around it, the reader's notes and what they know
 *   rewrite   a passage written again for this reader, offered, never forced
 *   cards     flashcards for a finished chapter (background job)
 *   concepts  a finished chapter's concepts and how they relate (background job)
 *
 * Answers stream to the window as `ai.stream` events. Background jobs run
 * one at a time, so finishing three chapters in a row does not start three
 * CLIs at once.
 */
import { Yagami, type MessageStreamEvent } from "@justin06lee/yagami";
import { randomUUID } from "node:crypto";
import type { ChatContext } from "../shared/api.js";
import type { AiModel, AiStatus, CardKind, ChatMessage, ChatThread, Job } from "../shared/types.js";
import type { Ctx } from "./context.js";
import { tx } from "./db.js";
import { termKey, TermMatcher } from "./knowledge/terms.js";
import type { Knowledge } from "./knowledge/graph.js";
import { UNIT_DONE } from "./library.js";
import type { Scheduler } from "./srs.js";

type Msg = { role: "user" | "assistant"; content: string };

const PERSONA = `You are apprentice, a study companion built into a textbook reader. The reader is working through a book and asks you about it as they go.

How to answer:
- Ground answers in the book's own text, which you are given. Use its notation and terminology; when you go beyond the book, say so.
- Be direct and concise. Lead with the answer, then the reasoning. Short paragraphs; lists only when the content is a list.
- Explain at the level of someone reading this chapter. Build on what the reader already knows (you are told which concepts they know well and which they have not met yet) and do not lean on concepts they have not reached without explaining them.
- Write mathematics in LaTeX: $…$ inline, $$…$$ for displays. Code goes in fenced blocks with a language.
- If the passage seems wrong or ambiguous, say so plainly.`;

function chatFromRow(r: Record<string, unknown>): ChatMessage {
  return {
    id: Number(r["id"]),
    threadId: Number(r["chat_id"]),
    role: String(r["role"]) as "user" | "assistant",
    content: String(r["content"]),
    quote: r["quote"] === null ? null : String(r["quote"]),
    blockId: r["block_id"] === null ? null : Number(r["block_id"]),
    createdAt: Number(r["created_at"]),
  };
}

/** The first JSON object in a model's reply, however it was wrapped. */
function parseJson<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not return the expected JSON.");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export class Ai {
  private yagami: Yagami | null = null;
  private cached: AiStatus | null = null;
  private probing: Promise<AiStatus> | null = null;
  private streams = new Map<string, AsyncGenerator<MessageStreamEvent, void, undefined>>();
  private jobs: Job[] = [];
  private jobQueue: Array<{ job: Job; run: () => Promise<void> }> = [];
  private jobRunning = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly srs: Scheduler,
    private readonly knowledge: Knowledge,
  ) {}

  private client(): Yagami {
    this.yagami ??= new Yagami();
    return this.yagami;
  }

  // ── status ─────────────────────────────────────────────────────────────

  async status(refresh = false): Promise<AiStatus> {
    if (this.cached && !refresh) return this.cached;
    this.probing ??= (async (): Promise<AiStatus> => {
      try {
        if (refresh) this.yagami = null;
        const raw = await this.client().models.raw();
        const seen = new Set<string>();
        const models: AiModel[] = [];
        for (const m of raw) {
          if (!m.id.includes(":") || seen.has(m.id)) continue;
          seen.add(m.id);
          models.push({ id: m.id, label: m.display_name || m.id, provider: m.provider ?? m.id.split(":")[0]!, isDefault: !!m.is_default });
        }
        const status: AiStatus = models.length
          ? { available: true, reason: null, models }
          : { available: false, reason: "No signed-in coding-agent CLI was found. Install and sign in to Claude Code, Codex or another agent CLI.", models };
        this.cached = status;
        return status;
      } catch (error) {
        const status: AiStatus = { available: false, reason: error instanceof Error ? error.message : String(error), models: [] };
        this.cached = status;
        return status;
      } finally {
        this.probing = null;
      }
    })();
    return this.probing;
  }

  private model(background = false): string | undefined {
    const s = this.ctx.settings();
    return (background ? (s.backgroundModel ?? s.model) : s.model) ?? undefined;
  }

  // ── context ────────────────────────────────────────────────────────────

  private bookInfo(bookId: string): { title: string; author: string | null } {
    const b = this.ctx.db.prepare("select title, author from books where id = ?").get(bookId) as { title: string; author: string | null } | undefined;
    return b ?? { title: "this book", author: null };
  }

  /** The unit's text around `anchors`, about `budget` characters, the anchors marked. */
  private surrounding(unitId: number, anchors: number[], budget = 9000): string {
    const blocks = this.ctx.db
      .prepare("select id, type, level, label, coalesce(custom_text, text) as text from blocks where unit_id = ? order by ord")
      .all(unitId) as Array<{ id: number; type: string; level: number; label: string | null; text: string }>;
    if (!blocks.length) return "";
    const render = (b: (typeof blocks)[number]) => {
      const mark = anchors.includes(Number(b.id));
      let t = b.text;
      if (b.type === "heading") t = `${"#".repeat(Math.min(4, b.level + 1))} ${b.label ? `${b.label} ` : ""}${t}`;
      else if (b.type === "equation") t = `[display math: ${t}]`;
      else if (b.type === "figure") t = `[figure${t ? `: ${t.slice(0, 200)}` : ""}]`;
      else if (b.type === "table") t = `[table]\n${t}`;
      else if (b.type === "code") t = "```\n" + t + "\n```";
      else if (b.type === "footnote") t = `[footnote ${b.label ?? ""}] ${t}`;
      else if (b.type === "list") t = `${b.label ?? "•"} ${t}`;
      return mark ? `>>> ${t} <<<` : t;
    };
    let center = blocks.findIndex((b) => anchors.includes(Number(b.id)));
    if (center < 0) center = 0;
    const picked = new Set<number>([center]);
    let used = blocks[center]!.text.length;
    let lo = center - 1;
    let hi = center + 1;
    while (used < budget && (lo >= 0 || hi < blocks.length)) {
      if (lo >= 0) {
        picked.add(lo);
        used += blocks[lo]!.text.length;
        lo--;
      }
      if (hi < blocks.length && used < budget) {
        picked.add(hi);
        used += blocks[hi]!.text.length;
        hi++;
      }
    }
    // The chapter's opening heading always comes along, for orientation.
    picked.add(0);
    return [...picked]
      .sort((a, b) => a - b)
      .map((i, n, all) => (n > 0 && i !== all[n - 1]! + 1 ? `[…]\n\n${render(blocks[i]!)}` : render(blocks[i]!)))
      .join("\n\n");
  }

  private readerContext(bookId: string, unitId: number): string {
    const s = this.ctx.settings();
    const parts: string[] = [];
    const notes = this.ctx.db
      .prepare("select quote, note from highlights where unit_id = ? order by updated_at desc limit 14")
      .all(unitId) as Array<{ quote: string; note: string }>;
    if (notes.length)
      parts.push(
        `Passages the reader highlighted in this chapter${notes.some((n) => n.note) ? ", with their notes" : ""}:\n` +
          notes.map((n) => `- "${n.quote.slice(0, 220)}"${n.note ? ` — note: ${n.note.slice(0, 300)}` : ""}`).join("\n"),
      );
    const graph = this.knowledge.unit(unitId);
    const by = (state: string) =>
      graph.nodes
        .filter((n) => n.state === state)
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 18)
        .map((n) => n.name);
    const known = by("known");
    const learning = [...by("learning"), ...by("fading")];
    const unseen = by("unseen");
    const lines = [
      known.length ? `Knows well: ${known.join(", ")}` : null,
      learning.length ? `Still learning or forgetting: ${learning.join(", ")}` : null,
      unseen.length ? `Has not read about yet: ${unseen.join(", ")}` : null,
    ].filter(Boolean);
    if (lines.length) parts.push(`What the reader knows of this chapter's concepts:\n${lines.join("\n")}`);
    if (s.explanationStyle.trim()) parts.push(`How the reader likes things explained (follow this): ${s.explanationStyle.trim()}`);
    void bookId;
    return parts.join("\n\n");
  }

  private unitTitle(unitId: number): string {
    return (this.ctx.db.prepare("select title from sections where id = ?").get(unitId) as { title: string } | undefined)?.title ?? "";
  }

  // ── streaming ──────────────────────────────────────────────────────────

  private stream(
    streamId: string,
    req: { system: string; messages: Msg[]; background?: boolean },
    onDone: (text: string) => ChatMessage | undefined,
  ): void {
    const model = this.model(req.background);
    const gen = this.client().messages.stream({
      ...(model ? { model } : {}),
      system: req.system,
      messages: req.messages,
      max_tokens: 4096,
    });
    this.streams.set(streamId, gen);
    let text = "";
    void (async () => {
      try {
        for await (const ev of gen) {
          if (ev.type !== "content_block_delta") continue;
          const delta = (ev as { delta?: { type?: string; text?: string } }).delta;
          if (delta?.type === "text_delta" && delta.text) {
            text += delta.text;
            this.ctx.emit("ai.stream", { streamId, kind: "delta", text: delta.text });
          }
        }
        if (!this.streams.has(streamId)) return; // cancelled
        const message = onDone(text);
        this.ctx.emit("ai.stream", { streamId, kind: "done", text, ...(message ? { message } : {}) });
      } catch (error) {
        this.ctx.emit("ai.stream", { streamId, kind: "error", error: error instanceof Error ? error.message : String(error) });
      } finally {
        this.streams.delete(streamId);
      }
    })();
  }

  cancel(streamId: string): void {
    const gen = this.streams.get(streamId);
    this.streams.delete(streamId);
    // Ending the generator ends the CLI turn behind it.
    void gen?.return(undefined);
  }

  private complete(system: string, content: string, background = true): Promise<string> {
    const model = this.model(background);
    return this.client()
      .messages.create({ ...(model ? { model } : {}), system, messages: [{ role: "user", content }], max_tokens: 8192 })
      .then((r) =>
        r.content
          .filter((b) => b.type === "text")
          .map((b) => String((b as { text?: string }).text ?? ""))
          .join(""),
      );
  }

  // ── ask ────────────────────────────────────────────────────────────────

  ask(input: { threadId: number | null; bookId: string; message: string; context: ChatContext }): { threadId: number; streamId: string } {
    const db = this.ctx.db;
    const now = Date.now();
    const anchor = input.context.blockIds?.[0] ?? null;
    let threadId = input.threadId;
    if (threadId === null) {
      const title = (input.context.quote || input.message).replace(/\s+/g, " ").trim().slice(0, 80);
      threadId = Number(
        db.prepare("insert into chats (book_id, block_id, title, created_at, updated_at) values (?, ?, ?, ?, ?)").run(input.bookId, anchor, title, now, now)
          .lastInsertRowid,
      );
    }
    const thread = db.prepare("select * from chats where id = ?").get(threadId) as { block_id: number | null; book_id: string };
    db.prepare("insert into chat_messages (chat_id, role, content, quote, block_id, created_at) values (?, 'user', ?, ?, ?, ?)").run(
      threadId,
      input.message,
      input.context.quote ?? null,
      anchor,
      now,
    );
    db.prepare("update chats set updated_at = ? where id = ?").run(now, threadId);

    const anchorBlock = anchor ?? thread.block_id;
    const unitId =
      input.context.unitId ??
      (anchorBlock ? (db.prepare("select unit_id from blocks where id = ?").get(anchorBlock) as { unit_id: number } | undefined)?.unit_id : undefined);
    const book = this.bookInfo(input.bookId);
    let system = `${PERSONA}\n\nThe book: “${book.title}”${book.author ? ` by ${book.author}` : ""}.`;
    if (unitId) {
      const anchors = input.context.blockIds ?? (anchorBlock ? [anchorBlock] : []);
      system += `\n\nThe reader is in “${this.unitTitle(Number(unitId))}”. Here is the text around where they are reading; the passage they are looking at is marked >>> like this <<<.\n\n<chapter_text>\n${this.surrounding(Number(unitId), anchors)}\n</chapter_text>`;
      const reader = this.readerContext(input.bookId, Number(unitId));
      if (reader) system += `\n\n<reader>\n${reader}\n</reader>`;
    }
    const history = (db.prepare("select * from chat_messages where chat_id = ? order by id").all(threadId) as Array<Record<string, unknown>>).map(chatFromRow);
    const messages: Msg[] = history.slice(-16).map((m) => ({
      role: m.role,
      content: m.role === "user" && m.quote ? `About this passage:\n"""${m.quote}"""\n\n${m.content}` : m.content,
    }));
    while (messages.length && messages[0]!.role !== "user") messages.shift();

    const streamId = randomUUID();
    this.stream(streamId, { system, messages }, (text) => {
      if (!text.trim()) return undefined;
      const r = db
        .prepare("insert into chat_messages (chat_id, role, content, quote, block_id, created_at) values (?, 'assistant', ?, null, ?, ?)")
        .run(threadId, text, anchor, Date.now());
      db.prepare("update chats set updated_at = ? where id = ?").run(Date.now(), threadId);
      return chatFromRow(db.prepare("select * from chat_messages where id = ?").get(Number(r.lastInsertRowid)) as Record<string, unknown>);
    });
    return { threadId, streamId };
  }

  threads(bookId: string): ChatThread[] {
    const rows = this.ctx.db
      .prepare(
        `select c.*, (select count(*) from chat_messages m where m.chat_id = c.id) as n from chats c
         where c.book_id = ? order by c.updated_at desc`,
      )
      .all(bookId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r["id"]),
      bookId: String(r["book_id"]),
      blockId: r["block_id"] === null ? null : Number(r["block_id"]),
      title: String(r["title"]),
      createdAt: Number(r["created_at"]),
      updatedAt: Number(r["updated_at"]),
      messageCount: Number(r["n"]),
    }));
  }

  messages(threadId: number): ChatMessage[] {
    return (this.ctx.db.prepare("select * from chat_messages where chat_id = ? order by id").all(threadId) as Array<Record<string, unknown>>).map(chatFromRow);
  }

  removeThread(threadId: number): void {
    this.ctx.db.prepare("delete from chats where id = ?").run(threadId);
  }

  // ── rewrite ────────────────────────────────────────────────────────────

  rewrite(input: { blockId: number; instruction?: string; threadId?: number | null }): { streamId: string } {
    const db = this.ctx.db;
    const block = db.prepare("select id, book_id, unit_id, type, text, custom_text, ord from blocks where id = ?").get(input.blockId) as
      | { id: number; book_id: string; unit_id: number; type: string; text: string; custom_text: string | null; ord: number }
      | undefined;
    if (!block) throw new Error("That passage no longer exists.");
    const book = this.bookInfo(block.book_id);
    const neighbors = db
      .prepare(
        `select coalesce(custom_text, text) as text from blocks where unit_id = ? and type in ('paragraph', 'list', 'heading')
         and ord between ? and ? and id != ? order by ord`,
      )
      .all(block.unit_id, block.ord - 3, block.ord + 2, block.id) as Array<{ text: string }>;
    let explanation = "";
    if (input.threadId) {
      const last = db
        .prepare("select content from chat_messages where chat_id = ? and role = 'assistant' order by id desc limit 1")
        .get(input.threadId) as { content: string } | undefined;
      if (last) explanation = last.content;
    }
    const reader = this.readerContext(block.book_id, block.unit_id);
    const system = `You rewrite passages of a textbook for one particular reader, so that when they come back to this part of “${book.title}” it reads the way they understand best.

Rules:
- Keep every fact, definition, and claim of the original. Do not add new material beyond what makes the original clearer.
- Keep the book's notation. Write math in LaTeX between $…$.
- Plain prose. You may use **bold** for a key term and *italics* for emphasis. No headings, no preamble, no commentary.
- Roughly the original's length unless the reader asks otherwise.
- Reply with the rewritten passage and nothing else.`;
    const content = [
      `<book>${book.title}${book.author ? ` — ${book.author}` : ""}</book>`,
      `<chapter>${this.unitTitle(block.unit_id)}</chapter>`,
      neighbors.length ? `<nearby_text>\n${neighbors.map((n) => n.text).join("\n\n")}\n</nearby_text>` : "",
      `<passage>\n${block.custom_text ?? block.text}\n</passage>`,
      block.custom_text ? `<original_passage>\n${block.text}\n</original_passage>` : "",
      reader ? `<reader>\n${reader}\n</reader>` : "",
      explanation ? `<explanation_that_helped>\nThe reader asked about this passage and found this explanation helpful. Fold its insight into the rewrite:\n${explanation}\n</explanation_that_helped>` : "",
      `Rewrite the passage${input.instruction?.trim() ? `, and: ${input.instruction.trim()}` : "."}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const streamId = randomUUID();
    this.stream(streamId, { system, messages: [{ role: "user", content }] }, () => undefined);
    return { streamId };
  }

  // ── cards ──────────────────────────────────────────────────────────────

  async suggestCard(input: { bookId: string; blockId: number; quote: string }): Promise<{ front: string; back: string; kind: CardKind }> {
    const block = this.ctx.db.prepare("select coalesce(custom_text, text) as text, unit_id from blocks where id = ?").get(input.blockId) as
      | { text: string; unit_id: number }
      | undefined;
    const reply = await this.complete(
      `You write one excellent spaced-repetition flashcard. Atomic: one idea. Precise wording; the answer should be unambiguous from the question. Prefer a question that tests understanding over one that tests wording. Use LaTeX in $…$ for math. Reply with JSON only: {"kind":"basic","front":"…","back":"…"} — or, when the passage is a definition or a key term best learned in context, {"kind":"cloze","front":"sentence with the key part as {{c1::hidden part}}","back":"optional extra context"}.`,
      `Book: ${this.bookInfo(input.bookId).title}\nChapter: ${block ? this.unitTitle(block.unit_id) : ""}\n\nParagraph:\n${block?.text ?? ""}\n\nThe reader selected this to remember:\n"""${input.quote}"""`,
      false,
    );
    const card = parseJson<{ kind?: string; front?: string; back?: string }>(reply);
    if (!card.front) throw new Error("The model did not write a card.");
    return { kind: card.kind === "cloze" && /\{\{c1::/.test(card.front) ? "cloze" : "basic", front: card.front.trim(), back: (card.back ?? "").trim() };
  }

  generateCards(bookId: string, unitId: number): { jobId: string } {
    return this.enqueue(bookId, `Writing cards for “${this.unitTitle(unitId)}”`, async () => {
      const db = this.ctx.db;
      const blocks = db
        .prepare("select id, type, coalesce(custom_text, text) as text from blocks where unit_id = ? and type in ('paragraph', 'list', 'caption', 'heading', 'code', 'equation') order by ord")
        .all(unitId) as Array<{ id: number; type: string; text: string }>;
      const text = this.unitText(blocks, 26000);
      if (text.length < 400) return;
      const existing = db.prepare("select front from cards where unit_id = ?").all(unitId) as Array<{ front: string }>;
      const reply = await this.complete(
        `You write flashcards for spaced repetition (FSRS) from a textbook chapter. Good cards are atomic (one idea each), precise, and test understanding — why and how, not just what — while still covering the key definitions, results and procedures. Avoid trivia, avoid cards answerable without reading the chapter, avoid duplicates of the existing cards. Use the book's notation; LaTeX in $…$ for math.

Reply with JSON only:
{"cards":[{"kind":"basic","front":"question","back":"answer","quote":"5 to 15 words copied exactly from the chapter where this is taught"},
          {"kind":"cloze","front":"A sentence where the key part is {{c1::hidden}}.","back":"","quote":"…"}]}`,
        `Book: ${this.bookInfo(bookId).title}\nChapter: ${this.unitTitle(unitId)}\n\nExisting cards (do not repeat):\n${existing.map((c) => `- ${c.front.slice(0, 140)}`).join("\n") || "(none)"}\n\nWrite 6 to 14 cards for this chapter:\n\n${text}`,
      );
      const parsed = parseJson<{ cards?: Array<{ kind?: string; front?: string; back?: string; quote?: string }> }>(reply);
      const unitRead = this.unitRead(unitId);
      const matcher = this.bookMatcher(bookId);
      const seen = new Set(existing.map((c) => squash(c.front)));
      let made = 0;
      tx(db, () => {
        for (const c of parsed.cards ?? []) {
          const front = (c.front ?? "").trim();
          if (!front || seen.has(squash(front))) continue;
          const kind: CardKind = c.kind === "cloze" && /\{\{c1::/.test(front) ? "cloze" : "basic";
          if (kind === "basic" && !(c.back ?? "").trim()) continue;
          seen.add(squash(front));
          const blockId = this.findQuote(blocks, c.quote ?? "") ?? blocks.find((b) => b.type === "paragraph")?.id ?? null;
          const card = this.srs.create({
            bookId,
            blockId,
            kind,
            front,
            back: (c.back ?? "").trim(),
            source: "ai",
            status: unitRead ? "active" : "pending",
          });
          for (const [id] of matcher.match(`${front} ${c.back ?? ""}`))
            db.prepare("insert into card_concepts (card_id, concept_id) values (?, ?) on conflict do nothing").run(card.id, id);
          made++;
        }
      });
      db.prepare("insert into unit_jobs (unit_id, job, at) values (?, 'cards', ?) on conflict do update set at = excluded.at").run(unitId, Date.now());
      if (made) this.ctx.emit("cards.changed", { bookId });
    });
  }

  // ── concepts ───────────────────────────────────────────────────────────

  mapConcepts(bookId: string, unitId: number): { jobId: string } {
    return this.enqueue(bookId, `Mapping concepts in “${this.unitTitle(unitId)}”`, async () => {
      const db = this.ctx.db;
      const blocks = db
        .prepare("select id, type, coalesce(custom_text, text) as text from blocks where unit_id = ? and type in ('paragraph', 'list', 'caption', 'heading') order by ord")
        .all(unitId) as Array<{ id: number; type: string; text: string }>;
      const text = this.unitText(blocks, 26000);
      if (text.length < 400) return;
      const known = db
        .prepare("select c.name from concept_books cb join concepts c on c.id = cb.concept_id where cb.book_id = ? order by cb.importance desc limit 120")
        .all(bookId) as Array<{ name: string }>;
      const reply = await this.complete(
        `You map the concepts a textbook chapter teaches and how they depend on each other, for a learner's knowledge map. Concepts are things a student could know or not know: ideas, definitions, results, techniques — named the way the book names them, in lower case unless a proper noun. Relations are directed where it matters: "prerequisite" (from must be understood before to), "part-of", "example-of", "generalizes", "contrasts", or "related".

Reply with JSON only:
{"concepts":[{"name":"…","definition":"one sentence, in the book's terms","importance":1-5}],
 "relations":[{"from":"…","to":"…","type":"prerequisite","strength":0.1-1}]}`,
        `Book: ${this.bookInfo(bookId).title}\nChapter: ${this.unitTitle(unitId)}\n\nConcepts already on the map for this book (reuse these names when you mean them; relate to them where it fits):\n${known.map((k) => k.name).join(", ") || "(none)"}\n\nGive the chapter's 8 to 20 most important concepts and the relations between them (and to concepts already on the map):\n\n${text}`,
      );
      const parsed = parseJson<{
        concepts?: Array<{ name?: string; definition?: string; importance?: number }>;
        relations?: Array<{ from?: string; to?: string; type?: string; strength?: number }>;
      }>(reply);
      const now = Date.now();
      const ids = new Map<string, number>();
      tx(db, () => {
        for (const c of parsed.concepts ?? []) {
          const name = (c.name ?? "").trim().slice(0, 80);
          const key = termKey(name);
          if (!key || key.length < 2) continue;
          db.prepare("insert into concepts (key, name, created_at) values (?, ?, ?) on conflict(key) do nothing").run(key, name, now);
          const id = Number((db.prepare("select id from concepts where key = ?").get(key) as { id: number }).id);
          ids.set(key, id);
          const importance = Math.max(0.15, Math.min(1, (Number(c.importance) || 3) / 5));
          db.prepare(
            `insert into concept_books (concept_id, book_id, importance, definition, source) values (?, ?, ?, ?, 'ai')
             on conflict(concept_id, book_id) do update set importance = max(importance, excluded.importance),
               definition = coalesce(definition, excluded.definition)`,
          ).run(id, bookId, importance, (c.definition ?? "").trim() || null);
        }
        // Place the new concepts in the book: every readable block that names them.
        const matcher = new TermMatcher();
        for (const [key, id] of ids) matcher.add(key, id);
        const all = db
          .prepare(
            `select b.id, b.unit_id, coalesce(b.custom_text, b.text) as text from blocks b join sections u on u.id = b.unit_id
             where b.book_id = ? and u.kind in ('body', 'exercises') and b.type in ('paragraph', 'list', 'caption', 'heading', 'footnote')`,
          )
          .all(bookId) as Array<{ id: number; unit_id: number; text: string }>;
        const put = db.prepare(
          "insert into mentions (concept_id, block_id, book_id, unit_id, count, is_def) values (?, ?, ?, ?, ?, 0) on conflict do nothing",
        );
        for (const b of all) for (const [id, n] of matcher.match(b.text)) put.run(id, b.id, bookId, b.unit_id, n);
        const idOf = (name: string) => {
          const key = termKey(name);
          return ids.get(key) ?? (db.prepare("select id from concepts where key = ?").get(key) as { id: number } | undefined)?.id;
        };
        for (const r of parsed.relations ?? []) {
          const a = idOf(r.from ?? "");
          const b = idOf(r.to ?? "");
          if (a === undefined || b === undefined || a === b) continue;
          const weight = Math.max(0.1, Math.min(1, Number(r.strength) || 0.5));
          const label = (r.type ?? "related").slice(0, 30);
          // Stored low id first; a directed label says which way it runs.
          const [x, y, l] = Number(a) < Number(b) ? [a, b, label] : [b, a, label === "related" || label === "contrasts" ? label : `${label}←`];
          db.prepare(
            `insert into edges (a, b, book_id, weight, kind, label) values (?, ?, ?, ?, 'ai', ?)
             on conflict(a, b, book_id, kind) do update set weight = max(weight, excluded.weight), label = excluded.label`,
          ).run(x, y, bookId, weight, l);
        }
      });
      db.prepare("insert into unit_jobs (unit_id, job, at) values (?, 'concepts', ?) on conflict do update set at = excluded.at").run(unitId, Date.now());
      this.ctx.emit("knowledge.changed", { bookId });
    });
  }

  /** A chapter was just finished: run whichever of its AI jobs are on and have not run. */
  async onUnitRead(bookId: string, unitId: number): Promise<void> {
    const s = this.ctx.settings();
    if (!s.aiCards && !s.aiConcepts) return;
    const status = await this.status();
    if (!status.available) return;
    const kind = (this.ctx.db.prepare("select kind from sections where id = ?").get(unitId) as { kind: string } | undefined)?.kind;
    if (kind !== "body" && kind !== "exercises") return;
    const done = new Set(
      (this.ctx.db.prepare("select job from unit_jobs where unit_id = ?").all(unitId) as Array<{ job: string }>).map((r) => r.job),
    );
    if (s.aiConcepts && !done.has("concepts")) this.mapConcepts(bookId, unitId);
    if (s.aiCards && !done.has("cards")) this.generateCards(bookId, unitId);
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private unitText(blocks: Array<{ type: string; text: string }>, budget: number): string {
    let out = "";
    for (const b of blocks) {
      const t = b.type === "heading" ? `\n## ${b.text}\n` : b.type === "equation" ? `[math: ${b.text}]` : b.type === "code" ? "```\n" + b.text + "\n```" : b.text;
      if (out.length + t.length > budget) break;
      out += `${t}\n\n`;
    }
    return out.trim();
  }

  private unitRead(unitId: number): boolean {
    const r = this.ctx.db
      .prepare(
        `select s.weight as weight, (select coalesce(sum(b.weight), 0) from reads r join blocks b on b.id = r.block_id where r.unit_id = s.id) as read
         from sections s where s.id = ?`,
      )
      .get(unitId) as { weight: number; read: number } | undefined;
    return !!r && (Number(r.weight) === 0 || Number(r.read) / Number(r.weight) >= UNIT_DONE);
  }

  private findQuote(blocks: Array<{ id: number; text: string }>, quote: string): number | null {
    const q = squash(quote);
    if (q.length < 8) return null;
    for (const b of blocks) if (squash(b.text).includes(q)) return Number(b.id);
    // Models paraphrase a little; settle for the block sharing the most words.
    const words = new Set(q.split(" ").filter((w) => w.length > 3));
    let best: number | null = null;
    let score = 0;
    for (const b of blocks) {
      const ws = squash(b.text).split(" ");
      let n = 0;
      for (const w of ws) if (words.has(w)) n++;
      if (n > score) [best, score] = [Number(b.id), n];
    }
    return score >= Math.min(3, words.size) ? best : null;
  }

  private bookMatcher(bookId: string): TermMatcher {
    const m = new TermMatcher();
    const rows = this.ctx.db
      .prepare("select c.id, c.key from concept_books cb join concepts c on c.id = cb.concept_id where cb.book_id = ?")
      .all(bookId) as Array<{ id: number; key: string }>;
    for (const r of rows) m.add(r.key, Number(r.id));
    return m;
  }

  // ── jobs ───────────────────────────────────────────────────────────────

  listJobs(): Job[] {
    return this.jobs.slice(-20);
  }

  private enqueue(bookId: string, label: string, run: () => Promise<void>): { jobId: string } {
    const job: Job = { id: randomUUID(), bookId, label, progress: null, state: "running" };
    this.jobs.push(job);
    this.jobQueue.push({ job, run });
    this.ctx.emit("jobs.changed", job);
    void this.pump();
    return { jobId: job.id };
  }

  private async pump(): Promise<void> {
    if (this.jobRunning) return;
    const next = this.jobQueue.shift();
    if (!next) return;
    this.jobRunning = true;
    try {
      await next.run();
      next.job.state = "done";
    } catch (error) {
      next.job.state = "error";
      next.job.error = error instanceof Error ? error.message : String(error);
    }
    this.ctx.emit("jobs.changed", { ...next.job });
    this.jobRunning = false;
    void this.pump();
  }
}
