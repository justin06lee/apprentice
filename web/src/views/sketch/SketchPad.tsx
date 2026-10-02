/**
 * The sketch pad: a small infinite canvas for drawing beside the text.
 *
 * Drawing never goes through React. An Engine owns the canvas, the pointer
 * stream, the view and the stroke list. Committed strokes are painted into
 * an offscreen cache that repaints only when the strokes, the view, the size
 * or the theme change; each animation frame blits that cache and draws the
 * one stroke in progress on top. React renders the toolbar and the inline
 * text input, and hears about edits through a few callbacks.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX, type MouseEvent } from "react";
import {
  Circle,
  Eraser,
  Hand,
  Highlighter,
  Maximize2,
  Minus,
  MoveUpRight,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import type { SketchData, SketchTool, Stroke } from "../../../../shared/types";
import {
  INK,
  constrain,
  drawStroke,
  isDrawable,
  isFreehand,
  hitStroke,
  shapeEnds,
  sketchBounds,
  strokeBounds,
  type Theme,
} from "./render";
import "../../styles/sketch.css";

export interface SketchPadProps {
  /** Starting strokes. Read once on mount: key the pad by sketch to switch sketches. */
  initial: SketchData;
  /** Called ~400ms after the last edit, undo or redo, and on unmount if a save is pending. */
  onChange(data: SketchData): void;
  /** Fixed height in px; by default the pad fills its parent. */
  height?: number;
}

type Tool = SketchTool | "eraser" | "hand";
type Level = 0 | 1 | 2;

/** Stroke size per tool and weight, in sketch units: pen diameter, marker width, line width, font size. */
const SIZES: Record<SketchTool, readonly [number, number, number]> = {
  pen: [2.5, 4.5, 8],
  marker: [12, 20, 32],
  line: [1.5, 2.5, 4.5],
  arrow: [1.5, 2.5, 4.5],
  rect: [1.5, 2.5, 4.5],
  ellipse: [1.5, 2.5, 4.5],
  text: [14, 20, 28],
};
/** Eraser radius per weight, in screen pixels, so it feels the same at any zoom. */
const ERASER = [6, 10, 18] as const;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;
const HISTORY = 200;
const SAVE_DELAY = 400;
/** Grid pitch at 100%, in sketch units. */
const GRID = 24;
/** Freehand samples closer than this many screen pixels add nothing but bytes. */
const MIN_STEP = 0.75;

const MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
const UNDO_KEY = MAC ? "⌘Z" : "Ctrl+Z";
const REDO_KEY = MAC ? "⇧⌘Z" : "Ctrl+Shift+Z";

const TOOLS: ReadonlyArray<{ id: Tool; label: string; key: string; Icon: LucideIcon }> = [
  { id: "pen", label: "Pen", key: "P", Icon: Pencil },
  { id: "marker", label: "Marker", key: "M", Icon: Highlighter },
  { id: "line", label: "Line", key: "L", Icon: Minus },
  { id: "arrow", label: "Arrow", key: "A", Icon: MoveUpRight },
  { id: "rect", label: "Rectangle", key: "R", Icon: Square },
  { id: "ellipse", label: "Ellipse", key: "O", Icon: Circle },
  { id: "text", label: "Text", key: "T", Icon: Type },
  { id: "eraser", label: "Eraser", key: "E", Icon: Eraser },
  { id: "hand", label: "Pan", key: "H, or hold Space", Icon: Hand },
];
const TOOL_KEYS: Record<string, Tool | undefined> = {
  p: "pen",
  m: "marker",
  l: "line",
  a: "arrow",
  r: "rect",
  o: "ellipse",
  t: "text",
  e: "eraser",
  h: "hand",
};
const COLORS = [
  { value: INK, label: "Ink" },
  { value: "#e5484d", label: "Red" },
  { value: "#3b82f6", label: "Blue" },
  { value: "#30a46c", label: "Green" },
  { value: "#f76b15", label: "Orange" },
  { value: "#8e4ec6", label: "Purple" },
] as const;
const WEIGHTS = [
  { level: 0, label: "Thin", dot: 4 },
  { level: 1, label: "Medium", dot: 7 },
  { level: 2, label: "Thick", dot: 11 },
] as const;

