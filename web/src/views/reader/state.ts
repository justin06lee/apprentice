/**
 * The open book: which page is in front of the reader, what they have left
 * on its pages, and the tools around it. One store, reset whenever a book
 * opens, so the pages, the contents and the side panel all see the same
 * thing. The book view (Book.tsx) decides how the page is shown — which
 * spread, how big, the turn that gets there; everything else just names a
 * page.
 */
import { create } from "zustand";
import type { ReadResult } from "../../../../shared/api";
import type { Rect, Trim } from "../../../../shared/pages";
import type { Annotations, Book, Highlight, HighlightColor, Passage, Section, Version } from "../../../../shared/types";
import { api, errorText } from "../../api";
import { useApp } from "../../store";

export type PanelTab = "ask" | "notes" | "cards" | "concepts" | "sketch";

/** What the reader has picked out: one passage per page it touches, in reading order. */
export interface Selection {
  parts: Passage[];
  /** All of its words, as prose. */
  quote: string;
}

/** A box drawn around part of a page — a figure, an equation, a table. */
export interface Region {
  page: number;
  rect: Rect;
}

/** A passage being written over: by hand, or by a model. */
export interface SlipState {
  passage: Passage;
  mode: "edit" | "rewrite";
  streamId: string | null;
  text: string;
  state: "idle" | "streaming" | "done" | "error";
  error?: string;
  instruction: string;
  /** The conversation whose explanation the rewrite should fold in. */
  threadId: number | null;
}

interface ReaderState {
  bookId: string | null;
  book: Book | null;
  sections: Section[];
  units: Section[];
  /** Every page's size in points. */
  sizes: Array<[number, number]>;
  /** Where the pages are printed, for trimming margins. */
  trim: Trim | null;
  loading: boolean;
  error: string | null;

  /** The page in front of the reader; the book shows the spread it is in. */
  page: number;
  /** The pages on screen right now, as the book view lays them out. */
  visible: number[];

  highlights: Highlight[];
  versions: Version[];
  pins: Annotations["sketches"];
  chats: Annotations["chats"];
  read: Set<number>;

  panel: PanelTab | null;
  tocOpen: boolean;
  /** Dragging draws a box around a region instead of selecting text. */
  boxMode: boolean;
  /** Something to point at once its page is up; `seq` makes a repeat fire. */
  flash: { page: number; box?: Rect; range?: [number, number]; seq: number } | null;
  /** Search words to mark on a page until the reader moves on. */
  marks: { page: number; terms: string[] } | null;
  askRequest: { seq: number; passage: Passage | null; region: Region | null; prompt?: string; threadId?: number } | null;
  sketchRequest: { seq: number; anchor: { page: number; y: number } | null; sketchId: number | null } | null;
  slip: SlipState | null;
  /** Versions lifted off their passage for now, showing the book's text. */
  lifted: Set<number>;
  cardDraft: { page: number | null; quote: string; context: string } | null;

  open(bookId: string, target?: { page?: number | undefined; blockId?: number | undefined; terms?: string[] | undefined }): Promise<void>;
  goTo(page: number, show?: { box?: Rect; range?: [number, number]; terms?: string[] }): void;
  goToBlock(blockId: number, terms?: string[]): Promise<void>;
  nextUnit(dir: 1 | -1): void;
  applyRead(result: ReadResult, pages?: number[]): void;
  refreshAnnotations(): Promise<void>;

  addHighlights(sel: Selection, color: HighlightColor, note?: string): Promise<Highlight[]>;
  updateHighlight(id: number, patch: { color?: HighlightColor; note?: string }): Promise<void>;
  removeHighlight(id: number): Promise<void>;
  saveVersion(passage: Passage, text: string, source: "user" | "ai"): Promise<Version | null>;
  removeVersion(id: number): Promise<void>;
  toggleLifted(id: number): void;

  setPanel(panel: PanelTab | null): void;
  ask(passage: Passage | null, region?: Region | null, prompt?: string): void;
  openThread(threadId: number): void;
  sketch(anchor: { page: number; y: number } | null, sketchId?: number | null): void;
  set(patch: Partial<ReaderState>): void;
}

let seq = 0;

/** The chapter a page is in: the last to start at or before it. */
export function unitAtPage(units: Section[], page: number): Section | undefined {
  let best: Section | undefined;
  for (const u of units) if (u.page <= page && (!best || u.page >= best.page)) best = u;
  return best ?? units[0];
}

/**
 * The page that says which chapter is open: the last one on screen, so a
 * chapter that begins on the right-hand page is the one being read.
 */
export function lastVisible(s: { visible: number[]; page: number }): number {
  return s.visible[s.visible.length - 1] ?? s.page;
}

/** The chapter the open pages are in. */
export function useUnitId(): number | null {
  return useReader((s) => unitAtPage(s.units, lastVisible(s))?.id ?? null);
}

/** A chapter's pages: from its first to the page before the next chapter starts. */
export function unitPages(units: Section[], unitId: number, pageCount: number): [number, number] | null {
  const sorted = [...units].sort((a, b) => a.page - b.page);
  const i = sorted.findIndex((u) => u.id === unitId);
  if (i < 0) return null;
  const next = sorted.slice(i + 1).find((u) => u.page > sorted[i]!.page);
  return [sorted[i]!.page, Math.max(sorted[i]!.page, (next ? next.page : pageCount) - 1)];
}

