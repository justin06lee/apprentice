/**
 * The open book: which chapter is on screen, what is on it, and the
 * reader's tools around it. One store, reset whenever a book opens, so the
 * column, the contents and the side panel all see the same thing.
 */
import { create } from "zustand";
import type { Block, Book, Highlight, HighlightColor, ReadingPosition, Section, UnitContent } from "../../../../shared/types";
import { plainText } from "../../../../shared/inline";
import { api, errorText } from "../../api";
import type { BlockRange } from "../../lib/selection";
import { useApp } from "../../store";

export type PanelTab = "ask" | "notes" | "cards" | "concepts" | "sketch";

export interface RewriteState {
  blockId: number;
  streamId: string | null;
  text: string;
  state: "idle" | "streaming" | "done" | "error";
  error?: string;
  instruction: string;
  threadId: number | null;
}

interface ReaderState {
  bookId: string | null;
  book: Book | null;
  sections: Section[];
  units: Section[];
  unitId: number | null;
  content: UnitContent | null;
  loading: boolean;
  error: string | null;

  panel: PanelTab | null;
  tocOpen: boolean;
  pageView: boolean;
  pageTarget: number | null;
  /** A block to bring into view; `seq` makes repeated jumps to the same block fire. */
  focus: { blockId: number; offset: number; flash: boolean; seq: number } | null;
  /** A request for the Ask panel: talk about this passage. */
  askRequest: { seq: number; quote: string | null; blockIds: number[]; prompt?: string } | null;
  /** Open a sketch in the Sketch panel, anchored to a block. */
  sketchRequest: { seq: number; blockId: number | null; sketchId: number | null } | null;
  editing: number | null;
  rewrite: RewriteState | null;
  showOriginal: Set<number>;
  activeSection: number | null;
  cardDraft: { blockId: number | null; quote: string } | null;

  open(bookId: string, unitId?: number, blockId?: number): Promise<void>;
  loadUnit(unitId: number, target?: { blockId: number; offset?: number; flash?: boolean }): Promise<void>;
  goToBlock(blockId: number, flash?: boolean): Promise<void>;
  nextUnit(dir: 1 | -1): void;
  refreshSections(): Promise<void>;
  setUnitFraction(unitId: number, fraction: number): void;

  addHighlights(ranges: BlockRange[], quote: string, color: HighlightColor, note?: string): Promise<Highlight[]>;
  updateHighlight(id: number, patch: { color?: HighlightColor; note?: string }): Promise<void>;
  removeHighlight(id: number): Promise<void>;
  saveBlock(blockId: number, text: string | null, source?: "user" | "ai"): Promise<Block | null>;
  replaceBlock(block: Block): void;
  toggleOriginal(blockId: number): void;

  setPanel(panel: PanelTab | null): void;
  ask(quote: string | null, blockIds: number[], prompt?: string): void;
  sketch(blockId: number | null, sketchId?: number | null): void;
  set(patch: Partial<ReaderState>): void;
}

let seq = 0;

/**
 * The next chapter, fetched while the reader is reading this one, so
 * turning the page does not wait on the database. Taken once, then gone:
 * anything the reader does to it after it was fetched would be stale.
 */
const prefetched = new Map<number, Promise<UnitContent>>();
function prefetch(bookId: string, unitId: number) {
  if (prefetched.has(unitId)) return;
  const idle = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 300));
  idle(() => {
    if (!prefetched.has(unitId)) prefetched.set(unitId, api.reader.unit(bookId, unitId));
  });
}

