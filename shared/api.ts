/**
 * Everything the window can ask of the main process, in one shape.
 *
 * Main implements `Api` as plain functions; the renderer calls the same
 * paths through a proxy (`api.books.list()`), every call crossing as one
 * IPC invoke named by its dotted path. Events go the other way, named in
 * `Events`.
 */
import type { PageText, Rect } from "./pages.js";
import type {
  AiStatus,
  Annotations,
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
  Passage,
  Rating,
  ReadingPosition,
  ReviewQueue,
  SearchHit,
  Settings,
  Sketch,
  SketchData,
  Version,
} from "./types.js";

export interface HighlightRow extends Highlight {
  unitTitle: string;
}

export interface ChatContext {
  /** The passage the question is about, when there was a selection. */
  passage?: Passage;
  /** A region of a page to look at — a figure, an equation — when one was drawn. */
  region?: { page: number; rect: Rect };
  /** The pages open in front of the reader, for what "this" means without a selection. */
  pages?: number[];
}

export interface ReadResult {
  /** Chapters whose read share changed. */
  units: Array<{ unitId: number; readFraction: number }>;
  /** Cards that just joined the reviews. */
  unlocked: number;
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
    /** A page's text layer: its lines and where each character sits. */
    pageText(bookId: string, page: number): PageText;
    /** Everything the reader has left in the book. Places marks made on the old reflowed text the first time. */
    annotations(bookId: string): Annotations;
    savePosition(bookId: string, position: ReadingPosition): void;
    /** Pages that have been open long enough to count as read. */
    readPages(bookId: string, reads: Array<{ page: number; dwellMs: number }>): ReadResult;
    /** Mark a whole unit read (or unread). */
    markUnit(bookId: string, unitId: number, read: boolean): ReadResult;
    addTime(bookId: string, ms: number): void;
    search(query: string, bookId: string | null): SearchHit[];
    /** Where a block is: its book, chapter, page and box on the page, for jumping to it. */
    locate(blockId: number): { bookId: string; unitId: number; page: number; box: Rect | null } | null;
  };
  versions: {
    /** Write (or rewrite) the reader's own version of a passage. */
    save(input: { id?: number; bookId: string; page: number; start: number; end: number; quote: string; text: string; source: "user" | "ai" }): Version;
    remove(id: number): void;
  };
  highlights: {
    add(input: { bookId: string; page: number; start: number; end: number; quote: string; color: HighlightColor; note?: string }): Highlight;
    update(id: number, patch: { color?: HighlightColor; note?: string }): Highlight;
    remove(id: number): void;
    list(bookId: string): HighlightRow[];
  };
  sketches: {
    list(bookId: string): Sketch[];
    get(id: number): Sketch;
    save(input: { id?: number; bookId: string; page: number | null; y: number | null; title: string; data: SketchData; svg: string }): Sketch;
    remove(id: number): void;
  };
  cards: {
    queue(bookId: string | null, limit?: number): ReviewQueue;
    review(cardId: number, rating: Rating, durationMs: number): Card;
    undo(cardId: number): Card | null;
    create(input: { bookId: string; page: number | null; kind: CardKind; front: string; back: string }): Card;
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
    /** Write the reader a version of a passage. Streams as `ai.stream`. */
    rewrite(input: { bookId: string; passage: Passage; instruction?: string; threadId?: number | null }): { streamId: string };
    cancel(streamId: string): void;
    generateCards(bookId: string, unitId: number): { jobId: string };
    mapConcepts(bookId: string, unitId: number): { jobId: string };
    /** Turn a passage into a card with a model (selection → card). `context` is the paragraph around it. */
    suggestCard(input: { bookId: string; page: number | null; quote: string; context: string }): { front: string; back: string; kind: CardKind };
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