const cssColor = (c: string) => (c === INK ? "var(--ink)" : c);
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
const round2 = (v: number) => Math.round(v * 100) / 100;
const mod = (a: number, m: number) => ((a % m) + m) % m;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Real pressure from pens; everything else records 0.5, which render.ts reads as "simulate it". */
function pressureOf(e: PointerEvent): number {
  return e.pointerType === "pen" && e.pressure > 0 ? round2(e.pressure) : 0.5;
}

/** Every sample the hardware delivered since the last event, not just the latest. */
function coalesced(e: PointerEvent): PointerEvent[] {
  const list = e.getCoalescedEvents?.();
  return list && list.length ? list : [e];
}

function readTheme(): Theme {
  const css = getComputedStyle(document.documentElement);
  return {
    ink: css.getPropertyValue("--ink").trim() || "#1d1c1a",
    font: css.getPropertyValue("--font-ui").trim() || "system-ui, sans-serif",
  };
}

function isEditable(el: Element | null): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/* ── engine ──────────────────────────────────────────────────────────────── */

interface Point {
  x: number;
  y: number;
}

/** screen = sketch × z + (x, y), in CSS pixels. */
interface View {
  x: number;
  y: number;
  z: number;
}

/** Undo entries. Erased strokes keep their index so undo restores the stacking order. */
type Op =
  | { kind: "add"; strokes: Stroke[] }
  | { kind: "erase"; items: Array<{ index: number; stroke: Stroke }> }
  | { kind: "clear"; strokes: Stroke[] };

interface DrawGesture {
  kind: "draw";
  id: number;
  touch: boolean;
  stroke: Stroke;
  start: Point;
  end: Point;
}
interface EraseGesture {
  kind: "erase";
  id: number;
  touch: boolean;
  before: Stroke[];
  gone: Set<Stroke>;
  at: Point;
}
/** `at` is in screen space for a pan, sketch space for a tap. */
interface PointGesture {
  kind: "pan" | "tap";
  id: number;
  touch: boolean;
  at: Point;
}
interface PinchGesture {
  kind: "pinch";
  dist: number;
  mid: Point;
  view: View;
}
type Gesture = DrawGesture | EraseGesture | PointGesture | PinchGesture;

/** A text label being typed, in sketch coordinates; (x, y) is the left end of its middle line. */
interface TextEdit {
  x: number;
  y: number;
  color: string;
  size: number;
}

interface Hooks {
  /** The strokes changed through an edit, undo or redo. */
  edited(): void;
  history(canUndo: boolean, canRedo: boolean): void;
  openText(at: TextEdit): void;
  /** Commits an open text label; whether there was one. */
  finishText(): boolean;
}

interface Elements {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  grid: HTMLElement;
  zoom: HTMLElement;
}

class Engine {
  strokes: Stroke[];
  tool: Tool = "pen";
  color: string = INK;
  level: Level = 1;
  /** The pointer is over the pad; keyboard shortcuts apply while it is, even without focus. */
  hovered = false;

  private readonly el: Elements;
  private readonly hooks: Hooks;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cache = document.createElement("canvas");
  private readonly cacheCtx: CanvasRenderingContext2D;
  private view: View = { x: 0, y: 0, z: 1 };
  private width = 0;
  private height = 0;
  private dpr = 1;
  private fitted = false;
  /** The cache (and the grid and zoom label) must repaint before the next blit. */
  private dirty = true;
  private raf = 0;
  private theme: Theme;
  private undos: Op[] = [];
  private redos: Op[] = [];
  private gesture: Gesture | null = null;
  /** The canvas rect, measured once per gesture rather than per move. */
  private rect: DOMRect | null = null;
  private readonly touches = new Map<number, Point>();
  private hover: Point | null = null;
  private space = false;
  private shift = false;
  private text: { el: HTMLElement; x: number; y: number; size: number } | null = null;
  private readonly cleanup: Array<() => void> = [];

