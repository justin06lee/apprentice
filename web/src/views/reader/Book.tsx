/**
 * The book, open on the desk: the PDF's own pages, two at a time like a
 * printed book (or one, in a narrow window), turned with a page-turn.
 *
 * The book handles every pointer on its pages itself. Text is selected
 * against each page's text layer (shared/pages.ts) — a drag may run from
 * the left page onto the right — and drawn by the sheets, so what is
 * selected lines up with the printed glyphs exactly. Alt-drag, the box
 * tool, or any drag on a page without text draws a box around a region
 * instead: a figure, an equation, a scanned page.
 *
 * Reading is the pages on screen, with the reader there: a page counts as
 * read after about as long as reading it takes (see `need`).
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cleanText, hitTest, paragraphAt, rangeRects, union, wordAt, type Rect } from "../../../../shared/pages";
import type { Highlight } from "../../../../shared/types";
import { api, pageUrl } from "../../api";
import type { Anchor } from "../../components/ui";
import { plural } from "../../lib/format";
import { loadPageText, nextSpread, pageTextNow, spreadPages, spreadStart, type Layout } from "../../lib/pages";
import { useApp } from "../../store";
import { HighlightMenu, RegionMenu, SelectionMenu } from "./menus";
import { PageBar } from "./PageBar";
import { Sheet } from "./Sheet";
import { useReader, type Region, type Selection } from "./state";

const TURN_MS = 560;
const QUICK_TURN_MS = 300;
/** A page is read after this long on screen per character of it, within bounds. */
const MS_PER_CHAR = 8;
const MIN_DWELL = 2500;
const MAX_DWELL = 30_000;
/** Idle this long and the clock stops: walking away from an open book is not reading it. */
const IDLE_MS = 90_000;
/** Room around the pages: the side room holds the turn buttons. */
const PAD_X = 52;
const PAD_Y = 16;

interface Turn {
  from: number;
  to: number;
  dir: 1 | -1;
  ms: number;
}

type Pt = { page: number; off: number };
const ordered = (a: Pt, b: Pt): [Pt, Pt] => (a.page < b.page || (a.page === b.page && a.off <= b.off) ? [a, b] : [b, a]);

type Menu =
  | { kind: "selection"; sel: Selection; anchor: Anchor }
  | { kind: "highlight"; highlight: Highlight; anchor: Anchor; focusNote: boolean }
  | { kind: "region"; region: Region; anchor: Anchor };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function need(chars: number): number {
  return Math.max(MIN_DWELL, Math.min(MAX_DWELL, chars * MS_PER_CHAR));
}

