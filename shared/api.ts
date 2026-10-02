/**
 * Everything the window can ask of the main process, in one shape.
 *
 * Main implements `Api` as plain functions; the renderer calls the same
 * paths through a proxy (`api.books.list()`), every call crossing as one
 * IPC invoke named by its dotted path. Events go the other way, named in
 * `Events`.
 */
import type {
  AiStatus,
  Block,
  Book,
  Card,
  CardKind,
  CardStats,
  ChatMessage,
  ChatThread,
  ConceptDetail,
  Highlight,
  HighlightColor,
  Job,
  KnowledgeGraph,
  OpenedBook,
  Rating,
  ReadingPosition,
  ReviewQueue,
  SearchHit,
  Settings,
  Sketch,
  SketchData,
  UnitContent,
} from "./types.js";

export interface HighlightRow extends Highlight {
  unitTitle: string;
  /** The block's text around the highlight, for the notes list. */
  context: string;
}

export interface ChatContext {
  /** Blocks the question is about (a selection may span several). */
  blockIds?: number[];
  /** The selected words, when there was a selection. */
  quote?: string;
  /** The unit the reader is in, for surrounding context. */
  unitId?: number;
}

export interface Api {
  books: {
    list(): Book[];
    /** Opens the file picker when no paths are given. Returns the ids of the books imported (or already present). */
    import(paths?: string[]): string[];
    open(bookId: string): OpenedBook;
    remove(bookId: string): void;
    rename(bookId: string, title: string): void;
    reveal(bookId: string): void;
    retry(bookId: string): void;
  };
  reader: {
    unit(bookId: string, unitId: number): UnitContent;
    savePosition(bookId: string, position: ReadingPosition): void;
    /** Blocks that have been on screen long enough to count as read. Returns the unit's new read fraction. */
    markRead(bookId: string, unitId: number, reads: Array<{ blockId: number; dwellMs: number }>): { readFraction: number; unlocked: number };
    /** Mark a whole unit read (or unread). */
    markUnit(bookId: string, unitId: number, read: boolean): { readFraction: number; unlocked: number };
    addTime(bookId: string, ms: number): void;
    search(query: string, bookId: string | null): SearchHit[];
    /** Where a block is: its unit, for jumping to it. */
    locate(blockId: number): { bookId: string; unitId: number } | null;
    /** Page size in points, for the page view. */
    pageSizes(bookId: string): Array<[number, number]>;
  };
  blocks: {
    /** Replace a block's text with the reader's own; null restores the book's. */
    edit(blockId: number, text: string | null, source?: "user" | "ai"): Block;
  };
  highlights: {
    add(input: { bookId: string; blockId: number; start: number; end: number; quote: string; color: HighlightColor; note?: string }): Highlight;
    update(id: number, patch: { color?: HighlightColor; note?: string }): Highlight;
    remove(id: number): void;
    list(bookId: string): HighlightRow[];
  };
  sketches: {
    list(bookId: string): Sketch[];
    get(id: number): Sketch;
    save(input: { id?: number; bookId: string; blockId: number | null; unitId: number | null; title: string; data: SketchData; svg: string }): Sketch;
    remove(id: number): void;
  };
  cards: {
    queue(bookId: string | null, limit?: number): ReviewQueue;
    review(cardId: number, rating: Rating, durationMs: number): Card;
    undo(cardId: number): Card | null;
    create(input: { bookId: string; blockId: number | null; kind: CardKind; front: string; back: string }): Card;
    update(id: number, patch: { front?: string; back?: string; status?: "active" | "suspended" }): Card;
    remove(id: number): void;
    list(bookId: string, unitId?: number | null): Card[];
    stats(bookId: string | null): CardStats;
  };
  knowledge: {
    graph(bookId: string | null): KnowledgeGraph;
    concept(conceptId: number): ConceptDetail;
    /** Concepts mentioned in a unit, with what is known of them. */
    unit(unitId: number): KnowledgeGraph;
  };
  ai: {
    status(refresh?: boolean): AiStatus;
    /** Ask about the book. Returns at once; the answer streams as `ai.stream` events. */
    ask(input: { threadId: number | null; bookId: string; message: string; context: ChatContext }): { threadId: number; streamId: string };
    /** Write the reader a version of a block. Streams as `ai.stream`. */
    rewrite(input: { blockId: number; instruction?: string; threadId?: number | null }): { streamId: string };
    cancel(streamId: string): void;
    generateCards(bookId: string, unitId: number): { jobId: string };
    mapConcepts(bookId: string, unitId: number): { jobId: string };
    /** Turn a passage into a card with a model (selection → card). */
    suggestCard(input: { bookId: string; blockId: number; quote: string }): { front: string; back: string; kind: CardKind };
  };
  chats: {
    list(bookId: string): ChatThread[];
    messages(threadId: number): ChatMessage[];
    remove(threadId: number): void;
  };
  settings: {
    get(): Settings;
    set(patch: Partial<Settings>): Settings;
  };
  jobs: {
    list(): Job[];
  };
}

export interface AiStreamEvent {
  streamId: string;
  kind: "delta" | "done" | "error";
  text?: string;
  error?: string;
  /** On done: the saved assistant message, for chats. */
  message?: ChatMessage;
}

export interface Events {
  "books.changed": Book;
  "books.removed": { id: string };
  "ai.stream": AiStreamEvent;
  "cards.changed": { bookId: string | null };
  "knowledge.changed": { bookId: string };
  "jobs.changed": Job;
  "app.open": { bookId: string };
}

/** `Api` with every function returning a promise, as the renderer sees it. */
export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : Remote<T[K]>;
};