  constructor(el: Elements, strokes: Stroke[], hooks: Hooks) {
    this.el = el;
    this.hooks = hooks;
    this.strokes = strokes.filter(isDrawable);
    this.theme = readTheme();
    const ctx = el.canvas.getContext("2d");
    const cacheCtx = this.cache.getContext("2d");
    if (!ctx || !cacheCtx) throw new Error("2D canvas is unavailable");
    this.ctx = ctx;
    this.cacheCtx = cacheCtx;
    el.zoom.textContent = "100%";

    const { root, canvas } = el;
    this.listen(canvas, "pointerdown", this.onDown);
    this.listen(canvas, "pointermove", this.onMove);
    this.listen(canvas, "pointerup", this.onUp);
    this.listen(canvas, "pointercancel", this.onUp);
    this.listen(canvas, "lostpointercapture", this.onUp);
    this.listen(canvas, "pointerleave", () => {
      if (!this.gesture && this.hover) {
        this.hover = null;
        this.request();
      }
    });
    // Focus is placed by pointerdown; the mouse's default would move it again, away from a fresh text input.
    this.listen(canvas, "mousedown", (e) => e.preventDefault());
    this.listen(canvas, "contextmenu", (e) => e.preventDefault());
    this.listen(root, "wheel", this.onWheel, { passive: false });
    this.listen(root, "pointerenter", () => {
      this.hovered = true;
    });
    this.listen(root, "pointerleave", () => {
      this.hovered = false;
    });

    const ro = new ResizeObserver(([entry]) => {
      if (entry) this.resize(entry);
    });
    try {
      ro.observe(canvas, { box: "device-pixel-content-box" });
    } catch {
      ro.observe(canvas);
    }
    // Themes switch by attribute on <html>; webfonts can land after the first paint of a label.
    const mo = new MutationObserver(this.refreshTheme);
    mo.observe(document.documentElement, { attributes: true });
    document.fonts.addEventListener("loadingdone", this.refreshTheme);
    this.cleanup.push(() => {
      ro.disconnect();
      mo.disconnect();
      document.fonts.removeEventListener("loadingdone", this.refreshTheme);
    });
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const off of this.cleanup) off();
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, fn, opts);
    this.cleanup.push(() => target.removeEventListener(type, fn, opts));
  }

  /* settings */

  setTool(tool: Tool): void {
    this.tool = tool;
    this.updateCursor();
    this.request();
  }

  setSpace(on: boolean): void {
    if (this.space === on) return;
    this.space = on;
    this.updateCursor();
  }

  setShift(on: boolean): void {
    if (this.shift === on) return;
    this.shift = on;
    const g = this.gesture;
    if (g?.kind === "draw" && !isFreehand(g.stroke.tool)) {
      this.placeEnd(g);
      this.request();
    }
  }

  bindText(text: { el: HTMLElement; x: number; y: number; size: number } | null): void {
    this.text = text;
    this.placeText();
  }

  /* history */

  /** Adds a finished stroke (the text tool's labels come in this way). */
  add(s: Stroke): void {
    const stroke = { ...s, id: newId(), points: s.points.map(round2) };
    this.strokes = [...this.strokes, stroke];
    this.push({ kind: "add", strokes: [stroke] });
  }

  clear(): void {
    this.abort();
    const strokes = this.strokes;
    if (!strokes.length) return;
    this.strokes = [];
    this.push({ kind: "clear", strokes });
  }

  undo(): void {
    this.abort();
    const op = this.undos.pop();
    if (!op) return;
    this.apply(op, false);
    this.redos.push(op);
    this.edited();
  }

  redo(): void {
    this.abort();
    const op = this.redos.pop();
    if (!op) return;
    this.apply(op, true);
    this.undos.push(op);
    this.edited();
  }

  private push(op: Op): void {
    this.undos.push(op);
    if (this.undos.length > HISTORY) this.undos.shift();
    this.redos = [];
    this.edited();
  }

  private edited(): void {
    this.dirty = true;
    this.request();
    this.hooks.edited();
    this.hooks.history(this.undos.length > 0, this.redos.length > 0);
  }

  /** Strict stack order means the list always matches the state right after `op`, or right before it. */
  private apply(op: Op, forward: boolean): void {
    switch (op.kind) {
      case "add": {
        if (forward) this.strokes = [...this.strokes, ...op.strokes];
        else {
          const drop = new Set(op.strokes);
          this.strokes = this.strokes.filter((s) => !drop.has(s));
        }
        return;
      }
      case "erase": {
        if (forward) {
          const drop = new Set(op.items.map((i) => i.stroke));
          this.strokes = this.strokes.filter((s) => !drop.has(s));
        } else {
          const next = this.strokes.slice();
          for (const { index, stroke } of op.items) next.splice(index, 0, stroke);
          this.strokes = next;
        }
        return;
      }
      case "clear":
        this.strokes = forward ? [] : op.strokes;
    }
  }

  /** Drops the gesture in progress, putting back anything a half-finished erase took. */
  abort(): boolean {
    const g = this.gesture;
    if (!g) return false;
    this.gesture = null;
    if (g.kind === "erase" && g.gone.size) {
      this.strokes = g.before;
      this.dirty = true;
    }
    this.updateCursor();
    this.request();
    return true;
  }

  /* view */

  zoomAt(factor: number, cx: number, cy: number): void {
    const v = this.view;
    const z = clampZoom(v.z * factor);
    const k = z / v.z;
    this.view = { x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, z };
    this.viewChanged();
  }

  zoomBy(factor: number): void {
    this.zoomAt(factor, this.width / 2, this.height / 2);
  }

  zoomReset(): void {
    this.zoomBy(1 / this.view.z);
  }

  /** Frames the drawing, never above 100%, clear of the toolbar; an empty sketch returns to the origin. */
  fitView(): void {
    const b = sketchBounds(this.strokes);
    if (!b || !this.width) this.view = { x: 0, y: 0, z: 1 };
    else {
      const top = 56;
      const side = 32;
      const w = Math.max(b.maxX - b.minX, 1);
      const h = Math.max(b.maxY - b.minY, 1);
      const z = clampZoom(Math.min(1, (this.width - side * 2) / w, (this.height - top - side) / h));
      this.view = {
        z,
        x: (this.width - w * z) / 2 - b.minX * z,
        y: top + (this.height - top - side - h * z) / 2 - b.minY * z,
      };
    }
    this.viewChanged();
  }

  private viewChanged(): void {
    this.dirty = true;
    this.request();
  }

  private toSketch(p: Point): Point {
    const v = this.view;
    return { x: (p.x - v.x) / v.z, y: (p.y - v.y) / v.z };
  }

  /* pointers */

  private local(e: { clientX: number; clientY: number }, r: DOMRect): Point {
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown = (e: PointerEvent): void => {
    // Commit an open label here rather than trusting its blur, which an unfocused window never sends.
    const editing = this.hooks.finishText();
    if (document.activeElement !== this.el.root) this.el.root.focus({ preventScroll: true });
    const r = this.el.canvas.getBoundingClientRect();
    const p = this.local(e, r);
    const touch = e.pointerType === "touch";
    if (touch) {
      this.touches.set(e.pointerId, p);
      // A second finger turns whatever the first started into a pinch; a resting palm never interrupts a pen.
      const g = this.gesture;
      if (this.touches.size === 2 && (!g || (g.kind !== "pinch" && g.touch))) {
        this.abort();
        this.startPinch(r);
        return;
      }
    }
    if (this.gesture) return;

    const tool = this.tool;
    const at = this.toSketch(p);
    const base = { id: e.pointerId, touch };
    const penEraser = e.pointerType === "pen" && e.button === 5;
    if (tool === "hand" || e.button === 1 || this.space) {
      this.gesture = { kind: "pan", ...base, at: p };
    } else if (tool === "eraser" || penEraser) {
      const g: EraseGesture = { kind: "erase", ...base, before: this.strokes, gone: new Set(), at };
      this.gesture = g;
      this.eraseTo(g, at);
    } else if (e.button !== 0) {
      return;
    } else if (tool === "text") {
      // A click while a label is open only finishes that label. Otherwise the label opens on release,
      // so a touch that becomes a pinch never leaves one behind.
      if (editing) {
        e.preventDefault();
        return;
      }
      this.gesture = { kind: "tap", ...base, at };
    } else {
      const pr = pressureOf(e);
      const points = isFreehand(tool) ? [at.x, at.y, pr] : [at.x, at.y, pr, at.x, at.y, pr];
      const stroke: Stroke = { id: "", tool, color: this.color, size: SIZES[tool][this.level], points };
      this.gesture = { kind: "draw", ...base, stroke, start: at, end: at };
    }
    e.preventDefault();
    this.el.canvas.setPointerCapture(e.pointerId);
    this.rect = r;
    this.hover = p;
    this.updateCursor();
    this.request();
  };

  private onMove = (e: PointerEvent): void => {
    const g = this.gesture;
    const r = (g && this.rect) || this.el.canvas.getBoundingClientRect();
    const p = this.local(e, r);
    if (this.touches.has(e.pointerId)) this.touches.set(e.pointerId, p);
    if (!g) {
      this.hover = p;
      if (this.tool === "eraser") this.request();
      return;
    }
    if (g.kind === "pinch") {
      this.pinch(g);
      return;
    }
    if (e.pointerId !== g.id) return;
    this.hover = p;
    switch (g.kind) {
      case "pan":
        this.view.x += p.x - g.at.x;
        this.view.y += p.y - g.at.y;
        g.at = p;
        this.viewChanged();
        return;
      case "tap":
        return;
      case "draw": {
        const s = g.stroke;
        if (isFreehand(s.tool)) {
          const min = MIN_STEP / this.view.z;
          for (const c of coalesced(e)) {
            const q = this.toSketch(this.local(c, r));
            const n = s.points.length;
            if (Math.hypot(q.x - s.points[n - 3]!, q.y - s.points[n - 2]!) < min) continue;
            s.points.push(q.x, q.y, pressureOf(c));
          }
        } else {
          this.shift = e.shiftKey;
          g.end = this.toSketch(p);
          this.placeEnd(g);
        }
        break;
      }
      case "erase":
        for (const c of coalesced(e)) this.eraseTo(g, this.toSketch(this.local(c, r)));
        break;
    }
    this.request();
  };

  private onUp = (e: PointerEvent): void => {
    this.touches.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === "pinch") {
      if (this.touches.size < 2) this.gesture = null;
      return;
    }
    if (e.pointerId !== g.id) return;
    if (e.type === "pointercancel") {
      this.abort();
      return;
    }
    this.gesture = null;
    if (g.kind === "draw") this.commitDraw(g);
    else if (g.kind === "tap") this.hooks.openText({ ...g.at, color: this.color, size: SIZES.text[this.level] });
    else if (g.kind === "erase" && g.gone.size) {
      const items: Array<{ index: number; stroke: Stroke }> = [];
      g.before.forEach((stroke, index) => {
        if (g.gone.has(stroke)) items.push({ index, stroke });
      });
      this.push({ kind: "erase", items });
    }
    this.updateCursor();
    this.request();
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinches arrive as ctrl+wheel with small deltas; a mouse notch is clamped to one ZOOM_STEP.
      const r = this.el.canvas.getBoundingClientRect();
      this.zoomAt(2 ** (-Math.max(-32, Math.min(32, dy)) / 100), e.clientX - r.left, e.clientY - r.top);
      return;
    }
    if (e.shiftKey && !dx) {
      dx = dy;
      dy = 0;
    }
    this.view.x -= dx;
    this.view.y -= dy;
    this.viewChanged();
  };

  private startPinch(r: DOMRect): void {
    const [a, b] = [...this.touches.values()];
    if (!a || !b) return;
    this.rect = r;
    this.gesture = {
      kind: "pinch",
      dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      view: { ...this.view },
    };
  }

  /** The sketch point that was under the fingers' midpoint stays under it as they spread and move. */
  private pinch(g: PinchGesture): void {
    const [a, b] = [...this.touches.values()];
    if (!a || !b) return;
    const z = clampZoom((g.view.z * Math.hypot(b.x - a.x, b.y - a.y)) / g.dist);
    const sx = (g.mid.x - g.view.x) / g.view.z;
    const sy = (g.mid.y - g.view.y) / g.view.z;
    this.view = { x: (a.x + b.x) / 2 - sx * z, y: (a.y + b.y) / 2 - sy * z, z };
    this.viewChanged();
  }

  /** Moves a shape's far corner to the pointer, constrained while Shift is held. */
  private placeEnd(g: DrawGesture): void {
    const { start, end, stroke } = g;
    const [x, y] = this.shift ? constrain(stroke.tool, start.x, start.y, end.x, end.y) : [end.x, end.y];
    stroke.points[3] = x;
    stroke.points[4] = y;
  }

  private commitDraw(g: DrawGesture): void {
    const s = g.stroke;
    if (!isFreehand(s.tool)) {
      const [x0, y0, x1, y1] = shapeEnds(s);
      if (Math.hypot(x1 - x0, y1 - y0) * this.view.z < 3) return; // a click, not a shape
    }
    this.add(s);
  }

  /** Erases every stroke the eraser passes over between its last position and `to`. */
  private eraseTo(g: EraseGesture, to: Point): void {
    const r = ERASER[this.level] / this.view.z;
    const from = g.at;
    // Sample the sweep at half the radius, so a fast flick still catches a thin line.
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / (r / 2)));
    const minX = Math.min(from.x, to.x) - r;
    const minY = Math.min(from.y, to.y) - r;
    const maxX = Math.max(from.x, to.x) + r;
    const maxY = Math.max(from.y, to.y) + r;
    let hit = false;
    for (const s of this.strokes) {
      const b = strokeBounds(s);
      if (b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY) continue;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        if (hitStroke(s, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, r)) {
          g.gone.add(s);
          hit = true;
          break;
        }
      }
    }
    g.at = to;
    if (hit) {
      this.strokes = g.before.filter((s) => !g.gone.has(s));
      this.dirty = true;
    }
  }

  /* painting */

  private resize(entry: ResizeObserverEntry): void {
    const { width, height } = entry.contentRect;
    const device = entry.devicePixelContentBoxSize?.[0];
    const ratio = window.devicePixelRatio || 1;
    const pw = device ? device.inlineSize : Math.round(width * ratio);
    const ph = device ? device.blockSize : Math.round(height * ratio);
    this.width = width;
    this.height = height;
    if (!width || !height || !pw || !ph) return;
    this.dpr = pw / width;
    for (const c of [this.el.canvas, this.cache]) {
      c.width = pw;
      c.height = ph;
    }
    if (!this.fitted) {
      this.fitted = true;
      this.fitView();
    }
    // Resizing cleared the canvas; repaint now, before the browser shows it blank.
    this.dirty = true;
    cancelAnimationFrame(this.raf);
    this.frame();
  }

  private refreshTheme = (): void => {
    const theme = readTheme();
    if (theme.ink === this.theme.ink && theme.font === this.theme.font) return;
    this.theme = theme;
    this.dirty = true;
    this.request();
  };

  private request(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    this.raf = 0;
    if (!this.width) return;
    const { ctx, dpr, view: v } = this;
    const canvas = this.el.canvas;
    if (this.dirty) {
      this.dirty = false;
      this.paintCache();
      this.placeChrome();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.cache, 0, 0);
    const g = this.gesture;
    if (g?.kind === "draw") {
      ctx.setTransform(dpr * v.z, 0, 0, dpr * v.z, dpr * v.x, dpr * v.y);
      drawStroke(ctx, g.stroke, this.theme, true);
    }
    if (this.tool === "eraser" && this.hover && (!g || g.kind === "erase")) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath();
      ctx.arc(this.hover.x, this.hover.y, ERASER[this.level], 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle = this.theme.ink;
      ctx.globalAlpha = 0.06;
      ctx.fill();
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  };

  /** Paints the committed strokes that intersect the viewport into the cache. */
  private paintCache(): void {
    const c = this.cacheCtx;
    const { x, y, z } = this.view;
    const d = this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.cache.width, this.cache.height);
    c.setTransform(d * z, 0, 0, d * z, d * x, d * y);
    const minX = -x / z;
    const minY = -y / z;
    const maxX = minX + this.width / z;
    const maxY = minY + this.height / z;
    for (const s of this.strokes) {
      const b = strokeBounds(s);
      if (b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY) continue;
      drawStroke(c, s, this.theme);
    }
  }

  /** The DOM that follows the view: the dot grid, the zoom readout, an open text label. */
  private placeChrome(): void {
    const { x, y, z } = this.view;
    // Keep the dots 12–48px apart at any zoom by doubling or halving the pitch.
    let step = GRID * z;
    while (step < 12) step *= 2;
    while (step > 48) step /= 2;
    const s = this.el.grid.style;
    s.backgroundSize = `${step}px ${step}px`;
    s.backgroundPosition = `${mod(x - step / 2, step)}px ${mod(y - step / 2, step)}px`;
    this.el.zoom.textContent = `${Math.round(z * 100)}%`;
    this.placeText();
  }

  private placeText(): void {
    const t = this.text;
    if (!t) return;
    const { x, y, z } = this.view;
    t.el.style.transform = `translate(${t.x * z + x}px, ${(t.y - t.size / 2) * z + y}px) scale(${z})`;
  }

  private updateCursor(): void {
    const g = this.gesture;
    this.el.canvas.style.cursor =
      g?.kind === "pan"
        ? "grabbing"
        : this.space || this.tool === "hand"
          ? "grab"
          : this.tool === "eraser"
            ? "none"
            : this.tool === "text"
              ? "text"
              : "crosshair";
  }
}