export function Book() {
  const bookId = useReader((s) => s.bookId)!;
  const sizes = useReader((s) => s.sizes);
  const trim = useReader((s) => s.trim);
  const page = useReader((s) => s.page);
  const boxMode = useReader((s) => s.boxMode);
  const settings = useApp((s) => s.settings);
  const toast = useApp((s) => s.toast);
  const stageRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<{ w: number; h: number } | null>(null);
  const count = sizes.length;

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setArea({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── layout ─────────────────────────────────────────────────────────────
  // Pages are scaled as one book: by its typical page, so a spread of an
  // odd-sized plate does not resize everything around it. Trimmed, a page
  // shows its printed area — the book's, for its side of the spread, grown
  // to take in anything printed beyond it on that page.
  const [W, H] = useMemo(() => [median(sizes.map((s) => s[0])) || 612, median(sizes.map((s) => s[1])) || 792], [sizes]);
  const trimmed = settings.pageTrim && !!trim;
  const [textTick, setTextTick] = useState(0);
  const cropFor = useCallback(
    (p: number): Rect => {
      const [w, h] = sizes[p] ?? [W, H];
      if (!trimmed) return [0, 0, w, h];
      let r = p % 2 === 0 ? trim!.even : trim!.odd;
      const ink = pageTextNow(bookId, p)?.ink;
      if (ink) r = union(r, [ink[0] - 8, ink[1] - 8, ink[2] + 8, ink[3] + 8]);
      return [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(w, r[2]), Math.min(h, r[3])];
    },
    [sizes, W, H, trimmed, trim, bookId, textTick], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Left pages have odd indices, right pages even ones.
  const leftW = trimmed ? trim!.odd[2] - trim!.odd[0] : W;
  const rightW = trimmed ? trim!.even[2] - trim!.even[0] : W;
  const typicalH = trimmed ? Math.max(trim!.odd[3] - trim!.odd[1], trim!.even[3] - trim!.even[1]) : H;
  const availW = Math.max(200, (area?.w ?? 1000) - PAD_X * 2);
  const availH = Math.max(200, (area?.h ?? 700) - PAD_Y * 2);
  const fitSpread = Math.min(availH / typicalH, availW / (leftW + rightW));
  const fitSingle = Math.min(availH / typicalH, availW / Math.max(leftW, rightW));
  const layout: Layout =
    settings.pageLayout === "single" ? "single" : settings.pageLayout === "spread" ? "spread" : fitSpread >= fitSingle * 0.8 ? "spread" : "single";
  const zoom = settings.pageZoom;
  const scale = (layout === "spread" ? fitSpread : fitSingle) * zoom;
  const slotH = typicalH * scale;
  const slotLeft = leftW * scale;
  const slotRight = rightW * scale;
  const slotSingle = Math.max(leftW, rightW) * scale;

  // The pictures are drawn at a width that only grows (or shrinks a lot),
  // and only once the size has settled: opening a panel animates the
  // layout, and every frame of that must not be a new picture.
  const dpr = window.devicePixelRatio || 1;
  const wantPx = Math.min(3200, Math.ceil((W * scale * dpr) / 200) * 200);
  const [px, setPx] = useState(wantPx);
  useEffect(() => {
    const t = setTimeout(() => setPx((cur) => (wantPx > cur || wantPx < cur * 0.6 ? wantPx : cur)), 200);
    return () => clearTimeout(t);
  }, [wantPx]);
  const pxFor = useCallback((p: number) => Math.round(((sizes[p]?.[0] ?? W) / W) * px), [sizes, W, px]);

  const reduced = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const live = useRef({ layout, scale, count });
  live.current = { layout, scale, count };

  // ── which spread is shown, and the turn to the next ────────────────────
  const target = spreadStart(page, layout);
  const [shown, setShown] = useState(target);
  const [turn, setTurn] = useState<Turn | null>(null);
  const turning = useRef<Turn | null>(null);
  turning.current = turn;
  const lastTurnEnd = useRef(0);

  useEffect(() => {
    if (turn || target === shown) return;
    const dir = nextSpread(shown, 1, layout, count) === target ? 1 : nextSpread(shown, -1, layout, count) === target ? -1 : 0;
    if (dir && settings.pageTurn && !reduced) {
      // Turning again straight after a turn: the reader is leafing through.
      const quick = performance.now() - lastTurnEnd.current < 250;
      setTurn({ from: shown, to: target, dir, ms: quick ? QUICK_TURN_MS : TURN_MS });
    } else setShown(target);
  }, [target, shown, turn, layout, count, settings.pageTurn, reduced]);

  const endTurn = useCallback(() => {
    lastTurnEnd.current = performance.now();
    const t = turning.current;
    if (t) setShown(t.to);
    setTurn(null);
  }, []);

  const visible = useMemo(() => spreadPages(shown, layout, count).filter((p): p is number => p !== null), [shown, layout, count]);

  useEffect(() => {
    useReader.getState().set({ visible });
    const t = setTimeout(() => void api.reader.savePosition(bookId, { page: visible[0] ?? 0 }), 600);
    // What is likely next, fetched while this is read.
    const ahead: number[] = [];
    let s: number | null = shown;
    for (let i = 0; i < 2 && s !== null; i++) {
      s = nextSpread(s, 1, layout, count);
      if (s !== null) ahead.push(...spreadPages(s, layout, count).filter((p): p is number => p !== null));
    }
    const back = nextSpread(shown, -1, layout, count);
    if (back !== null) ahead.push(...spreadPages(back, layout, count).filter((p): p is number => p !== null));
    // A page's own printed area may widen its crop; show it once known.
    let live = true;
    void Promise.all(visible.map((p) => loadPageText(bookId, p).catch(() => null))).then(() => live && setTextTick((t) => t + 1));
    const idle = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 120));
    idle(() => {
      for (const p of [...visible, ...ahead]) {
        void loadPageText(bookId, p).catch(() => {});
        preload(pageUrl(bookId, p, pxFor(p)));
      }
    });
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [bookId, shown, layout, count, pxFor]); // eslint-disable-line react-hooks/exhaustive-deps

  const turnBy = useCallback(
    (dir: 1 | -1) => {
      const r = useReader.getState();
      const { layout: l, count: n } = live.current;
      const next = nextSpread(spreadStart(r.page, l), dir, l, n);
      if (next !== null) r.set({ page: next });
    },
    [],
  );

  // ── selection, boxes and menus ─────────────────────────────────────────
  const [sel, setSel] = useState<{ a: Pt; f: Pt } | null>(null);
  const [box, setBox] = useState<Region | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);

  const selRanges = useMemo(() => {
    const m = new Map<number, Array<[number, number]>>();
    if (!sel) return m;
    const [a, b] = ordered(sel.a, sel.f);
    for (let p = a.page; p <= b.page; p++) {
      const len = pageTextNow(bookId, p)?.text.length ?? 0;
      const s = p === a.page ? a.off : 0;
      const e = p === b.page ? b.off : len;
      if (e > s) m.set(p, [[s, e]]);
    }
    return m;
  }, [sel, bookId]);

  const selection = useCallback((): Selection | null => {
    const parts: Selection["parts"] = [];
    for (const [p, ranges] of selRanges) {
      const pt = pageTextNow(bookId, p);
      if (!pt) continue;
      for (const [s, e] of ranges) {
        const quote = cleanText(pt.text.slice(s, e));
        if (quote) parts.push({ page: p, start: s, end: e, quote });
      }
    }
    return parts.length ? { parts, quote: parts.map((x) => x.quote).join(" ") } : null;
  }, [selRanges, bookId]);

  /** Where a rectangle of a page is on screen, for a menu to point at. */
  const anchorAt = useCallback(
    (p: number, r: Rect): Anchor | null => {
      const el = stageRef.current?.querySelector<HTMLElement>(`.sheet[data-page="${p}"] .sheet-page`);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const s = live.current.scale;
      return { x: b.left + ((r[0] + r[2]) / 2) * s, y: b.top + r[1] * s, h: (r[3] - r[1]) * s };
    },
    [],
  );

  const openSelectionMenu = useCallback(
    (s: Selection) => {
      const first = s.parts[0]!;
      const pt = pageTextNow(bookId, first.page);
      const r = pt ? rangeRects(pt, first.start, first.end)[0] : null;
      const anchor = r ? anchorAt(first.page, r) : null;
      if (anchor) setMenu({ kind: "selection", sel: s, anchor });
    },
    [anchorAt, bookId],
  );

  // A selection made by double or triple click opens its menu once drawn.
  const pendingMenu = useRef(false);
  useEffect(() => {
    if (!pendingMenu.current) return;
    pendingMenu.current = false;
    const s = selection();
    if (s) openSelectionMenu(s);
  }, [selection, openSelectionMenu]);

  /** The page and character under a point, from whichever page it is over or nearest. */
  const pointAt = useCallback(
    (clientX: number, clientY: number): Pt | null => {
      const sheets = [...(stageRef.current?.querySelectorAll<HTMLElement>(".sheet[data-page]") ?? [])];
      let best: { el: HTMLElement; d: number } | null = null;
      for (const el of sheets) {
        const b = el.getBoundingClientRect();
        const d = clientX < b.left ? b.left - clientX : clientX > b.right ? clientX - b.right : 0;
        if (!best || d < best.d) best = { el, d };
      }
      if (!best) return null;
      const p = Number(best.el.dataset["page"]);
      const pt = pageTextNow(bookId, p);
      if (!pt) return null;
      // Points on the page, held to the part of it that is shown.
      const b = best.el.querySelector(".sheet-page")!.getBoundingClientRect();
      const s = live.current.scale;
      const c = cropFor(p);
      const x = Math.max(c[0], Math.min(c[2], (clientX - b.left) / s));
      const y = Math.max(c[1], Math.min(c[3], (clientY - b.top) / s));
      const off = hitTest(pt, x, y);
      return off === null ? null : { page: p, off };
    },
    [bookId, cropFor],
  );

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest("[data-ui], .turn-btn")) return;
    const sheetEl = t.closest<HTMLElement>(".sheet[data-page]");
    setMenu(null);
    if (!sheetEl) {
      setSel(null);
      setBox(null);
      return;
    }
    e.preventDefault();
    const p = Number(sheetEl.dataset["page"]);
    // The page worked on is the one to keep in front if the spread folds to one page.
    if (useReader.getState().page !== p) useReader.getState().set({ page: p });
    const b = sheetEl.querySelector(".sheet-page")!.getBoundingClientRect();
    const s = scale;
    const x = (e.clientX - b.left) / s;
    const y = (e.clientY - b.top) / s;
    const pt = pageTextNow(bookId, p);
    const startX = e.clientX;
    const startY = e.clientY;
    let raf = 0;

    if (boxMode || e.altKey || !pt || !pt.lines.length) {
      setSel(null);
      setBox({ page: p, rect: [x, y, x, y] });
      const move = (ev: MouseEvent) => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const x2 = Math.max(0, Math.min(b.width, ev.clientX - b.left)) / s;
          const y2 = Math.max(0, Math.min(b.height, ev.clientY - b.top)) / s;
          setBox({ page: p, rect: [Math.min(x, x2), Math.min(y, y2), Math.max(x, x2), Math.max(y, y2)] });
        });
      };
      const up = (ev: MouseEvent) => {
        cancelAnimationFrame(raf);
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        const x2 = Math.max(0, Math.min(b.width, ev.clientX - b.left)) / s;
        const y2 = Math.max(0, Math.min(b.height, ev.clientY - b.top)) / s;
        const rect: Rect = [Math.min(x, x2), Math.min(y, y2), Math.max(x, x2), Math.max(y, y2)];
        if (rect[2] - rect[0] < 8 || rect[3] - rect[1] < 8) {
          setBox(null);
          return;
        }
        const region = { page: p, rect };
        setBox(region);
        const anchor = anchorAt(p, [rect[0], rect[3], rect[2], rect[3]]);
        if (anchor) setMenu({ kind: "region", region, anchor: { ...anchor, h: 0 } });
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      return;
    }

    setBox(null);
    const off = hitTest(pt, x, y)!;
    if (e.detail === 2 || e.detail >= 3) {
      const [a2, b2] = e.detail === 2 ? wordAt(pt, off) : paragraphAt(pt, off);
      pendingMenu.current = true;
      setSel({ a: { page: p, off: a2 }, f: { page: p, off: b2 } });
      return;
    }
    setSel({ a: { page: p, off }, f: { page: p, off } });
    const move = (ev: MouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const f = pointAt(ev.clientX, ev.clientY);
        if (f) setSel((cur) => (cur ? { a: cur.a, f } : cur));
      });
    };
    const up = (ev: MouseEvent) => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) {
        // A click: on a highlight it opens it; anywhere else it clears.
        setSel(null);
        const hit = useReader
          .getState()
          .highlights.find((h) => h.page === p && rangeRects(pt, h.start, h.end).some((r) => x >= r[0] - 1 && x <= r[2] + 1 && y >= r[1] && y <= r[3]));
        if (hit) {
          const r = rangeRects(pt, hit.start, hit.end)[0];
          const anchor = r ? anchorAt(p, r) : null;
          if (anchor) setMenu({ kind: "highlight", highlight: hit, anchor, focusNote: false });
        }
        return;
      }
      const f = pointAt(ev.clientX, ev.clientY);
      setSel((cur) => (cur && f ? { a: cur.a, f } : cur));
      pendingMenu.current = true;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // The text cursor over text, the arrow elsewhere — set directly, no render.
  const hoverRaf = useRef(0);
  const onMouseMove = (e: React.MouseEvent) => {
    if (e.buttons) return;
    const t = e.target as HTMLElement;
    cancelAnimationFrame(hoverRaf.current);
    hoverRaf.current = requestAnimationFrame(() => {
      const stage = stageRef.current;
      if (!stage) return;
      const sheetEl = t.closest<HTMLElement>(".sheet[data-page]");
      let cursor = "";
      if (sheetEl && !t.closest("[data-ui]")) {
        const pt = pageTextNow(bookId, Number(sheetEl.dataset["page"]));
        if (useReader.getState().boxMode || e.altKey || !pt?.lines.length) cursor = "crosshair";
        else {
          const b = sheetEl.querySelector(".sheet-page")!.getBoundingClientRect();
          const x = (e.clientX - b.left) / scale;
          const y = (e.clientY - b.top) / scale;
          cursor = pt.lines.some((l) => x >= l.x0 - 2 && x <= l.x1 + 2 && y >= l.y0 && y <= l.y1) ? "text" : "";
        }
      }
      if (stage.style.cursor !== cursor) stage.style.cursor = cursor;
    });
  };

  const closeMenu = useCallback((clear = true) => {
    setMenu(null);
    if (clear) {
      setSel(null);
      setBox(null);
    }
  }, []);

  // Turning the page puts the selection away.
  useEffect(() => {
    setSel(null);
    setBox(null);
    setMenu(null);
  }, [shown]);

  // ── keys and wheel ─────────────────────────────────────────────────────
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable) return;
      const r = useReader.getState();
      const m = e.metaKey || e.ctrlKey;
      if (m && e.key === "c") {
        const s = selection();
        if (s) {
          e.preventDefault();
          void navigator.clipboard.writeText(s.quote);
        }
        return;
      }
      if (m || e.altKey) return;
      const stage = stageRef.current;
      const scrolls = !!stage && stage.scrollHeight > stage.clientHeight + 2;
      const zoomTo = (z: number) => void useApp.getState().setSettings({ pageZoom: Math.round(Math.max(1, Math.min(3, z)) * 100) / 100 });
      switch (e.key) {
        case "ArrowRight":
        case "PageDown":
          turnBy(1);
          break;
        case "ArrowLeft":
        case "PageUp":
          turnBy(-1);
          break;
        case " ":
          turnBy(e.shiftKey ? -1 : 1);
          break;
        case "ArrowDown":
          if (scrolls) return;
          turnBy(1);
          break;
        case "ArrowUp":
          if (scrolls) return;
          turnBy(-1);
          break;
        case "Home":
          r.goTo(0);
          break;
        case "End":
          r.goTo(live.current.count - 1);
          break;
        case "+":
        case "=":
          zoomTo(useApp.getState().settings.pageZoom + 0.25);
          break;
        case "-":
          zoomTo(useApp.getState().settings.pageZoom - 0.25);
          break;
        case "0":
          zoomTo(1);
          break;
        case "Escape":
          setSel(null);
          setBox(null);
          if (r.boxMode) r.set({ boxMode: false });
          else if (r.slip) r.set({ slip: null });
          else if (r.marks || r.flash) r.set({ marks: null, flash: null });
          return;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [turnBy, selection]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let acc = 0;
    let locked = false;
    let quiet: ReturnType<typeof setTimeout> | null = null;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        // Pinch on a trackpad, or Ctrl+wheel: zoom the pages.
        e.preventDefault();
        const z = useApp.getState().settings.pageZoom * Math.exp(-e.deltaY * 0.01);
        void useApp.getState().setSettings({ pageZoom: Math.round(Math.max(1, Math.min(3, z)) * 100) / 100 });
        return;
      }
      if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) return;
      e.preventDefault();
      // One gesture, one page: a trackpad's glide keeps sending events long
      // after the swipe, so the lock lifts only once they stop.
      acc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => {
        acc = 0;
        locked = false;
      }, 220);
      if (!locked && Math.abs(acc) > 40) {
        locked = true;
        turnBy(acc > 0 ? 1 : -1);
        acc = 0;
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [turnBy]);

  // ── reading ────────────────────────────────────────────────────────────
  const dwell = useRef(new Map<number, number>());
  useEffect(() => {
    const sent = new Set<number>();
    const queue: Array<{ page: number; dwellMs: number }> = [];
    let lastActive = Date.now();
    let activeMs = 0;
    const active = () => (lastActive = Date.now());
    const tick = setInterval(() => {
      if (!document.hasFocus() || document.hidden || Date.now() - lastActive > IDLE_MS) return;
      activeMs += 500;
      const read = useReader.getState().read;
      for (const p of visible) {
        if (read.has(p) || sent.has(p)) continue;
        const d = (dwell.current.get(p) ?? 0) + 500;
        dwell.current.set(p, d);
        if (d >= need(pageTextNow(bookId, p)?.text.length ?? 0)) {
          sent.add(p);
          queue.push({ page: p, dwellMs: d });
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
        const r = await api.reader.readPages(bookId, batch);
        useReader.getState().applyRead(r, batch.map((b) => b.page));
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
    return () => {
      clearInterval(tick);
      clearInterval(flusher);
      void flush();
      if (activeMs > 0) void api.reader.addTime(bookId, activeMs);
      for (const ev of events) window.removeEventListener(ev, active);
    };
  }, [bookId, visible, toast]);

  // ── drawing ────────────────────────────────────────────────────────────
  const sheet = (p: number | null | undefined, side: "left" | "right" | "single", interactive: boolean) =>
    p === null || p === undefined ? null : (
      <Sheet
        key={p}
        bookId={bookId}
        page={p}
        size={sizes[p] ?? [W, H]}
        crop={cropFor(p)}
        scale={scale}
        px={pxFor(p)}
        side={side}
        interactive={interactive}
        selection={interactive ? selRanges.get(p) : undefined}
        box={interactive && box?.page === p ? box.rect : null}
      />
    );

  let base: Array<number | null>;
  let leaf: { front: React.ReactNode; back: React.ReactNode } | null = null;
  if (!turn) base = spreadPages(shown, layout, count);
  else {
    const from = spreadPages(turn.from, layout, count);
    const to = spreadPages(turn.to, layout, count);
    if (layout === "single") {
      base = turn.dir === 1 ? to : from;
      leaf = { front: sheet(turn.dir === 1 ? from[0] : to[0], "single", false), back: null };
    } else if (turn.dir === 1) {
      base = [from[0]!, to[1]!];
      leaf = { front: sheet(from[1], "right", false), back: sheet(to[0], "left", false) };
    } else {
      base = [to[0]!, from[1]!];
      leaf = { front: sheet(from[0], "left", false), back: sheet(to[1], "right", false) };
    }
  }
  const interactive = !turn;
  const zoomed = zoom > 1.001;
  const atStart = shown === 0;
  const atEnd = nextSpread(shown, 1, layout, count) === null;

  return (
    <div className="book">
      <div
        className={`stage ${zoomed ? "zoomed" : ""} ${boxMode ? "boxing" : ""}`}
        ref={stageRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
      >
        <div className="stage-inner" style={{ padding: `${PAD_Y}px ${PAD_X}px` }}>
          <div className={`spread ${layout}`} style={{ width: layout === "spread" ? slotLeft + slotRight : slotSingle, height: slotH }}>
            {layout === "spread" ? (
              <>
                <div className="slot left" style={{ width: slotLeft, height: slotH }}>
                  {sheet(base[0], "left", interactive)}
                </div>
                <div className="slot right" style={{ width: slotRight, height: slotH }}>
                  {sheet(base[1], "right", interactive)}
                </div>
                {base[0] !== null && base[1] !== null && <div className="spine" style={{ left: slotLeft }} />}
              </>
            ) : (
              <div className="slot single" style={{ width: slotSingle, height: slotH }}>
                {sheet(base[0], "single", interactive)}
              </div>
            )}
            {turn && leaf && (
              <Leaf
                key={`${turn.from}-${turn.to}`}
                turn={turn}
                layout={layout}
                slots={layout === "single" ? [slotSingle, slotSingle] : [slotLeft, slotRight]}
                slotH={slotH}
                leaf={leaf}
                onDone={endTurn}
              />
            )}
          </div>
        </div>
      </div>
      <button className="turn-btn prev" disabled={atStart} onClick={() => turnBy(-1)} aria-label="Previous page" title="Previous page  ←">
        <ChevronLeft size={22} />
      </button>
      <button className="turn-btn next" disabled={atEnd} onClick={() => turnBy(1)} aria-label="Next page" title="Next page  →">
        <ChevronRight size={22} />
      </button>
      <PageBar visible={visible} />

      {menu?.kind === "selection" && (
        <SelectionMenu
          sel={menu.sel}
          anchor={menu.anchor}
          onClose={closeMenu}
          onNote={(h) => {
            const pt = pageTextNow(bookId, h.page);
            const r = pt ? rangeRects(pt, h.start, h.end)[0] : null;
            const anchor = r ? anchorAt(h.page, r) : null;
            if (anchor) setMenu({ kind: "highlight", highlight: h, anchor, focusNote: true });
          }}
        />
      )}
      {menu?.kind === "highlight" && (
        <HighlightMenu
          highlight={useReader.getState().highlights.find((h) => h.id === menu.highlight.id) ?? menu.highlight}
          anchor={menu.anchor}
          focusNote={menu.focusNote}
          onClose={() => closeMenu(false)}
        />
      )}
      {menu?.kind === "region" && <RegionMenu region={menu.region} anchor={menu.anchor} onClose={() => closeMenu(true)} />}
    </div>
  );
}

/** Pictures fetched and decoded ahead of the turn that shows them. */
const preloaded = new Map<string, HTMLImageElement>();
function preload(url: string) {
  if (preloaded.has(url)) return;
  const img = new Image();
  img.src = url;
  void img.decode().catch(() => {});
  preloaded.set(url, img);
  while (preloaded.size > 24) preloaded.delete(preloaded.keys().next().value!);
}

/**
 * The page being turned: a leaf hinged on the spine, the page it leaves on
 * its front and the page it brings on its back, shaded as it rises.
 */
function Leaf({
  turn,
  layout,
  slots,
  slotH,
  leaf,
  onDone,
}: {
  turn: Turn;
  layout: Layout;
  /** Widths of the left and right slots. */
  slots: [number, number];
  slotH: number;
  leaf: { front: React.ReactNode; back: React.ReactNode };
  onDone(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const single = layout === "single";
  // A spread turns about the spine; one page alone turns about its left edge.
  const hingeRight = !single && turn.dir === -1;
  const [from, to] = single ? (turn.dir === 1 ? [0, -180] : [-180, 0]) : turn.dir === 1 ? [0, -180] : [0, 180];

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const timing = { duration: turn.ms, easing: "cubic-bezier(.33,.08,.24,1)", fill: "forwards" as const };
    const anim = el.animate([{ transform: `rotateY(${from}deg)` }, { transform: `rotateY(${to}deg)` }], timing);
    const [front, back] = el.querySelectorAll<HTMLElement>(".leaf-shade");
    const rising = single && turn.dir === -1;
    front?.animate(rising ? [{ opacity: 0.5 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 0.55, offset: 0.5 }, { opacity: 0.55 }], timing);
    back?.animate(rising ? [{ opacity: 0.55 }, { opacity: 0.55, offset: 0.5 }, { opacity: 0 }] : [{ opacity: 0.55 }, { opacity: 0.55, offset: 0.5 }, { opacity: 0 }], timing);
    anim.onfinish = onDone;
    return () => anim.cancel();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={ref}
      className={`leaf ${hingeRight ? "hinge-right" : "hinge-left"}`}
      style={{
        left: single || turn.dir === -1 ? 0 : slots[0],
        width: single ? slots[0] : turn.dir === 1 ? slots[1] : slots[0],
        height: slotH,
        transform: `rotateY(${from}deg)`,
      }}
    >
      <div className={`face front slot ${single ? "single" : turn.dir === 1 ? "right" : "left"}`}>
        {leaf.front}
        <div className="leaf-shade" />
      </div>
      <div className={`face back slot ${single ? "single" : turn.dir === 1 ? "left" : "right"}`}>
        {leaf.back ?? <div className="paper-back" />}
        <div className="leaf-shade" />
      </div>
    </div>
  );
}
