/**
 * A page's text, laid over its picture. The reader sees the PDF's own page;
 * underneath it is this: every line MuPDF found, where it sits, and where
 * each of its characters begins. Selections, highlights, the reader's own
 * versions and search marks are all character ranges into `text`, so main
 * and window must agree on it — which is why it lives here, and why the
 * helpers that measure it are pure.
 *
 * Coordinates are PDF points from the page's top-left corner.
 */

export type Rect = [number, number, number, number];

export interface PageLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Offset of the line's first character in the page text. */
  s: number;
  /** Left edge of each character, then the right edge of the last: one more than the line's length. */
  xs: number[];
  /** The MuPDF block the line came in; a block's lines are a paragraph. */
  b: number;
}

export interface PageText {
  page: number;
  width: number;
  height: number;
  /** Every line in reading order, joined by "\n". */
  text: string;
  lines: PageLine[];
  /** Where anything is printed on the page — text, pictures, rules — or null for a blank page. */
  ink: Rect | null;
}

/** The printed area of a book's pages, one for each side of the spread. */
export interface Trim {
  /** Pages with an even index: the first page, and every right-hand page. */
  even: Rect;
  odd: Rect;
}

/** The union of two rectangles. */
export function union(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export const lineLength = (l: PageLine) => l.xs.length - 1;

/** The index of the line holding `offset` (a line's end counts as its own). */
export function lineIndexAt(pt: PageText, offset: number): number {
  let lo = 0;
  let hi = pt.lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pt.lines[mid]!.s <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** One rectangle per line the range touches. */
export function rangeRects(pt: PageText, start: number, end: number): Rect[] {
  const out: Rect[] = [];
  if (end <= start || !pt.lines.length) return out;
  for (let i = lineIndexAt(pt, start); i < pt.lines.length; i++) {
    const l = pt.lines[i]!;
    if (l.s >= end) break;
    const a = Math.max(0, start - l.s);
    const b = Math.min(lineLength(l), end - l.s);
    if (b <= a) continue;
    out.push([l.xs[a]!, l.y0, l.xs[b]!, l.y1]);
  }
  return out;
}

/** The smallest rectangle around a range. */
export function rangeBox(pt: PageText, start: number, end: number): Rect | null {
  const rs = rangeRects(pt, start, end);
  if (!rs.length) return null;
  return [Math.min(...rs.map((r) => r[0])), Math.min(...rs.map((r) => r[1])), Math.max(...rs.map((r) => r[2])), Math.max(...rs.map((r) => r[3]))];
}

const dx = (l: PageLine, x: number) => (x < l.x0 ? l.x0 - x : x > l.x1 ? x - l.x1 : 0);
const dy = (l: PageLine, y: number) => (y < l.y0 ? l.y0 - y : y > l.y1 ? y - l.y1 : 0);

/**
 * The character boundary nearest a point, or null on a page without text.
 * A point level with lines belongs to the nearest of them beside it — out
 * in the margin it is still that line's end, not the longer line above —
 * and only a point between lines goes by plain distance.
 */
export function hitTest(pt: PageText, x: number, y: number): number | null {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < pt.lines.length; i++) {
    const l = pt.lines[i]!;
    if (dy(l, y) === 0 && dx(l, x) < bestD) {
      bestD = dx(l, x);
      best = i;
    }
  }
  if (best < 0)
    for (let i = 0; i < pt.lines.length; i++) {
      const l = pt.lines[i]!;
      const d = Math.hypot(dx(l, x) * 0.5, dy(l, y));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  if (best < 0) return null;
  const l = pt.lines[best]!;
  let k = 0;
  let kd = Infinity;
  for (let i = 0; i < l.xs.length; i++) {
    const d = Math.abs(l.xs[i]! - x);
    if (d < kd) {
      kd = d;
      k = i;
    }
  }
  return l.s + k;
}

/** Whether a point is over text, for the cursor. */
export function overText(pt: PageText, x: number, y: number, slack = 2): boolean {
  for (const l of pt.lines) if (x >= l.x0 - slack && x <= l.x1 + slack && y >= l.y0 && y <= l.y1) return true;
  return false;
}

const WORD = /[\p{L}\p{N}_'’-]/u;

/** The word around an offset. */
export function wordAt(pt: PageText, offset: number): [number, number] {
  const t = pt.text;
  let a = offset;
  let b = offset;
  if (!WORD.test(t[a] ?? "") && WORD.test(t[a - 1] ?? "")) a--;
  if (!WORD.test(t[a] ?? "")) return [offset, Math.min(t.length, offset + 1)];
  while (a > 0 && WORD.test(t[a - 1]!)) a--;
  while (b < t.length && WORD.test(t[b]!)) b++;
  return [a, b];
}

/** The paragraph (MuPDF block) around an offset. */
export function paragraphAt(pt: PageText, offset: number): [number, number] {
  if (!pt.lines.length) return [0, 0];
  const i = lineIndexAt(pt, offset);
  const block = pt.lines[i]!.b;
  let a = i;
  let b = i;
  while (a > 0 && pt.lines[a - 1]!.b === block) a--;
  while (b < pt.lines.length - 1 && pt.lines[b + 1]!.b === block) b++;
  const last = pt.lines[b]!;
  return [pt.lines[a]!.s, last.s + lineLength(last)];
}

/**
 * Page text as prose: lines joined with spaces, words broken across a line
 * end put back together, runs of space collapsed.
 */
export function cleanText(text: string): string {
  return text
    .replace(/(\p{L})[-‐]\n(\p{Ll})/gu, "$1$2")
    .replace(/\s*\n\s*/g, " ")
    .replace(/[ \t ]+/g, " ")
    .trim();
}

/**
 * The text folded for matching — lower case, no spaces, no line-end
 * hyphens — and, for each folded character, where it came from. Lets a
 * phrase from anywhere (a model's quote, a search, a passage the parser
 * reflowed) find itself on the page whatever the line breaks did to it.
 */
function fold(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/.test(c)) continue;
    if ((c === "-" || c === "‐") && text[i + 1] === "\n") continue;
    for (const f of c.normalize("NFKC").toLowerCase()) {
      folded += f;
      map.push(i);
    }
  }
  return { folded, map };
}

const folds = new WeakMap<PageText, ReturnType<typeof fold>>();
function foldPage(pt: PageText) {
  let f = folds.get(pt);
  if (!f) {
    f = fold(pt.text);
    folds.set(pt, f);
  }
  return f;
}

/** Where a phrase sits on the page, as a range of the page text; null when it is not there. */
export function locate(pt: PageText, phrase: string, near = 0): [number, number] | null {
  const needle = fold(phrase).folded;
  if (!needle) return null;
  const { folded, map } = foldPage(pt);
  let best = -1;
  for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + 1)) {
    if (best < 0 || Math.abs(map[at]! - near) < Math.abs(map[best]! - near)) best = at;
  }
  if (best < 0) return null;
  return [map[best]!, map[best + needle.length - 1]! + 1];
}

