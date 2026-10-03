/**
 * A page's text layer: the extractor's lines, with where each character
 * starts, moved to the page's own top-left corner and rounded to a tenth
 * of a point (plenty for a pointer, and a third the size as JSON).
 */
import type { PageLine, PageText, Rect, Trim } from "../../shared/pages.js";
import type { Extractor, XPage } from "./extract.js";

const r = (v: number) => Math.round(v * 10) / 10;

/**
 * The page's furniture: running heads, page numbers and footers, with the
 * rules that go with them. A small cluster of lines at the very top or
 * bottom of the page, set apart from the rest by a gap wider than the
 * page's own line spacing; the band it sits in is the furniture's, and
 * trimming the margin may cut it away. Returns the bands' inner edges.
 */
function furniture(p: XPage): { top: number; bottom: number } {
  const bands = { top: -Infinity, bottom: Infinity };
  const lines = [...p.lines].sort((a, b) => a.y0 - b.y0);
  if (lines.length < 6) return bands;
  const steps = lines
    .slice(1)
    .map((l, i) => l.y0 - lines[i]!.y0)
    .filter((d) => d > 1)
    .sort((a, b) => a - b);
  const step = steps[Math.floor(steps.length / 2)] ?? 12;
  const edge = (from: number, dir: 1 | -1) => {
    // The cluster: lines no further than a line and a half from the one before.
    const cluster = [lines[from]!];
    for (let i = from + dir; i >= 0 && i < lines.length && cluster.length <= 5; i += dir) {
      const last = cluster[cluster.length - 1]!;
      const gap = dir === 1 ? lines[i]!.y0 - last.y0 : last.y0 - lines[i]!.y0;
      if (gap <= step * 1.5) {
        cluster.push(lines[i]!);
        continue;
      }
      const inMargin = dir === 1 ? last.y1 < p.y0 + p.height * 0.16 : last.y0 > p.y0 + p.height * 0.84;
      if (gap > step * 1.8 && inMargin) {
        if (dir === 1) bands.top = (last.y1 + lines[i]!.y0) / 2;
        else bands.bottom = (lines[i]!.y1 + last.y0) / 2;
      }
      return;
    }
  };
  edge(0, 1);
  edge(lines.length - 1, -1);
  return bands;
}

/**
 * Where the page's matter is printed: text, pictures, and drawn shapes —
 * not its furniture, and not a shape that covers most of the page, which
 * is a background, not ink.
 */
export function inkBox(p: XPage): Rect | null {
  const area = p.width * p.height;
  const { top, bottom } = furniture(p);
  const matter = (b: Rect) => b[1] >= top && b[3] <= bottom;
  const boxes: Rect[] = [
    ...p.lines.map((l): Rect => [l.x0, l.y0, l.x1, l.y1]),
    ...p.images.map((i) => i.bbox),
    ...p.vectors.filter((v) => (v.bbox[2] - v.bbox[0]) * (v.bbox[3] - v.bbox[1]) < area * 0.5).map((v) => v.bbox),
  ].filter(matter);
  if (!boxes.length) return null;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  return [
    r(clamp(Math.min(...boxes.map((b) => b[0])) - p.x0, p.width)),
    r(clamp(Math.min(...boxes.map((b) => b[1])) - p.y0, p.height)),
    r(clamp(Math.max(...boxes.map((b) => b[2])) - p.x0, p.width)),
    r(clamp(Math.max(...boxes.map((b) => b[3])) - p.y0, p.height)),
  ];
}

export function bookTrim(ex: Extractor, count: number, pad = 14): Trim | null {
  const sample: number[] = [];
  const from = Math.floor(count * 0.08);
  const to = Math.ceil(count * 0.92);
  const n = Math.min(48, to - from);
  for (let i = 0; i < n; i++) sample.push(from + Math.floor(((to - from) * i) / n));
  const sides: Record<"even" | "odd", Rect[]> = { even: [], odd: [] };
  let width = 0;
  let height = 0;
  for (const i of sample) {
    const p = ex.page(i);
    const ink = inkBox(p);
    width = Math.max(width, p.width);
    height = Math.max(height, p.height);
    // A page with next to nothing on it (a part title) says little about margins.
    if (ink && (ink[2] - ink[0]) * (ink[3] - ink[1]) > p.width * p.height * 0.15) sides[i % 2 === 0 ? "even" : "odd"].push(ink);
  }
  const pick = (boxes: Rect[], k: number, low: boolean) => {
    const v = boxes.map((b) => b[k]!).sort((a, b) => a - b);
    return v[Math.floor((low ? 0.06 : 0.94) * (v.length - 1))]!;
  };
  const side = (boxes: Rect[]): Rect | null =>
    boxes.length < 3
      ? null
      : [
          r(Math.max(0, pick(boxes, 0, true) - pad)),
          r(Math.max(0, pick(boxes, 1, true) - pad)),
          r(Math.min(width, pick(boxes, 2, false) + pad)),
          r(Math.min(height, pick(boxes, 3, false) + pad)),
        ];
  const even = side(sides.even);
  const odd = side(sides.odd);
  if (!even && !odd) return null;
  return { even: even ?? odd!, odd: odd ?? even! };
}

export function pageText(ex: Extractor, index: number): PageText {
  const p = ex.page(index);
  const lines: PageLine[] = [];
  let text = "";
  for (const l of p.lines) {
    if (!l.xs || l.xs.length !== l.text.length + 1) continue;
    if (lines.length) text += "\n";
    lines.push({
      x0: r(l.x0 - p.x0),
      y0: r(l.y0 - p.y0),
      x1: r(l.x1 - p.x0),
      y1: r(l.y1 - p.y0),
      s: text.length,
      xs: l.xs.map((x) => r(x - p.x0)),
      b: l.block,
    });
    text += l.text;
  }
  return { page: index, width: r(p.width), height: r(p.height), text, lines, ink: inkBox(p) };
}