export const useReader = create<ReaderState>((set, get) => ({
  bookId: null,
  book: null,
  sections: [],
  units: [],
  unitId: null,
  content: null,
  loading: false,
  error: null,
  panel: null,
  tocOpen: true,
  pageView: false,
  pageTarget: null,
  focus: null,
  askRequest: null,
  sketchRequest: null,
  editing: null,
  rewrite: null,
  showOriginal: new Set(),
  activeSection: null,
  cardDraft: null,

  set(patch) {
    set(patch);
  },

  async open(bookId, unitId, blockId) {
    prefetched.clear();
    set({
      bookId,
      book: null,
      sections: [],
      units: [],
      unitId: null,
      content: null,
      loading: true,
      error: null,
      pageView: false,
      editing: null,
      rewrite: null,
      showOriginal: new Set(),
      focus: null,
    });
    try {
      const opened = await api.books.open(bookId);
      const units = opened.sections.filter((s) => s.isUnit);
      set({ book: opened.book, sections: opened.sections, units });
      let target = unitId ?? opened.position?.unitId ?? null;
      if (target === null || !units.some((u) => u.id === target)) {
        // Start where the reading starts, not on a title page.
        target = (units.find((u) => u.kind === "body") ?? units[0])?.id ?? null;
      }
      if (target === null) {
        set({ loading: false, error: "This book has no readable text." });
        return;
      }
      const pos: ReadingPosition | null = !unitId && opened.position?.unitId === target ? opened.position : null;
      await get().loadUnit(
        target,
        blockId ? { blockId, flash: true } : pos?.blockId ? { blockId: pos.blockId, offset: pos.offset, flash: false } : undefined,
      );
    } catch (e) {
      set({ loading: false, error: errorText(e) });
    }
  },

  async loadUnit(unitId, target) {
    const { bookId } = get();
    if (!bookId) return;
    if (get().unitId === unitId && get().content) {
      if (target) set({ focus: { blockId: target.blockId, offset: target.offset ?? 0, flash: target.flash ?? true, seq: ++seq } });
      return;
    }
    set({ loading: true, editing: null, rewrite: null });
    try {
      const early = prefetched.get(unitId);
      prefetched.delete(unitId);
      const content = await (early ?? api.reader.unit(bookId, unitId));
      if (get().bookId !== bookId) return;
      set({
        unitId,
        content,
        loading: false,
        activeSection: null,
        focus: target ? { blockId: target.blockId, offset: target.offset ?? 0, flash: target.flash ?? true, seq: ++seq } : { blockId: -1, offset: 0, flash: false, seq: ++seq },
      });
      void api.reader.savePosition(bookId, { unitId, blockId: target?.blockId ?? null, offset: target?.offset ?? 0 });
      const units = get().units;
      const next = units[units.findIndex((u) => u.id === unitId) + 1];
      if (next) prefetch(bookId, next.id);
    } catch (e) {
      set({ loading: false, error: errorText(e) });
    }
  },

  async goToBlock(blockId, flash = true) {
    const content = get().content;
    if (content?.blocks.some((b) => b.id === blockId)) {
      set({ focus: { blockId, offset: 0, flash, seq: ++seq }, pageView: false });
      return;
    }
    const where = await api.reader.locate(blockId);
    if (!where) return;
    if (where.bookId !== get().bookId) {
      useApp.getState().go({ name: "reader", bookId: where.bookId, unitId: where.unitId, blockId });
      return;
    }
    set({ pageView: false });
    await get().loadUnit(where.unitId, { blockId, flash });
  },

  nextUnit(dir) {
    const { units, unitId } = get();
    const i = units.findIndex((u) => u.id === unitId);
    const next = units[i + dir];
    if (next) void get().loadUnit(next.id);
  },

  async refreshSections() {
    const { bookId } = get();
    if (!bookId) return;
    const opened = await api.books.open(bookId);
    set({ sections: opened.sections, units: opened.sections.filter((s) => s.isUnit), book: opened.book });
  },

  setUnitFraction(unitId, fraction) {
    const sections = get().sections.map((s) => (s.id === unitId ? { ...s, readFraction: fraction } : s));
    set({ sections, units: sections.filter((s) => s.isUnit) });
  },

  async addHighlights(ranges, quote, color, note) {
    const { bookId, content } = get();
    if (!bookId || !content) return [];
    const made: Highlight[] = [];
    for (const r of ranges) {
      const block = content.blocks.find((b) => b.id === r.blockId);
      if (!block) continue;
      const text = block.custom && !get().showOriginal.has(block.id) ? displayText(block) : block.text;
      const part = ranges.length === 1 ? quote : text.slice(r.start, r.end);
      made.push(await api.highlights.add({ bookId, blockId: r.blockId, start: r.start, end: r.end, quote: part, color, ...(note && made.length === 0 ? { note } : {}) }));
    }
    const c = get().content;
    if (c) set({ content: { ...c, highlights: [...c.highlights, ...made] } });
    return made;
  },

  async updateHighlight(id, patch) {
    const h = await api.highlights.update(id, patch);
    const c = get().content;
    if (c) set({ content: { ...c, highlights: c.highlights.map((x) => (x.id === id ? h : x)) } });
  },

  async removeHighlight(id) {
    await api.highlights.remove(id);
    const c = get().content;
    if (c) set({ content: { ...c, highlights: c.highlights.filter((x) => x.id !== id) } });
  },

  async saveBlock(blockId, text, source = "user") {
    try {
      const block = await api.blocks.edit(blockId, text, source);
      get().replaceBlock(block);
      // Highlights may have moved with their words.
      const { bookId, unitId } = get();
      if (bookId && unitId) {
        const fresh = await api.reader.unit(bookId, unitId);
        const c = get().content;
        if (c) set({ content: { ...c, highlights: fresh.highlights } });
      }
      return block;
    } catch (e) {
      useApp.getState().toast(errorText(e), "error");
      return null;
    }
  },

  replaceBlock(block) {
    const c = get().content;
    if (!c) return;
    const showOriginal = new Set(get().showOriginal);
    showOriginal.delete(block.id);
    set({ content: { ...c, blocks: c.blocks.map((b) => (b.id === block.id ? block : b)) }, showOriginal });
  },

  toggleOriginal(blockId) {
    const s = new Set(get().showOriginal);
    if (s.has(blockId)) s.delete(blockId);
    else s.add(blockId);
    set({ showOriginal: s });
  },

  setPanel(panel) {
    set({ panel });
  },

  ask(quote, blockIds, prompt) {
    set({ panel: "ask", askRequest: { seq: ++seq, quote, blockIds, ...(prompt ? { prompt } : {}) } });
  },

  sketch(blockId, sketchId = null) {
    set({ panel: "sketch", sketchRequest: { seq: ++seq, blockId, sketchId } });
  },
}));

/** The words a block shows: the reader's version (minus its markup) or the book's. */
export function displayText(block: Block): string {
  return block.custom ? plainText(block.custom.text) : block.text;
}

/** Index units by id, sections by unit, for the contents. */
export function unitOf(sections: Section[], unitId: number | null): Section | undefined {
  return sections.find((s) => s.id === unitId);
}
