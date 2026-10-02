/**
 * Sketch geometry, free of React and of the view: everything here works in
 * sketch coordinates and the caller sets the transform. The canvas and the
 * SVG thumbnails share one outline and one curve, so a sketch looks the same
 * in both.
 */
import { getStroke, type StrokeOptions } from "perfect-freehand";
import type { SketchData, SketchTool, Stroke } from "../../../../shared/types";

/** The color value that follows the theme's `--ink` instead of a literal. */
export const INK = "ink";
/** A marker stroke is one filled outline, so this alpha never stacks within a stroke. */
export const MARKER_OPACITY = 0.35;

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Theme values, resolved once per repaint rather than per stroke. */
export interface Theme {
  ink: string;
  font: string;
}

type Vec = [number, number];

const TOOLS = new Set<string>(["pen", "marker", "line", "arrow", "rect", "ellipse", "text"]);
const PEN_THINNING = 0.6;
const ARROW_ANGLE = 0.5;

/** Whether a stroke has enough to draw; anything else (old or hand-edited data) is skipped. */
export function isDrawable(s: Stroke): boolean {
  return TOOLS.has(s.tool) && s.points.length >= 3 && s.size > 0 && (s.tool !== "text" || !!s.text);
}

export function isFreehand(tool: SketchTool): boolean {
  return tool === "pen" || tool === "marker";
}

/**
 * Mouse and touch record a flat 0.5; those strokes get pressure simulated
 * from velocity instead, which reads far more like ink than a constant line.
 */
function hasPressure(points: number[]): boolean {
  for (let i = 2; i < points.length; i += 3) if (points[i] !== 0.5) return true;
  return false;
}

function freehandOptions(s: Stroke, last: boolean): StrokeOptions {
  if (s.tool === "marker") {
    return {
      size: s.size,
      thinning: 0,
      smoothing: 0.6,
      streamline: 0.5,
      simulatePressure: false,
      start: { cap: false },
      end: { cap: false },
      last,
    };
  }
  return {
    size: s.size,
    thinning: PEN_THINNING,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure: !hasPressure(s.points),
    last,
  };
}

/** The filled outline of a pen or marker stroke; `last` is false while it is still being drawn. */
export function freehandOutline(s: Stroke, last = true): Vec[] {
  const p = s.points;
  const input: number[][] = [];
  for (let i = 0; i + 2 < p.length; i += 3) input.push([p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0.5]);
  return getStroke(input, freehandOptions(s, last));
}

/**
 * The outline as a Path2D: quadratics through the midpoints, each outline
 * point the control. This is exactly the curve `outlineSvg` writes with T —
 * reflecting the previous control about a midpoint lands on the next point.
 */