/* ── component ───────────────────────────────────────────────────────────── */

/** Toolbar buttons keep focus where it was, so shortcuts and an open text label survive a click. */
const keepFocus = (e: MouseEvent) => e.preventDefault();

export function SketchPad({ initial, onChange, height }: SketchPadProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const initialRef = useRef(initial);
  const onChangeRef = useRef(onChange);
  const saveTimer = useRef(0);
  /** Mirrors `text` so the engine and blur handlers see it without waiting for a render. */
  const textRef = useRef<TextEdit | null>(null);

  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<string>(INK);
  const [level, setLevel] = useState<Level>(1);
  const [hist, setHist] = useState({ undo: false, redo: false });
  const [text, setTextState] = useState<TextEdit | null>(null);

  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });

  const setText = useCallback((t: TextEdit | null) => {
    textRef.current = t;
    setTextState(t);
  }, []);

  const flush = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = 0;
    const engine = engineRef.current;
    if (engine) onChangeRef.current({ version: 1, strokes: engine.strokes });
  }, []);

  /** Ends text editing, adding the label unless it is blank. Safe to call twice. */
  const commitText = useCallback(
    (value = inputRef.current?.value ?? "") => {
      const t = textRef.current;
      if (!t) return;
      setText(null);
      const label = value.trim();
      if (label) engineRef.current?.add({ id: "", tool: "text", color: t.color, size: t.size, points: [t.x, t.y, 0.5], text: label });
    },
    [setText],
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const grid = gridRef.current;
    const zoom = zoomRef.current;
    if (!root || !canvas || !grid || !zoom) return;
    const engine = new Engine({ root, canvas, grid, zoom }, initialRef.current.strokes, {
      edited: () => {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(flush, SAVE_DELAY);
      },
      history: (undo, redo) => setHist((h) => (h.undo === undo && h.redo === redo ? h : { undo, redo })),
      openText: setText,
      finishText: () => {
        const open = textRef.current !== null;
        commitText();
        return open;
      },
    });
    engineRef.current = engine;
    return () => {
      if (saveTimer.current) flush();
      engine.destroy();
      engineRef.current = null;
    };
  }, [flush, setText, commitText]);

  // Layout effects, so the engine has the new setting before the next pointer event can arrive.
  useLayoutEffect(() => {
    engineRef.current?.setTool(tool);
  }, [tool]);
  useLayoutEffect(() => {
    const engine = engineRef.current;
    if (engine) engine.color = color;
  }, [color]);
  useLayoutEffect(() => {
    const engine = engineRef.current;
    if (engine) {
      engine.level = level;
      engine.setTool(engine.tool); // the eraser ring changes size
    }
  }, [level]);

  // Bind the label to the engine before paint, so it never shows at the wrong place.
  useLayoutEffect(() => {
    const el = inputRef.current;
    engineRef.current?.bindText(text && el ? { el, x: text.x, y: text.y, size: text.size } : null);
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }, [text]);

  const selectTool = useCallback(
    (t: Tool) => {
      if (textRef.current) commitText();
      setTool(t);
    },
    [commitText],
  );

  // A label being typed takes on a newly picked color or weight.
  const selectColor = (c: string) => {
    setColor(c);
    if (textRef.current) setText({ ...textRef.current, color: c });
  };
  const selectLevel = (l: Level) => {
    setLevel(l);
    if (textRef.current) setText({ ...textRef.current, size: SIZES.text[l] });
  };

  const clear = useCallback(() => {
    const engine = engineRef.current;
    if (engine?.strokes.length && window.confirm("Clear the whole sketch? You can undo this.")) engine.clear();
  }, []);

  // Shortcuts apply while the pad has focus or the pointer is over it, never while typing anywhere.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const handle = (e: KeyboardEvent, engine: Engine): boolean => {
      const key = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (e.altKey) return false;
        if (key === "z") {
          if (e.shiftKey) engine.redo();
          else engine.undo();
          return true;
        }
        if (key === "y" && !e.shiftKey) {
          engine.redo();
          return true;
        }
        return false;
      }
      if (e.altKey) return false;
      if (key === " ") {
        if (e.target instanceof HTMLButtonElement) return false; // Space presses a keyboard-focused button
        if (!e.repeat) engine.setSpace(true);
        return true;
      }
      const tool = TOOL_KEYS[key];
      if (tool) {
        selectTool(tool);
        return true;
      }
      switch (key) {
        case "delete":
          clear();
          return true;
        case "0":
          engine.fitView();
          return true;
        case "+":
        case "=":
          engine.zoomBy(ZOOM_STEP);
          return true;
        case "-":
        case "_":
          engine.zoomBy(1 / ZOOM_STEP);
          return true;
        case "escape":
          return engine.abort();
      }
      return false;
    };
    const down = (e: KeyboardEvent) => {
      const engine = engineRef.current;
      if (!engine) return;
      if (e.key === "Shift") engine.setShift(true);
      if (e.defaultPrevented || isEditable(document.activeElement)) return;
      if (!engine.hovered && !root.contains(document.activeElement)) return;
      if (handle(e, engine)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === " ") engineRef.current?.setSpace(false);
      if (e.key === "Shift") engineRef.current?.setShift(false);
    };
    const blur = () => {
      engineRef.current?.setSpace(false);
      engineRef.current?.setShift(false);
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
    };
  }, [selectTool, clear]);

  const refocus = () => rootRef.current?.focus({ preventScroll: true });

  return (
    <div
      ref={rootRef}
      className="sk-pad"
      style={height === undefined ? undefined : { height }}
      tabIndex={0}
      role="application"
      aria-label="Sketch pad"
    >
      <div ref={gridRef} className="sk-grid" aria-hidden="true" />
      <canvas ref={canvasRef} className="sk-canvas" />
      {text && (
        <input
          key={`${text.x},${text.y}`}
          ref={inputRef}
          className="sk-text"
          style={{ fontSize: text.size, color: cssColor(text.color) }}
          aria-label="Text label"
          spellCheck={false}
          autoComplete="off"
          onBlur={(e) => commitText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitText(e.currentTarget.value);
              refocus();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setText(null);
              refocus();
            }
          }}
        />
      )}

      <div className="sk-toolbar" role="toolbar" aria-label="Sketch tools" onMouseDown={keepFocus}>
        <div className="sk-group">
          {TOOLS.map(({ id, label, key, Icon }) => (
            <button
              key={id}
              type="button"
              className={`icon-btn small${tool === id ? " on" : ""}`}
              aria-label={label}
              aria-pressed={tool === id}
              title={`${label} (${key})`}
              onClick={() => selectTool(id)}
            >
              <Icon size={16} />
            </button>
          ))}
        </div>
        <div className="sk-group">
          {COLORS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`sk-swatch${color === value ? " on" : ""}`}
              aria-label={`${label} color`}
              aria-pressed={color === value}
              title={label}
              onClick={() => selectColor(value)}
            >
              <span style={{ background: cssColor(value) }} />
            </button>
          ))}
        </div>
        <div className="sk-group">
          {WEIGHTS.map((w) => (
            <button
              key={w.level}
              type="button"
              className={`icon-btn small sk-weight${level === w.level ? " on" : ""}`}
              aria-label={`${w.label} stroke`}
              aria-pressed={level === w.level}
              title={w.label}
              onClick={() => selectLevel(w.level)}
            >
              <i style={{ width: w.dot, height: w.dot }} />
            </button>
          ))}
        </div>
        <div className="sk-group">
          <button
            type="button"
            className="icon-btn small"
            aria-label="Undo"
            title={`Undo (${UNDO_KEY})`}
            disabled={!hist.undo}
            onClick={() => engineRef.current?.undo()}
          >
            <Undo2 size={16} />
          </button>
          <button
            type="button"
            className="icon-btn small"
            aria-label="Redo"
            title={`Redo (${REDO_KEY})`}
            disabled={!hist.redo}
            onClick={() => engineRef.current?.redo()}
          >
            <Redo2 size={16} />
          </button>
          <button type="button" className="icon-btn small" aria-label="Clear sketch" title="Clear sketch (Delete)" onClick={clear}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="sk-zoom" role="toolbar" aria-label="Zoom" onMouseDown={keepFocus}>
        <button type="button" className="icon-btn small" aria-label="Zoom out" title="Zoom out (−)" onClick={() => engineRef.current?.zoomBy(1 / ZOOM_STEP)}>
          <ZoomOut size={16} />
        </button>
        <button type="button" className="sk-zoom-level" aria-label="Reset zoom to 100%" title="Reset zoom to 100%" onClick={() => engineRef.current?.zoomReset()}>
          <span ref={zoomRef} />
        </button>
        <button type="button" className="icon-btn small" aria-label="Zoom in" title="Zoom in (+)" onClick={() => engineRef.current?.zoomBy(ZOOM_STEP)}>
          <ZoomIn size={16} />
        </button>
        <button type="button" className="icon-btn small" aria-label="Fit drawing" title="Fit drawing (0)" onClick={() => engineRef.current?.fitView()}>
          <Maximize2 size={16} />
        </button>
      </div>
    </div>
  );
}