/** Every place any of `words` appears on the page, for marking search hits. */
export function findAll(pt: PageText, words: string[], limit = 200): Array<[number, number]> {
  const { folded, map } = foldPage(pt);
  const out: Array<[number, number]> = [];
  for (const w of words) {
    const needle = fold(w).folded;
    if (needle.length < 2) continue;
    for (let at = folded.indexOf(needle); at >= 0 && out.length < limit; at = folded.indexOf(needle, at + needle.length)) {
      out.push([map[at]!, map[at + needle.length - 1]! + 1]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** The lines inside a rectangle, as one range: how a region of the page becomes text. */
export function rangeInRect(pt: PageText, r: Rect): [number, number] | null {
  let a = -1;
  let b = -1;
  for (const l of pt.lines) {
    const cy = (l.y0 + l.y1) / 2;
    if (cy < r[1] || cy > r[3] || l.x1 < r[0] || l.x0 > r[2]) continue;
    // Within the line, only the characters inside the rectangle.
    let i = 0;
    while (i < lineLength(l) && (l.xs[i]! + l.xs[i + 1]!) / 2 < r[0]) i++;
    let j = lineLength(l);
    while (j > i && (l.xs[j - 1]! + l.xs[j]!) / 2 > r[2]) j--;
    if (j <= i) continue;
    if (a < 0 || l.s + i < a) a = l.s + i;
    if (l.s + j > b) b = l.s + j;
  }
  return a < 0 ? null : [a, b];
}