function outlinePath(o: Vec[]): Path2D {
  const path = new Path2D();
  if (o.length < 4) return path;
  path.moveTo(o[0]![0], o[0]![1]);
  for (let i = 1; i < o.length - 1; i++) {
    const a = o[i]!;
    const b = o[i + 1]!;
    path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  path.closePath();
  return path;
}

/** A shape's two defining points: the line's ends, or opposite corners of its box. */
export function shapeEnds(s: Stroke): [number, number, number, number] {
  const p = s.points;
  const n = p.length - 3;
  return [p[0] ?? 0, p[1] ?? 0, p[n] ?? 0, p[n + 1] ?? 0];
}

/** The two barb tips of an arrow: scaled with the line weight, never longer than half the shaft. */
function arrowBarbs(x0: number, y0: number, x1: number, y1: number, size: number): [number, number, number, number] {
  const h = Math.min(6 + size * 2.5, Math.hypot(x1 - x0, y1 - y0) / 2);
  const a = Math.atan2(y1 - y0, x1 - x0);
  return [
    x1 - h * Math.cos(a - ARROW_ANGLE),
    y1 - h * Math.sin(a - ARROW_ANGLE),
    x1 - h * Math.cos(a + ARROW_ANGLE),
    y1 - h * Math.sin(a + ARROW_ANGLE),
  ];
}

function shapePath(s: Stroke): Path2D {
  const path = new Path2D();
  const [x0, y0, x1, y1] = shapeEnds(s);
  if (s.tool === "rect") {
    path.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  } else if (s.tool === "ellipse") {
    path.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
  } else {
    path.moveTo(x0, y0);
    path.lineTo(x1, y1);
    if (s.tool === "arrow") {
      const [ax, ay, bx, by] = arrowBarbs(x0, y0, x1, y1, s.size);
      path.moveTo(ax, ay);
      path.lineTo(x1, y1);
      path.lineTo(bx, by);
    }
  }
  return path;
}

/** Shift-drag: lines snap to 45°, boxes to squares. */
export function constrain(tool: SketchTool, x0: number, y0: number, x1: number, y1: number): Vec {
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (tool === "rect" || tool === "ellipse") {
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    return [x0 + (dx < 0 ? -d : d), y0 + (dy < 0 ? -d : d)];
  }
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  const len = Math.hypot(dx, dy);
  return [x0 + Math.cos(a) * len, y0 + Math.sin(a) * len];
}

/** Text width without a canvas to measure on. Generous, since it only bounds culling, erasing and thumbnails. */
function textWidth(s: Stroke): number {
  return (s.text?.length ?? 0) * s.size * 0.6;
}

const boundsCache = new WeakMap<Stroke, Bounds>();

/** Bounds including stroke width. Cached, so only call it on committed (immutable) strokes. */
export function strokeBounds(s: Stroke): Bounds {
  const cached = boundsCache.get(s);
  if (cached) return cached;
  const p = s.points;
  let b: Bounds;
  if (s.tool === "text") {
    const x = p[0] ?? 0;
    const y = p[1] ?? 0;
    b = { minX: x, minY: y - s.size / 2, maxX: x + textWidth(s), maxY: y + s.size / 2 };
  } else {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i + 1 < p.length; i += 3) {
      const x = p[i]!;
      const y = p[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    // A pen at full pressure is wider than its nominal size; arrow barbs reach past the shaft.
    const r =
      s.tool === "pen" ? s.size * (0.5 + PEN_THINNING / 2) : s.tool === "arrow" ? s.size / 2 + 6 + s.size * 2.5 : s.size / 2;
    b = { minX: minX - r, minY: minY - r, maxX: maxX + r, maxY: maxY + r };
  }
  boundsCache.set(s, b);
  return b;
}

export function sketchBounds(strokes: readonly Stroke[]): Bounds | null {
  if (!strokes.length) return null;
  const out = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const s of strokes) {
    const b = strokeBounds(s);
    out.minX = Math.min(out.minX, b.minX);
    out.minY = Math.min(out.minY, b.minY);
    out.maxX = Math.max(out.maxX, b.maxX);
    out.maxY = Math.max(out.maxY, b.maxY);
  }
  return out;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/**
 * Whether (x, y) lies within `r` of what the stroke actually draws — its
 * line, not the inside of a box or ellipse, so erasing near a shape's middle
 * leaves it alone. Text is hit anywhere in its box.
 */
export function hitStroke(s: Stroke, x: number, y: number, r: number): boolean {
  const b = strokeBounds(s);
  if (x < b.minX - r || x > b.maxX + r || y < b.minY - r || y > b.maxY + r) return false;
  if (s.tool === "text") return true;
  const tol = r + s.size / 2;
  const p = s.points;
  if (isFreehand(s.tool)) {
    if (p.length < 6) return Math.hypot(x - p[0]!, y - p[1]!) <= tol;
    for (let i = 3; i + 1 < p.length; i += 3) {
      if (segDist(x, y, p[i - 3]!, p[i - 2]!, p[i]!, p[i + 1]!) <= tol) return true;
    }
    return false;
  }
  const [x0, y0, x1, y1] = shapeEnds(s);
  switch (s.tool) {
    case "rect":
      return (
        segDist(x, y, x0, y0, x1, y0) <= tol ||
        segDist(x, y, x1, y0, x1, y1) <= tol ||
        segDist(x, y, x1, y1, x0, y1) <= tol ||
        segDist(x, y, x0, y1, x0, y0) <= tol
      );
    case "ellipse": {
      // A 48-gon is within a hair of the curve and, unlike radial distance, exact enough for flat ellipses.
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const rx = Math.abs(x1 - x0) / 2;
      const ry = Math.abs(y1 - y0) / 2;
      let px = cx + rx;
      let py = cy;
      for (let i = 1; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        const qx = cx + rx * Math.cos(a);
        const qy = cy + ry * Math.sin(a);
        if (segDist(x, y, px, py, qx, qy) <= tol) return true;
        px = qx;
        py = qy;
      }
      return false;
    }
    case "arrow": {
      const [ax, ay, bx, by] = arrowBarbs(x0, y0, x1, y1, s.size);
      if (segDist(x, y, ax, ay, x1, y1) <= tol || segDist(x, y, bx, by, x1, y1) <= tol) return true;
      return segDist(x, y, x0, y0, x1, y1) <= tol;
    }
    default:
      return segDist(x, y, x0, y0, x1, y1) <= tol;
  }
}

const pathCache = new WeakMap<Stroke, Path2D>();

/**
 * Paints one stroke. Committed outlines are cached as Path2D, so a repaint
 * after a pan or zoom is only fills; `live` bypasses the cache for the
 * stroke still being drawn, whose points grow every frame.
 */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, theme: Theme, live = false): void {
  const color = s.color === INK ? theme.ink : s.color;
  if (s.tool === "text") {
    const text = s.text ?? "";
    ctx.font = `${s.size}px ${theme.font}`;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = color;
    const m = ctx.measureText(text);
    // Where a CSS line box of line-height 1 puts the baseline, so text lands exactly where it was typed.
    ctx.fillText(text, s.points[0] ?? 0, (s.points[1] ?? 0) + (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2);
    return;
  }
  const freehand = isFreehand(s.tool);
  let path = live ? undefined : pathCache.get(s);
  if (!path) {
    path = freehand ? outlinePath(freehandOutline(s, !live)) : shapePath(s);
    if (!live) pathCache.set(s, path);
  }
  if (freehand) {
    ctx.globalAlpha = s.tool === "marker" ? MARKER_OPACITY : 1;
    ctx.fillStyle = color;
    ctx.fill(path);
    ctx.globalAlpha = 1;
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = s.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke(path);
  }
}

/* ── SVG ─────────────────────────────────────────────────────────────────── */

/** One decimal is below a thumbnail's pixel and keeps the markup small. */
function n1(v: number): string {
  return String(Math.round(v * 10) / 10);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** perfect-freehand's getSvgPathFromStroke: one Q, then a T per midpoint. */
function outlineSvg(o: Vec[]): string {
  if (o.length < 4) return "";
  const pt = (v: Vec) => `${n1(v[0])},${n1(v[1])}`;
  const mid = (i: number) => {
    const a = o[i]!;
    const b = o[i + 1]!;
    return `${n1((a[0] + b[0]) / 2)},${n1((a[1] + b[1]) / 2)}`;
  };
  let d = `M${pt(o[0]!)}Q${pt(o[1]!)} ${mid(1)}T`;
  for (let i = 2; i < o.length - 1; i++) d += (i > 2 ? " " : "") + mid(i);
  return `${d}Z`;
}

function strokeSvg(s: Stroke): string {
  const c = esc(s.color === INK ? "currentColor" : s.color);
  if (isFreehand(s.tool)) {
    const d = outlineSvg(freehandOutline(s));
    if (!d) return "";
    return `<path d="${d}" fill="${c}"${s.tool === "marker" ? ` fill-opacity="${MARKER_OPACITY}"` : ""}/>`;
  }
  if (s.tool === "text") {
    const [x = 0, y = 0] = s.points;
    return `<text x="${n1(x)}" y="${n1(y)}" font-size="${n1(s.size)}" font-family="inherit" dominant-baseline="central" fill="${c}">${esc(s.text ?? "")}</text>`;
  }
  const line = `stroke="${c}" stroke-width="${n1(s.size)}"`;
  const [x0, y0, x1, y1] = shapeEnds(s);
  switch (s.tool) {
    case "rect":
      return `<rect x="${n1(Math.min(x0, x1))}" y="${n1(Math.min(y0, y1))}" width="${n1(Math.abs(x1 - x0))}" height="${n1(Math.abs(y1 - y0))}" ${line}/>`;
    case "ellipse":
      return `<ellipse cx="${n1((x0 + x1) / 2)}" cy="${n1((y0 + y1) / 2)}" rx="${n1(Math.abs(x1 - x0) / 2)}" ry="${n1(Math.abs(y1 - y0) / 2)}" ${line}/>`;
    case "arrow": {
      const [ax, ay, bx, by] = arrowBarbs(x0, y0, x1, y1, s.size);
      const tip = `${n1(x1)},${n1(y1)}`;
      return `<path d="M${n1(x0)},${n1(y0)}L${tip}M${n1(ax)},${n1(ay)}L${tip}L${n1(bx)},${n1(by)}" ${line}/>`;
    }
    default:
      return `<line x1="${n1(x0)}" y1="${n1(y0)}" x2="${n1(x1)}" y2="${n1(y1)}" ${line}/>`;
  }
}

/**
 * A standalone SVG of the whole sketch with its viewBox fit to the drawing,
 * for thumbnails. Ink is written as `currentColor`, so a thumbnail follows
 * the CSS `color` of wherever it is shown. `maxWidth` caps the intrinsic
 * width (height follows); the viewBox keeps everything in proportion.
 */
export function sketchToSvg(data: SketchData, opts: { padding?: number; maxWidth?: number } = {}): string {
  const strokes = data.strokes.filter(isDrawable);
  const b = sketchBounds(strokes);
  const open = `<svg xmlns="http://www.w3.org/2000/svg"`;
  if (!b) return `${open} viewBox="0 0 64 40" width="64" height="40"/>`;
  const pad = opts.padding ?? 16;
  const w = b.maxX - b.minX + pad * 2;
  const h = b.maxY - b.minY + pad * 2;
  const k = opts.maxWidth && w > opts.maxWidth ? opts.maxWidth / w : 1;
  return (
    `${open} viewBox="${n1(b.minX - pad)} ${n1(b.minY - pad)} ${n1(w)} ${n1(h)}" width="${n1(w * k)}" height="${n1(h * k)}"` +
    ` fill="none" stroke-linecap="round" stroke-linejoin="round">${strokes.map(strokeSvg).join("")}</svg>`
  );
}
