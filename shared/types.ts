/**
 * apprentice's domain, as every process sees it. The main process stores
 * these, the ingest worker produces them, the renderer draws them; nothing
 * here touches I/O.
 */

export type BookStatus = "importing" | "ready" | "error";

export interface Book {
  id: string;
  title: string;
  author: string | null;
  pageCount: number;
  status: BookStatus;
  /** Import progress, 0..1, while `status` is "importing". */
  importProgress: number;
  importStage: string | null;
  error: string | null;
  addedAt: number;
  openedAt: number | null;
  /** apprentice:// URL of the first page, rendered at import. */
  cover: string | null;
  /** Share of the book's readable text that has been read, 0..1. */
  readFraction: number;
  dueCards: number;
  totalCards: number;
  conceptCount: number;
  unitCount: number;
  /** Total reading time recorded in this book, in milliseconds. */
  timeMs: number;
  /** The book's body text size in points; figures scale by reader size ÷ this. */
  bodySize: number;
}

/**
 * What a section is for. Only `body` counts toward progress and feeds the
 * knowledge map; a table of contents or an index is text, but reading it is
 * not studying.
 */
export type SectionKind = "body" | "front" | "contents" | "index" | "bibliography" | "exercises";

export interface Section {
  id: number;
  parentId: number | null;
  /** The reading unit (chapter) this section is drawn in. Units point at themselves. */
  unitId: number;
  level: number;
  title: string;
  page: number;
  /** The heading block that opens the section, when it has one. */
  blockId: number | null;
  kind: SectionKind;
  isUnit: boolean;
  /** For units: share read, 0..1. */
  readFraction: number;
  /** For units: readable weight (characters), used to size progress. */
  weight: number;
}

export type BlockType =
  | "heading"
  | "paragraph"
  | "list"
  | "code"
  | "equation"
  | "figure"
  | "table"
  | "caption"
  | "footnote"
  | "quote";

/** Inline styling over a range of a block's text. */
export interface Mark {
  /** Start offset (UTF-16 code units), inclusive. */
  s: number;
  /** End offset, exclusive. */
  e: number;
  /** Bitwise OR of `MarkFlag`. */
  f: number;
  /** For a footnote reference: the footnote block's id. */
  ref?: number;
}

export const MarkFlag = {
  BOLD: 1,
  ITALIC: 2,
  MONO: 4,
  SUP: 8,
  SUB: 16,
  MATH: 32,
} as const;

export interface CustomText {
  text: string;
  source: "user" | "ai";
  at: number;
}

export interface Block {
  id: number;
  unitId: number;
  sectionId: number;
  ord: number;
  type: BlockType;
  /** Heading level (1 = chapter), or list nesting depth. */
  level: number;
  /** The text as the book printed it. Images carry their extracted text here, for search and context. */
  text: string;
  marks: Mark[];
  /** Zero-based page index in the source PDF. */
  page: number;
  /** File name of the block's image (figure, equation, table), under the book's asset folder. */
  asset: string | null;
  /** Asset size in CSS pixels at 1×, so the layout never jumps while it loads. */
  width: number;
  height: number;
  /** Nonzero when the block sits in a boxed callout; blocks sharing it share a box. */
  boxed: number;
  /** A footnote's marker, a list item's bullet, a heading's number. */
  label: string | null;
  /** The reader's own version of this block, when they have one. */
  custom: CustomText | null;
}

export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "purple";
export const HIGHLIGHT_COLORS: HighlightColor[] = ["yellow", "green", "blue", "pink", "purple"];

