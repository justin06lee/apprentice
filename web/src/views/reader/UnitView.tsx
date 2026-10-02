/**
 * The reading column: one unit (chapter) of the book, and everything the
 * reader does to it with a pointer.
 *
 * All pointer handling is delegated from the column — one listener for a
 * chapter of a thousand blocks — and reading is watched with one
 * IntersectionObserver. A block counts as read once it has been on screen,
 * with the reader active, about as long as reading it takes.
 */
import { ArrowRight, Check, CircleCheck } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Block, Highlight } from "../../../../shared/types";
import { api, errorText } from "../../api";
import { readSelection, type SelectionInfo } from "../../lib/selection";
import { plural } from "../../lib/format";
import { useApp } from "../../store";
import { BlockEditor, RewriteCard } from "./BlockEditor";
import { BlockView } from "./BlockView";
import { BlockMenu, FootnotePeek, HighlightMenu, SelectionMenu } from "./menus";
import { useReader } from "./state";

/** A block is read after this long on screen per character, within bounds. */
const MS_PER_CHAR = 9;
const MIN_DWELL = 700;
const MAX_DWELL = 4500;
/** Idle this long and the clock stops: walking away from an open book is not reading it. */
const IDLE_MS = 90_000;

type Menu =
  | { kind: "selection"; sel: SelectionInfo }
  | { kind: "highlight"; highlight: Highlight; x: number; y: number; h: number; focusNote?: boolean }
  | { kind: "block"; block: Block; x: number; y: number; h: number }
  | { kind: "footnote"; block: Block; x: number; y: number; h: number };

