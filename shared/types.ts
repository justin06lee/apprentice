/**
 * apprentice's domain, as every process sees it. The main process stores
 * these, the ingest worker produces them, the renderer draws them; nothing
 * here touches I/O.
 */

import type { Trim } from "./pages.js";

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
  /** Zero-based page the section starts on. */
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

export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "purple";
export const HIGHLIGHT_COLORS: HighlightColor[] = ["yellow", "green", "blue", "pink", "purple"];

/**
 * A stretch of a page: offsets into its text layer (shared/pages.ts), and
 * the words, so it can find its place again if the layer ever changes.
 */
export interface Passage {
  page: number;
  start: number;
  end: number;
  quote: string;
}

export interface Highlight extends Passage {
  id: number;
  bookId: string;
  /** The block the highlight falls in, when the import found one: how it knows its chapter. */
  blockId: number | null;
  unitId: number | null;
  color: HighlightColor;
  note: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * The reader's own version of a passage — written by hand or by a model.
 * It never replaces the book's text: it is laid over the passage on the
 * page like a slip of paper, and lifting it shows the book again.
 */
export interface Version extends Passage {
  id: number;
  bookId: string;
  text: string;
  source: "user" | "ai";
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
  /** The page it is pinned to, and where on it (points from the top), or null for a loose sketch. */
  page: number | null;
  y: number | null;
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
  /** The page it was made from, for going back to it. */
  page: number | null;
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
  page: number;
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
  /** The page it began on. */
  page: number | null;
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
  /** Where that passage is; start and end are null for a whole region or page. */
  page: number | null;
  start: number | null;
  end: number | null;
  createdAt: number;
}

export interface SearchHit {
  bookId: string;
  bookTitle: string;
  blockId: number;
  unitId: number;
  page: number;
  unitTitle: string;
  /** Snippet with matches wrapped in \u0001 … \u0002. */
  snippet: string;
}

export interface ReadingPosition {
  /** The page last open (the left one of a spread). */
  page: number;
}

export interface OpenedBook {
  book: Book;
  sections: Section[];
  position: ReadingPosition | null;
  /** Every page's size in points, so the book is laid out before a page is drawn. */
  sizes: Array<[number, number]>;
  /** Where its pages are printed, for trimming the margins; null when that could not be told. */
  trim: Trim | null;
}

/** Everything the reader has left in a book, loaded once when it opens. */
export interface Annotations {
  highlights: Highlight[];
  versions: Version[];
  /** Sketches pinned to a page. */
  sketches: Array<{ id: number; page: number; y: number; title: string }>;
  /** Where conversations began, for the margin. */
  chats: Array<{ id: number; page: number; start: number | null }>;
  /** Pages already read. */
  read: number[];
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

export type PageLayout = "auto" | "spread" | "single";

export interface Settings {
  theme: ThemeName;
  /** Two pages side by side, one at a time, or two when the window is wide enough. */
  pageLayout: PageLayout;
  /** Pages larger than fitting the window, as a factor of fitting it. */
  pageZoom: number;
  /** Turn pages with a page-turn, rather than at once. */
  pageTurn: boolean;
  /** In the Night theme, darken the pages too. */
  nightPages: boolean;
  /** Show the printed part of each page, without most of its blank margin. */
  pageTrim: boolean;
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
  pageLayout: "auto",
  pageZoom: 1,
  pageTurn: true,
  nightPages: true,
  pageTrim: true,
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