export interface Highlight {
  id: number;
  bookId: string;
  blockId: number;
  unitId: number;
  /** Offsets into the block's displayed text (custom text when the block has one). */
  start: number;
  end: number;
  /** The highlighted words, kept so the mark can find its place again if the text changes. */
  quote: string;
  /** Which text the offsets index: the book's or the reader's own. */
  onCustom: boolean;
  color: HighlightColor;
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type SketchTool = "pen" | "marker" | "line" | "arrow" | "rect" | "ellipse" | "text";

export interface Stroke {
  id: string;
  tool: SketchTool;
  color: string;
  size: number;
  /** Flat [x, y, pressure, x, y, pressure, …] in sketch coordinates. */
  points: number[];
  text?: string;
}

export interface SketchData {
  version: 1;
  strokes: Stroke[];
}

export interface Sketch {
  id: number;
  bookId: string;
  blockId: number | null;
  unitId: number | null;
  title: string;
  data: SketchData;
  /** Rendered SVG of the sketch, for thumbnails. */
  svg: string;
  createdAt: number;
  updatedAt: number;
}

export type CardKind = "basic" | "cloze";
/** pending: waiting for its chapter to be read. active: in the review rotation. */
export type CardStatus = "pending" | "active" | "suspended";
export type CardSource = "auto" | "ai" | "user";

export interface Card {
  id: number;
  bookId: string;
  blockId: number | null;
  unitId: number | null;
  kind: CardKind;
  /** basic: the question. cloze: the text with {{c1::answer}} gaps. */
  front: string;
  /** basic: the answer. cloze: optional extra shown after reveal. */
  back: string;
  source: CardSource;
  status: CardStatus;
  due: number;
  /** FSRS state: 0 new, 1 learning, 2 review, 3 relearning. */
  state: number;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  lastReview: number | null;
  createdAt: number;
}

export type Rating = 1 | 2 | 3 | 4;

export interface CardWithContext extends Card {
  bookTitle: string;
  /** The unit (chapter) title the card came from. */
  unitTitle: string | null;
  /** Due-date preview for each rating. */
  preview: Record<Rating, { due: number; label: string }>;
}

export interface ReviewQueue {
  cards: CardWithContext[];
  dueCount: number;
  newCount: number;
  reviewedToday: number;
}

export interface CardStats {
  total: number;
  active: number;
  pending: number;
  due: number;
  newCards: number;
  reviewedToday: number;
  /** Mean retrievability of reviewed cards, 0..1, or null before any review. */
  retention: number | null;
  /** Due counts for the next 14 days, today first. */
  forecast: number[];
}

export type ConceptState = "unseen" | "seen" | "learning" | "known" | "fading";

export interface Concept {
  id: number;
  name: string;
  definition: string | null;
  /** How central the concept is to the books it appears in, 0..1. */
  importance: number;
  /** Combined estimate of how well it is known, 0..1. */
  mastery: number;
  /** Share of its mentions the reader has read, 0..1. */
  exposure: number;
  /** Mean retrievability of its cards, or null with no reviewed cards. */
  recall: number | null;
  state: ConceptState;
  mentions: number;
  cards: number;
  bookIds: string[];
}

export interface ConceptEdge {
  a: number;
  b: number;
  /** Strength, 0..1. */
  weight: number;
  kind: "cooccur" | "ai";
  label: string | null;
}

export interface KnowledgeGraph {
  nodes: Concept[];
  edges: ConceptEdge[];
}

export interface ConceptMention {
  bookId: string;
  bookTitle: string;
  blockId: number;
  unitId: number;
  unitTitle: string;
  snippet: string;
  isDefinition: boolean;
  read: boolean;
}

export interface ConceptDetail {
  concept: Concept;
  mentions: ConceptMention[];
  cards: Card[];
  neighbors: Array<{ concept: Concept; weight: number; label: string | null }>;
}

export interface ChatThread {
  id: number;
  bookId: string;
  blockId: number | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface ChatMessage {
  id: number;
  threadId: number;
  role: "user" | "assistant";
  content: string;
  /** The passage the question was about, when it was asked from a selection. */
  quote: string | null;
  blockId: number | null;
  createdAt: number;
}

export interface SearchHit {
  bookId: string;
  bookTitle: string;
  blockId: number;
  unitId: number;
  unitTitle: string;
  /** Snippet with matches wrapped in \u0001 … \u0002. */
  snippet: string;
}

export interface ReadingPosition {
  unitId: number;
  blockId: number | null;
  /** Pixels scrolled past the top of that block. */
  offset: number;
}

export interface UnitContent {
  unitId: number;
  blocks: Block[];
  highlights: Highlight[];
  /** Block ids already read. */
  read: number[];
  sketches: Array<Pick<Sketch, "id" | "blockId" | "title" | "svg" | "updatedAt">>;
  /** Cards drawn from this unit, by status. */
  cards: { pending: number; active: number };
  /** Block ids with an attached chat thread. */
  chats: number[];
}

export interface OpenedBook {
  book: Book;
  sections: Section[];
  position: ReadingPosition | null;
}

export interface AiModel {
  id: string;
  label: string;
  provider: string;
  isDefault: boolean;
}

export interface AiStatus {
  available: boolean;
  /** Why it is not, when it is not. */
  reason: string | null;
  models: AiModel[];
}

export type ThemeName = "light" | "sepia" | "dark" | "system";

export interface Settings {
  theme: ThemeName;
  readerFont: "serif" | "sans";
  fontSize: number;
  lineHeight: number;
  /** Reading column width in `ch`. */
  measure: number;
  /** yagami model id; null means yagami's default. */
  model: string | null;
  /** Model for background work (cards, concepts); null means `model`. */
  backgroundModel: string | null;
  /** Write cards with AI when a chapter is finished. */
  aiCards: boolean;
  /** Map a chapter's concepts with AI when it is finished. */
  aiConcepts: boolean;
  /** After an explanation, offer to rewrite the passage around it. */
  offerRewrites: boolean;
  /** Free text: how the reader likes things explained. Given to every AI request. */
  explanationStyle: string;
  desiredRetention: number;
  newCardsPerDay: number;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  readerFont: "serif",
  fontSize: 19,
  lineHeight: 1.65,
  measure: 68,
  model: null,
  backgroundModel: null,
  aiCards: true,
  aiConcepts: true,
  offerRewrites: true,
  explanationStyle: "",
  desiredRetention: 0.9,
  newCardsPerDay: 30,
};

export interface Job {
  id: string;
  bookId: string | null;
  label: string;
  /** 0..1, or null when indeterminate. */
  progress: number | null;
  state: "running" | "done" | "error";
  error?: string;
}
