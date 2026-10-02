/**
 * A block's text as runs of one style: where marks (bold, superscript, …)
 * and the reader's highlights begin and end, folded into segments the
 * reader draws one span each.
 */
import type { Highlight, Mark } from "../../../shared/types";
import { TEX } from "../../../shared/inline";
export { parseInline, TEX, TEX_DISPLAY } from "../../../shared/inline";


export interface Segment {
  s: number;
  e: number;
  f: number;
  hl: Highlight | null;
  ref: number | null;
}

export function segments(length: number, marks: Mark[], highlights: Highlight[]): Segment[] {
  // Math typeset by KaTeX is one indivisible piece: no boundary may fall inside it.
  const atoms = marks.filter((m) => m.f & TEX);
  const inAtom = (x: number) => atoms.some((a) => x > a.s && x < a.e);
  const cuts = new Set<number>([0, length]);
  for (const m of marks) {
    cuts.add(Math.max(0, Math.min(length, m.s)));
    cuts.add(Math.max(0, Math.min(length, m.e)));
  }
  for (const h of highlights) {
    cuts.add(Math.max(0, Math.min(length, h.start)));
    cuts.add(Math.max(0, Math.min(length, h.end)));
  }
  const points = [...cuts].filter((x) => !inAtom(x)).sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const s = points[i]!;
    const e = points[i + 1]!;
    if (e <= s) continue;
    let f = 0;
    let ref: number | null = null;
    for (const m of marks)
      if (m.s <= s && m.e >= e) {
        f |= m.f;
        if (m.ref) ref = m.ref;
      }
    let hl: Highlight | null = null;
    for (const h of highlights) if (h.start <= s && h.end >= e && (!hl || h.createdAt > hl.createdAt)) hl = h;
    const last = out[out.length - 1];
    if (last && last.f === f && last.hl === hl && last.ref === ref && !(f & TEX)) last.e = e;
    else out.push({ s, e, f, hl, ref });
  }
  return out;
}

/** "the quick brown" → a highlight's offsets in a text that has changed, if its words are still there. */
export function relocate(text: string, quote: string, near: number): [number, number] | null {
  if (!quote) return null;
  let best = -1;
  let at = text.indexOf(quote);
  while (at >= 0) {
    if (best < 0 || Math.abs(at - near) < Math.abs(best - near)) best = at;
    at = text.indexOf(quote, at + 1);
  }
  return best >= 0 ? [best, best + quote.length] : null;
}