export const useReader = create<ReaderState>((set, get) => ({
  bookId: null,
  book: null,
  sections: [],
  units: [],
  sizes: [],
  trim: null,
  loading: false,
  error: null,
  page: 0,
  visible: [],
  highlights: [],
  versions: [],
  pins: [],
  chats: [],
  read: new Set(),
  panel: null,
  tocOpen: true,
  boxMode: false,
  flash: null,
  marks: null,
  askRequest: null,
  sketchRequest: null,
  slip: null,
  lifted: new Set(),
  cardDraft: null,

  set(patch) {
    set(patch);
  },

  async open(bookId, target) {
    set({
      bookId,
      book: null,
      sections: [],
      units: [],
      sizes: [],
      trim: null,
      loading: true,
      error: null,
      page: 0,
      visible: [],
      highlights: [],
      versions: [],
      pins: [],
      chats: [],
      read: new Set(),
      flash: null,
      marks: null,
      slip: null,
      lifted: new Set(),
      cardDraft: null,
    });
    try {
      const opened = await api.books.open(bookId);
      const units = opened.sections.filter((s) => s.isUnit);
      const count = opened.sizes.length;
      // Start where the reading starts, not on a title page.
      let page = target?.page ?? opened.position?.page ?? (units.find((u) => u.kind === "body") ?? units[0])?.page ?? 0;
      page = Math.max(0, Math.min(count - 1, page));
      set({ book: opened.book, sections: opened.sections, units, sizes: opened.sizes, trim: opened.trim, page, loading: false });
      if (!count) set({ error: "This PDF has no pages." });
      void get().refreshAnnotations();
      if (target?.blockId) void get().goToBlock(target.blockId, target.terms);
    } catch (e) {
      set({ loading: false, error: errorText(e) });
    }
  },

  goTo(page, show) {
    const { sizes, bookId } = get();
    if (!bookId || !sizes.length) return;
    const p = Math.max(0, Math.min(sizes.length - 1, page));
    set({
      page: p,
      ...(show?.box || show?.range ? { flash: { page: p, ...(show.box ? { box: show.box } : {}), ...(show.range ? { range: show.range } : {}), seq: ++seq } } : {}),
      ...(show?.terms?.length ? { marks: { page: p, terms: show.terms } } : {}),
    });
  },

  async goToBlock(blockId, terms) {
    const where = await api.reader.locate(blockId);
    if (!where) return;
    if (where.bookId !== get().bookId) {
      useApp.getState().go({ name: "reader", bookId: where.bookId, blockId, ...(terms ? { terms } : {}) });
      return;
    }
    get().goTo(where.page, { ...(where.box ? { box: where.box } : {}), ...(terms ? { terms } : {}) });
  },

  nextUnit(dir) {
    const { units } = get();
    const sorted = [...units].sort((a, b) => a.page - b.page);
    const here = unitAtPage(sorted, lastVisible(get()));
    const i = sorted.findIndex((u) => u.id === here?.id);
    let j = i + dir;
    // Units that start on the same page are one stop.
    while (sorted[j] && sorted[j]!.page === here?.page) j += dir;
    const next = sorted[j];
    if (next) get().goTo(next.page);
  },

  applyRead(result, pages) {
    const fractions = new Map(result.units.map((u) => [u.unitId, u.readFraction]));
    const sections = get().sections.map((s) => (fractions.has(s.id) ? { ...s, readFraction: fractions.get(s.id)! } : s));
    const read = pages?.length ? new Set([...get().read, ...pages]) : get().read;
    set({ sections, units: sections.filter((s) => s.isUnit), read });
  },

  async refreshAnnotations() {
    const { bookId } = get();
    if (!bookId) return;
    try {
      const a = await api.reader.annotations(bookId);
      if (get().bookId !== bookId) return;
      set({ highlights: a.highlights, versions: a.versions, pins: a.sketches, chats: a.chats, read: new Set(a.read) });
    } catch (e) {
      useApp.getState().toast(errorText(e), "error");
    }
  },

  async addHighlights(sel, color, note) {
    const { bookId } = get();
    if (!bookId) return [];
    const made: Highlight[] = [];
    try {
      for (const part of sel.parts) {
        made.push(await api.highlights.add({ bookId, ...part, color, ...(note && made.length === 0 ? { note } : {}) }));
      }
    } catch (e) {
      useApp.getState().toast(errorText(e), "error");
    }
    set({ highlights: [...get().highlights, ...made] });
    return made;
  },

  async updateHighlight(id, patch) {
    const h = await api.highlights.update(id, patch);
    set({ highlights: get().highlights.map((x) => (x.id === id ? h : x)) });
  },

  async removeHighlight(id) {
    await api.highlights.remove(id);
    set({ highlights: get().highlights.filter((x) => x.id !== id) });
  },

  async saveVersion(passage, text, source) {
    const { bookId } = get();
    if (!bookId) return null;
    try {
      const v = await api.versions.save({ bookId, ...passage, text, source });
      const lifted = new Set(get().lifted);
      lifted.delete(v.id);
      set({ versions: [...get().versions.filter((x) => x.id !== v.id), v], lifted });
      return v;
    } catch (e) {
      useApp.getState().toast(errorText(e), "error");
      return null;
    }
  },

  async removeVersion(id) {
    await api.versions.remove(id);
    set({ versions: get().versions.filter((v) => v.id !== id) });
  },

  toggleLifted(id) {
    const lifted = new Set(get().lifted);
    if (lifted.has(id)) lifted.delete(id);
    else lifted.add(id);
    set({ lifted });
  },

  setPanel(panel) {
    set({ panel });
  },

  ask(passage, region = null, prompt) {
    set({ panel: "ask", askRequest: { seq: ++seq, passage, region, ...(prompt ? { prompt } : {}) } });
  },

  openThread(threadId) {
    set({ panel: "ask", askRequest: { seq: ++seq, passage: null, region: null, threadId } });
  },

  sketch(anchor, sketchId = null) {
    set({ panel: "sketch", sketchRequest: { seq: ++seq, anchor, sketchId } });
  },
}));