export function UnitView({ scroller }: { scroller: React.RefObject<HTMLDivElement | null> }) {
  const bookId = useReader((s) => s.bookId)!;
  const book = useReader((s) => s.book);
  const content = useReader((s) => s.content);
  const unitId = useReader((s) => s.unitId);
  const units = useReader((s) => s.units);
  const showOriginal = useReader((s) => s.showOriginal);
  const editing = useReader((s) => s.editing);
  const rewrite = useReader((s) => s.rewrite);
  const focus = useReader((s) => s.focus);
  const settings = useApp((s) => s.settings);
  const toast = useApp((s) => s.toast);
  const columnRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [read, setRead] = useState<Set<number>>(new Set());

  // Pixels per PDF point that make the book's body text in a figure the size of the reader's.
  const scale = settings.fontSize / Math.max(6, book?.bodySize ?? 10);
  const blocks = content?.blocks ?? [];

  useEffect(() => {
    setRead(new Set(content?.read ?? []));
  }, [content?.unitId]); // eslint-disable-line react-hooks/exhaustive-deps

  const byBlock = useMemo(() => {
    const m = new Map<number, Highlight[]>();
    for (const h of content?.highlights ?? []) {
      const l = m.get(h.blockId);
      if (l) l.push(h);
      else m.set(h.blockId, [h]);
    }
    return m;
  }, [content?.highlights]);
  const chats = useMemo(() => new Set(content?.chats ?? []), [content?.chats]);
  const sketches = useMemo(() => new Map((content?.sketches ?? []).filter((s) => s.blockId !== null).map((s) => [s.blockId!, s.id])), [content?.sketches]);
  const sections = useReader((s) => s.sections);
  const headingSection = useMemo(() => new Map(sections.filter((s) => s.blockId !== null).map((s) => [s.blockId!, s.id])), [sections]);
  const none = useMemo<Highlight[]>(() => [], []);

  // ── where we are: restore, flash, remember ─────────────────────────────
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !focus) return;
    if (focus.blockId < 0) {
      el.scrollTop = 0;
      return;
    }
    // Blocks above the target are laid out lazily (content-visibility), so
    // their real heights arrive as they render. Re-aim a few times until the
    // target holds still.
    let tries = 0;
    let raf = 0;
    const aim = () => {
      const target = el.querySelector<HTMLElement>(`[data-id="${focus.blockId}"]`);
      if (!target) return;
      const top = target.offsetTop - 28 + focus.offset;
      if (Math.abs(el.scrollTop - top) > 2) el.scrollTop = top;
      if (++tries < 6) raf = requestAnimationFrame(aim);
      else if (focus.flash) {
        target.classList.remove("flash");
        void target.offsetWidth;
        target.classList.add("flash");
      }
    };
    aim();
    return () => cancelAnimationFrame(raf);
  }, [focus, scroller]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !unitId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      const top = el.scrollTop;
      const kids = columnRef.current?.querySelectorAll<HTMLElement>("[data-id]") ?? [];
      for (const k of kids) {
        if (k.offsetTop + k.offsetHeight > top + 28) {
          void api.reader.savePosition(bookId, { unitId, blockId: Number(k.dataset["id"]), offset: Math.max(0, top + 28 - k.offsetTop) });
          return;
        }
      }
    };
    const onScroll = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, 500);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timer) {
        clearTimeout(timer);
        save();
      }
    };
  }, [bookId, unitId, scroller]);

  // ── which section is on screen, for the contents ───────────────────────
  useEffect(() => {
    const el = scroller.current;
    const column = columnRef.current;
    if (!el || !column) return;
    const heads = [...column.querySelectorAll<HTMLElement>(".t-heading")];
    if (!heads.length) return;
    let raf = 0;
    const spy = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const line = el.scrollTop + el.clientHeight * 0.3;
        let current: number | null = null;
        for (const h of heads) {
          if (h.offsetTop > line) break;
          current = headingSection.get(Number(h.dataset["id"])) ?? current;
        }
        if (useReader.getState().activeSection !== current) useReader.getState().set({ activeSection: current });
      });
    };
    spy();
    el.addEventListener("scroll", spy, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", spy);
    };
  }, [content?.unitId, blocks.length, headingSection, scroller]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── reading ────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = scroller.current;
    const column = columnRef.current;
    if (!el || !column || !unitId) return;
    const already = new Set(content?.read ?? []);
    const visible = new Map<number, HTMLElement>();
    const dwell = new Map<number, number>();
    const queue: Array<{ blockId: number; dwellMs: number }> = [];
    const length = new Map(blocks.map((b) => [b.id, (b.custom?.text ?? b.text).length + (b.asset ? 120 : 0)]));
    let lastActive = Date.now();
    let activeMs = 0;
    const active = () => (lastActive = Date.now());

    const io = new IntersectionObserver(
      (entries) => {
        const vh = el.clientHeight;
        for (const e of entries) {
          const id = Number((e.target as HTMLElement).dataset["id"]);
          const seen = e.isIntersecting && (e.intersectionRatio >= 0.6 || e.intersectionRect.height >= vh * 0.45);
          if (seen) visible.set(id, e.target as HTMLElement);
          else visible.delete(id);
        }
      },
      { root: el, threshold: [0, 0.3, 0.6, 1] },
    );
    for (const k of column.querySelectorAll<HTMLElement>("[data-id]")) io.observe(k);

    const tick = setInterval(() => {
      if (!document.hasFocus() || Date.now() - lastActive > IDLE_MS) return;
      activeMs += 500;
      for (const id of visible.keys()) {
        if (already.has(id)) continue;
        const d = (dwell.get(id) ?? 0) + 500;
        dwell.set(id, d);
        const need = Math.max(MIN_DWELL, Math.min(MAX_DWELL, (length.get(id) ?? 0) * MS_PER_CHAR));
        if (d >= need) {
          already.add(id);
          queue.push({ blockId: id, dwellMs: d });
          visible.get(id)?.classList.add("read");
        }
      }
    }, 500);

    const flush = async () => {
      if (activeMs >= 15000) {
        void api.reader.addTime(bookId, activeMs);
        activeMs = 0;
      }
      if (!queue.length) return;
      const batch = queue.splice(0);
      try {
        const r = await api.reader.markRead(bookId, unitId, batch);
        useReader.getState().setUnitFraction(unitId, r.readFraction);
        setRead(new Set(already));
        if (r.unlocked) {
          toast(`${plural(r.unlocked, "card")} from this chapter ${r.unlocked === 1 ? "is" : "are"} ready to review.`, "success", {
            label: "Review",
            run: () => useApp.getState().go({ name: "review", bookId }),
          });
        }
      } catch {
        queue.unshift(...batch);
      }
    };
    const flusher = setInterval(() => void flush(), 2500);
    const events = ["pointermove", "keydown", "wheel", "pointerdown"] as const;
    for (const ev of events) window.addEventListener(ev, active, { passive: true });
    el.addEventListener("scroll", active, { passive: true });
    return () => {
      io.disconnect();
      clearInterval(tick);
      clearInterval(flusher);
      void flush();
      if (activeMs > 0) void api.reader.addTime(bookId, activeMs);
      for (const ev of events) window.removeEventListener(ev, active);
      el.removeEventListener("scroll", active);
    };
    // Re-observe when the set of blocks changes (an edit replaces one).
  }, [bookId, unitId, content?.unitId, blocks.length, scroller, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── pointer ────────────────────────────────────────────────────────────
  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const column = columnRef.current;
      if (!column) return;
      // Let the selection settle (double and triple clicks extend it).
      setTimeout(() => {
        const sel = readSelection(column);
        if (sel) setMenu({ kind: "selection", sel });
      }, 10);
    },
    [],
  );

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const t = e.target as HTMLElement;
      if (window.getSelection()?.toString()) return;
      const menuBtn = t.closest<HTMLElement>("[data-block-menu]");
      if (menuBtn) {
        const block = blocks.find((b) => b.id === Number(menuBtn.dataset["blockMenu"]));
        const r = menuBtn.getBoundingClientRect();
        if (block) setMenu({ kind: "block", block, x: r.left + r.width / 2 + 90, y: r.top, h: r.height });
        return;
      }
      const sketch = t.closest<HTMLElement>("[data-open-sketch]");
      if (sketch) {
        useReader.getState().sketch(null, Number(sketch.dataset["openSketch"]));
        return;
      }
      const toggle = t.closest<HTMLElement>("[data-toggle-original]");
      if (toggle) {
        useReader.getState().toggleOriginal(Number(toggle.dataset["toggleOriginal"]));
        return;
      }
      const ref = t.closest<HTMLElement>("[data-ref]");
      if (ref) {
        const block = blocks.find((b) => b.id === Number(ref.dataset["ref"]));
        const r = ref.getBoundingClientRect();
        if (block) setMenu({ kind: "footnote", block, x: r.left + r.width / 2, y: r.top, h: r.height });
        return;
      }
      const hl = t.closest<HTMLElement>("[data-hl]");
      if (hl) {
        const h = content?.highlights.find((x) => x.id === Number(hl.dataset["hl"]));
        const rects = hl.getClientRects();
        const r = rects[0] ?? hl.getBoundingClientRect();
        if (h) setMenu({ kind: "highlight", highlight: h, x: r.left + r.width / 2, y: r.top, h: r.height });
      }
    },
    [blocks, content?.highlights],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  if (!content || !book) return null;

  // Consecutive blocks in one callout box share a frame.
  const groups: Array<{ boxed: number; blocks: Block[] }> = [];
  for (const b of blocks) {
    const last = groups[groups.length - 1];
    if (last && b.boxed && last.boxed === b.boxed) last.blocks.push(b);
    else groups.push({ boxed: b.boxed, blocks: [b] });
  }

  const leadId = blocks[0]?.type === "heading" ? blocks[0].id : null;
  const unitIndex = units.findIndex((u) => u.id === unitId);
  const next = units[unitIndex + 1];
  const unit = units[unitIndex];
  const unitRead = (unit?.readFraction ?? 0) >= 0.85;

  const renderBlock = (b: Block) => (
    <Fragment key={b.id}>
      {editing === b.id ? (
        <BlockEditor block={b} />
      ) : (
        <BlockView
          block={b}
          bookId={bookId}
          highlights={byBlock.get(b.id) ?? none}
          scale={scale}
          showOriginal={showOriginal.has(b.id)}
          read={read.has(b.id)}
          hasChat={chats.has(b.id)}
          lead={b.id === leadId}
          sketchId={sketches.get(b.id)}
        />
      )}
      {rewrite?.blockId === b.id && <RewriteCard block={b} />}
    </Fragment>
  );

  return (
    <div className="column selectable" ref={columnRef} onMouseUp={onMouseUp} onClick={onClick}>
      {groups.map((g) =>
        g.boxed ? (
          <div className="callout" key={`box-${g.blocks[0]!.id}`}>
            {g.blocks.map(renderBlock)}
          </div>
        ) : (
          g.blocks.map(renderBlock)
        ),
      )}

      <footer className="unit-end">
        {content.cards.pending > 0 && !unitRead && (
          <p className="muted">
            {plural(content.cards.pending, "card")} from this chapter will join your reviews once you have read it.
          </p>
        )}
        <div className="unit-end-actions">
          {!unitRead ? (
            <button
              className="btn"
              onClick={async () => {
                try {
                  const r = await api.reader.markUnit(bookId, unitId!, true);
                  useReader.getState().setUnitFraction(unitId!, r.readFraction);
                  setRead(new Set(blocks.map((b) => b.id)));
                  if (r.unlocked) toast(`${plural(r.unlocked, "card")} added to your reviews.`, "success");
                } catch (e) {
                  toast(errorText(e), "error");
                }
              }}
            >
              <Check size={15} /> Mark chapter as read
            </button>
          ) : (
            <span className="chip good">
              <CircleCheck size={13} /> Chapter read
            </span>
          )}
          {next && (
            <button className="btn primary" onClick={() => useReader.getState().loadUnit(next.id)}>
              Next: {next.title.length > 48 ? `${next.title.slice(0, 46)}…` : next.title} <ArrowRight size={15} />
            </button>
          )}
        </div>
      </footer>

      {menu?.kind === "selection" && <SelectionMenu sel={menu.sel} onClose={closeMenu} />}
      {menu?.kind === "highlight" && (
        <HighlightMenu
          highlight={content.highlights.find((h) => h.id === menu.highlight.id) ?? menu.highlight}
          anchor={{ x: menu.x, y: menu.y, h: menu.h }}
          focusNote={!!menu.focusNote}
          onClose={closeMenu}
        />
      )}
      {menu?.kind === "block" && <BlockMenu block={menu.block} anchor={{ x: menu.x, y: menu.y, h: menu.h }} onClose={closeMenu} />}
      {menu?.kind === "footnote" && <FootnotePeek block={menu.block} anchor={{ x: menu.x, y: menu.y, h: menu.h }} onClose={closeMenu} />}
    </div>
  );
}
