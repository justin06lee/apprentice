/**
 * Book analysis: every page's lines, images and shapes → the blocks and
 * sections apprentice reads from.
 *
 * Runs once per import, over the whole book at once, because almost every
 * decision is relative to the rest of the book. "Body text" is whichever
 * size most characters are set in; a running head is a line that recurs at
 * the edge of many pages; a heading is a line styled like the lines the
 * PDF's own outline points at. The passes, in order:
 *
 *   1. furniture   running heads, footers and page numbers are dropped
 *   2. regions     figures (images and drawn diagrams, with their labels),
 *                  boxed callouts, and tables become regions of the page
 *   3. equations   display math becomes a region too — rendered, not
 *                  reflowed, because reflowed math is unreadable
 *   4. footnotes   small text at the foot of a page, opened by a marker,
 *                  linked back to the superscript that refers to it
 *   5. headings    the PDF outline when it has one, matched to the lines it
 *                  names; type styles otherwise
 *   6. assembly    lines → paragraphs, list items and code, across blocks,
 *                  columns and page breaks, hyphenation undone where the
 *                  book itself spells the word without one
 *
 * Every region that is shown as an image is described by an AssetRequest;
 * the worker renders those from the page afterwards.
 */
import type { BlockType, Mark, SectionKind } from "../../shared/types.js";
import { F, type FontInfo, type Rect, type XLine, type XPage } from "./extract.js";

export interface OutlineEntry {
  title: string;
  level: number;
  page: number;
}

export type AssetKind = "figure" | "equation" | "table";

export interface AssetRequest {
  page: number;
  bbox: Rect;
  kind: AssetKind;
  /** Pixels per PDF point. */
  scale: number;
  /** Photographs go out as JPEG; drawings and math as PNG. */
  photo: boolean;
}

export interface PBlock {
  type: BlockType;
  level: number;
  text: string;
  marks: Mark[];
  page: number;
  bbox: Rect | null;
  asset: AssetRequest | null;
  boxed: number;
  label: string | null;
  /** Footnotes: `${page}:${label}`, which references point at. */
  fnKey?: string;
  /** Superscript references to footnotes, by key, resolved to ids on save. */
  refs?: Array<{ s: number; e: number; key: string }>;
}

export interface PSection {
  title: string;
  level: number;
  /** Index into `blocks` of the heading that opens the section. */
  blockIndex: number;
  page: number;
  kind: SectionKind;
}

export interface ParsedBook {
  title: string | null;
  author: string | null;
  blocks: PBlock[];
  sections: PSection[];
  bodySize: number;
  warnings: string[];
}

type Role = "body" | "furniture" | "heading" | "footnote" | "figure" | "equation" | "table" | "caption" | "code";

interface ALine extends XLine {
  page: number;
  role: Role;
  boxed: number;
  /** Heading: its level, and which heading it belongs to when one spans lines. */
  hLevel?: number;
  hId?: number;
  /** Footnote: the note it belongs to. */
  fnId?: number;
}

interface Region {
  boxed?: number;
  kind: AssetKind;
  page: number;
  bbox: Rect;
  photo: boolean;
  order: number;
  text: string;
  caption: ALine[];
  captionAbove: boolean;
}

interface Footnote {
  id: number;
  page: number;
  label: string;
  lines: ALine[];
}

// ─── geometry ────────────────────────────────────────────────────────────

const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const overlaps = (a: Rect, b: Rect, pad = 0) =>
  a[0] - pad < b[2] && b[0] - pad < a[2] && a[1] - pad < b[3] && b[1] - pad < a[3];
const union = (a: Rect, b: Rect): Rect => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];
const rectOf = (l: XLine): Rect => [l.x0, l.y0, l.x1, l.y1];
const centerIn = (l: XLine, r: Rect, pad = 0) => {
  const cx = (l.x0 + l.x1) / 2;
  const cy = (l.y0 + l.y1) / 2;
  return cx >= r[0] - pad && cx <= r[2] + pad && cy >= r[1] - pad && cy <= r[3] + pad;
};

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]!;
}

// ─── text ────────────────────────────────────────────────────────────────

const ROMAN = /^(?=[ivxlcdm]+$)m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;
const TERMINAL = /[.!?:]["”’')\]]*$/;
const BULLET = /^([•◦▪▫‣⁃●○■□►▸–—·∙∗*])\s+/;
const ENUMERATOR = /^(\(?(?:\d{1,2}|[a-z]|[ivx]{1,4})[.)])\s+(?=\S)/;
const CAPTION = /^(fig(?:ure)?|table|tab\.|exhibit|chart|diagram|plate|illustration|listing|graph|map|photo)\.?\s*[\dA-Z]/i;
const HEADING_LABEL =
  /^((?:[Cc]hapter|CHAPTER|[Pp]art|PART|[Aa]ppendix|APPENDIX|[Ss]ection|[Ll]ecture|[Uu]nit|[Ll]esson|[Mm]odule|[Bb]ook)\s+[\dIVXLCDMA-Z]+[.:]?|\d+(?:\.\d+)*\.?|[A-Z]\.\d+(?:\.\d+)*\.?|\d+[A-Z]|[IVXLC]+\.)\s+(.+)$/;
const FOOTNOTE_MARK = /^([0-9]{1,3}|[*†‡§¶‖]+|[a-z])$/;

function normKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Title tokens without the numbering in front ("Chapter 2", "1.3", "2A"). */
function titleTokens(text: string): string[] {
  // Outlines spell math the way the source did ("R^n", "F_2"); the page
  // prints it as letters with a raised or lowered index.
  const t = tokens(text.replace(/[\^_{}$\\]/g, ""));
  let i = 0;
  while (i < t.length && i < 3) {
    const w = t[i]!;
    if (/^\d+[a-z]?$/.test(w) || ROMAN.test(w) || /^(chapter|part|appendix|section|lecture|unit|lesson)$/.test(w)) i++;
    else break;
  }
  return t.slice(i);
}

function dice(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const counts = new Map<string, number>();
  for (const w of a) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of b) {
    const c = counts.get(w);
    if (c) {
      common++;
      counts.set(w, c - 1);
    }
  }
  return (2 * common) / (a.length + b.length);
}

export function sectionKind(title: string): SectionKind {
  const t = title.toLowerCase().replace(/^[\d.\s]+/, "").trim();
  if (/^(contents|table of contents|brief contents|detailed contents|contents in brief)$/.test(t)) return "contents";
  if (/^(index|subject index|author index|name index|general index|symbol index|index of symbols|notation index)$/.test(t))
    return "index";
  if (/^(bibliography|references|works cited|further reading|selected references)$/.test(t)) return "bibliography";
  if (
    /^(preface|foreword|acknowledg|dedication|about the author|about this book|copyright|title page|cover|half title|colophon|list of (figures|tables)|epigraph)/.test(
      t,
    )
  )
    return "front";
  if (/^(exercises?|problems?|review questions|practice problems|homework)\b/.test(t)) return "exercises";
  return "body";
}

// ─── the analysis ────────────────────────────────────────────────────────

export function analyze(
  pages: XPage[],
  fonts: FontInfo[],
  outline: OutlineEntry[],
  meta: { title: string | null; author: string | null },
): ParsedBook {
  const warnings: string[] = [];
  const all: ALine[][] = pages.map((p) =>
    p.lines.map((l) => ({ ...l, page: p.index, role: "body" as Role, boxed: 0 })),
  );

  for (const lines of all) mergeRows(lines);

  // Body size and font: whatever most characters are set in.
  const sizeVotes = new Map<number, number>();
  const fontVotes = new Map<number, number>();
  let totalChars = 0;
  for (const lines of all)
    for (const l of lines) {
      const k = Math.round(l.size * 2) / 2;
      sizeVotes.set(k, (sizeVotes.get(k) ?? 0) + l.n);
      fontVotes.set(l.font, (fontVotes.get(l.font) ?? 0) + l.n);
      totalChars += l.n;
    }
  let body = 10;
  let bestVotes = -1;
  for (const [k, v] of sizeVotes) if (v > bestVotes) [body, bestVotes] = [k, v];
  let bodyFont = 0;
  bestVotes = -1;
  for (const [k, v] of fontVotes) if (v > bestVotes) [bodyFont, bestVotes] = [k, v];
  const bodyFlags = (fonts[bodyFont]?.flags ?? 0) & (F.BOLD | F.ITALIC);

  if (totalChars < pages.length * 40) {
    warnings.push(
      "This PDF has little or no text layer — it may be a scan. apprentice reads the text a PDF carries; scanned pages show as page images only.",
    );
  }

  // Where the text column sits on each page, from its body lines.
  const columns = pages.map((p, i) => {
    const bodyLines = all[i]!.filter((l) => Math.abs(l.size - body) < 0.8 && l.n > 20);
    if (bodyLines.length < 3) return { left: p.width * 0.12, right: p.width * 0.88 };
    return { left: percentile(bodyLines.map((l) => l.x0), 0.1), right: percentile(bodyLines.map((l) => l.x1), 0.9) };
  });

  markFurniture(pages, all, body);
  const regions = detectRegions(pages, all, body);
  regions.push(...detectEquations(pages, all, body, columns));
  regions.push(...detectTables(pages, all, body));
  const footnotes = detectFootnotes(pages, all, body);
  const hasOutline = outline.length >= 3;
  let headingCount = hasOutline ? matchOutline(outline, pages, all, body) : 0;
  if (hasOutline && headingCount < outline.length * 0.3) {
    warnings.push("The PDF's outline did not match its pages well; headings were found by their type instead.");
    for (const lines of all) for (const l of lines) if (l.role === "heading") l.role = "body";
    headingCount = 0;
  }
  detectStyledHeadings(pages, all, body, fonts, headingCount > 0);
  joinChapterLabels(all);
  for (const lines of all)
    for (const l of lines) {
      if (l.role === "body" && l.n > 0 && l.mono / l.n >= 0.85) l.role = "code";
    }

  const dictionary = buildDictionary(all);
  const blocks = assemble(pages, all, regions, footnotes, body, bodyFlags, columns, dictionary);
  const sections = sectionsFrom(blocks);

  const title = meta.title?.trim() || guessTitle(all, body);
  return { title: title || null, author: meta.author?.trim() || null, blocks, sections, bodySize: body, warnings };
}

/**
 * MuPDF breaks a printed line wherever there is a wide gap: between a
 * section number and its title, a bullet and its item, code and its
 * comment, the cells of a table row. Inside one block those pieces are one
 * line, so they are joined here — once, before anything classifies them —
 * and the number of real gaps is kept, which is what makes a table a table.
 */
function mergeRows(lines: ALine[]): void {
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1]!;
    const b = lines[i]!;
    if (a.block !== b.block || Math.abs(a.baseline - b.baseline) > Math.min(a.size, b.size) * 0.3 || b.x0 < a.x1 - 1) continue;
    const mono = a.mono > a.n * 0.8 && b.mono > b.n * 0.8;
    const cw = a.charWidth || b.charWidth || a.size * 0.5;
    const gap = b.x0 - a.x1;
    const pad = mono ? " ".repeat(Math.max(1, Math.round(gap / cw))) : " ";
    const last = a.spans[a.spans.length - 1]!;
    lines[i - 1] = {
      ...a,
      x1: b.x1,
      y0: Math.min(a.y0, b.y0),
      y1: Math.max(a.y1, b.y1),
      text: a.text + pad + b.text,
      spans: [...a.spans, { ...last, text: pad }, ...b.spans],
      size: a.n >= b.n ? a.size : b.size,
      n: a.n + b.n,
      bold: a.bold + b.bold,
      italic: a.italic + b.italic,
      mono: a.mono + b.mono,
      math: a.math + b.math,
      cells: a.cells + b.cells - (gap > Math.max(a.size, b.size) * 1.0 ? 0 : 1),
    };
    lines.splice(i, 1);
    i--;
  }
}

// ─── 1. furniture ────────────────────────────────────────────────────────

function markFurniture(pages: XPage[], all: ALine[][], body: number): void {
  const edges: ALine[][][] = [];
  const seen = new Map<string, number>();
  for (const p of pages) {
    const lines = all[p.index]!.filter((l) => l.n > 0).sort((a, b) => a.y0 - b.y0);
    const rows: ALine[][] = [];
    for (const l of lines) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row[0]!.y0 - l.y0) < 2.5) row.push(l);
      else rows.push([l]);
    }
    const edge: ALine[][] = [];
    for (const row of rows.slice(0, 2)) if (row[0]!.y1 < p.height * 0.16) edge.push(row);
    for (const row of rows.slice(-2)) if (row[0]!.y0 > p.height * 0.84 && !edge.includes(row)) edge.push(row);
    edges.push(edge);
    // A running head is the same words in the same place, page after page.
    // Position is part of the key so that an ordinary line that happens to
    // end several pages ("return x") is not mistaken for one.
    const keys = new Set(edge.flat().map(furnitureKey));
    for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  // Printed page numbers run at a fixed offset from the PDF's own page
  // count (front matter in roman, then 1 where the PDF says 23). Learn it
  // from the bare numbers at page edges, so a stray "42" of program output
  // at the foot of a page is not taken for one.
  const offsets = new Map<number, number>();
  for (const p of pages)
    for (const row of edges[p.index]!)
      for (const l of row) {
        const t = l.text.trim();
        if (/^\d{1,4}$/.test(t)) {
          const off = Number(t) - (p.index + 1);
          offsets.set(off, (offsets.get(off) ?? 0) + 1);
        }
      }
  let offset: number | null = null;
  let votes = 2;
  for (const [off, count] of offsets) if (count > votes) [offset, votes] = [off, count];

  for (const p of pages) {
    const label = p.label.toLowerCase();
    const number = String(p.index + 1);
    const printed = offset === null ? null : String(p.index + 1 + offset);
    const isPageNumber = (l: ALine) => {
      const text = l.text.trim().toLowerCase().replace(/^[-–—\s]*(page\s+)?/, "").replace(/(\s+of\s+\d+)?[-–—\s]*$/, "");
      if (ROMAN.test(text)) return text === label || l.n <= 6;
      if (!/^\d{1,4}$/.test(text)) return false;
      return text === label || text === number || text === printed;
    };
    for (const row of edges[p.index]!) {
      // A page number takes its whole row with it: "3.3. Composition   19".
      const numbered = row.some(isPageNumber);
      for (const l of row) {
        const text = l.text.trim().toLowerCase();
        const words = text.split(/\s+/);
        const repeated = /\p{L}{3}/u.test(text) && (seen.get(furnitureKey(l)) ?? 0) >= 3;
        const ends = [words[0], words[words.length - 1]];
        const carriesNumber =
          l.size <= body * 1.08 && words.length > 1 && (ends.includes(label) || (printed !== null && ends.includes(printed)));
        if (isPageNumber(l) || (repeated && l.size <= body * 1.3) || carriesNumber || (numbered && l.size <= body * 1.1 && l.n < 90))
          l.role = "furniture";
      }
    }
  }
}

function furnitureKey(l: XLine): string {
  return `${normKey(l.text)}@${Math.round(l.y0 / 6)}`;
}

// ─── 2. figures, boxes, regions ──────────────────────────────────────────

function detectRegions(pages: XPage[], all: ALine[][], body: number): Region[] {
  const regions: Region[] = [];
  let boxId = 0;
  for (const p of pages) {
    const lines = all[p.index]!;
    const pageArea = p.width * p.height;
    interface El {
      r: Rect;
      kind: "img" | "vec" | "rule";
      filledRect: boolean;
      rect: boolean;
      photo: boolean;
      order: number;
    }
    const els: El[] = [];
    for (const img of p.images) {
      const a = area(img.bbox);
      if (a < 150 || a > pageArea * 0.9) continue;
      const w = img.bbox[2] - img.bbox[0];
      els.push({ r: img.bbox, kind: "img", filledRect: false, rect: false, photo: img.w * img.h > 40000 && w > 60, order: img.order });
    }
    for (const v of p.vectors) {
      const w = v.bbox[2] - v.bbox[0];
      const h = v.bbox[3] - v.bbox[1];
      if (w < 0.6 && h < 0.6) continue;
      if (area(v.bbox) > pageArea * 0.85) continue;
      const rule = h <= 1.6 || w <= 1.6;
      els.push({ r: v.bbox, kind: rule ? "rule" : "vec", filledRect: v.rect && !v.stroked, rect: v.rect, photo: false, order: Infinity });
    }
    if (!els.length) continue;

    // Union-find over overlapping shapes. A thin rule only joins a cluster
    // it touches; on its own it is a fraction bar or a separator.
    const parent = els.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    const order = els.map((_, i) => i).sort((a, b) => els[a]!.r[1] - els[b]!.r[1]);
    for (let x = 0; x < order.length; x++) {
      const a = els[order[x]!]!;
      for (let y = x + 1; y < order.length; y++) {
        const b = els[order[y]!]!;
        if (b.r[1] > a.r[3] + 4) break;
        const pad = a.kind === "rule" || b.kind === "rule" ? 1 : 3;
        if (overlaps(a.r, b.r, pad)) parent[find(order[x]!)] = find(order[y]!);
      }
    }
    const clusters = new Map<number, El[]>();
    els.forEach((e, i) => {
      const root = find(i);
      const list = clusters.get(root);
      if (list) list.push(e);
      else clusters.set(root, [e]);
    });

    for (const members of clusters.values()) {
      let bbox = members[0]!.r;
      for (const m of members) bbox = union(bbox, m.r);
      const w = bbox[2] - bbox[0];
      const h = bbox[3] - bbox[1];
      const hasImage = members.some((m) => m.kind === "img");
      // Curves and polygons make a drawing. Rectangles alone make a band, a
      // panel, a shaded cell — unless several stand side by side, which is
      // a bar chart.
      const rects = members.filter((m) => m.kind === "vec" && m.rect);
      const loose = rects.filter((r) => !rects.some((o) => o !== r && area(o.r) > area(r.r) && overlaps(o.r, r.r, -0.5)));
      const shapes = members.filter((m) => m.kind === "vec" && !m.rect).length + (loose.length >= 3 ? loose.length : 0);
      // A frame around the whole page is decoration.
      if (!hasImage && area(bbox) > pageArea * 0.55) continue;
      const inside = lines.filter((l) => l.role === "body" && centerIn(l, bbox, 1));
      const insideChars = inside.reduce((s, l) => s + l.n, 0);
      // A shaded code listing stays code.
      if (!hasImage && insideChars > 0 && inside.reduce((s, l) => s + l.mono, 0) >= insideChars * 0.6) continue;
      const proseChars = inside
        .filter((l) => l.n >= 35 && l.size >= body * 0.85 && l.mono < l.n * 0.5)
        .reduce((s, l) => s + l.n, 0);

      // A tinted or framed panel around running text — a theorem, a margin
      // note, a definition — is a callout, not a figure: its text stays
      // text, drawn inside a box. What gives it away is density. Text
      // fills a panel; a diagram is mostly lines with a few labels.
      const coverage = inside.reduce((s, l) => s + area(rectOf(l)), 0) / Math.max(1, area(bbox));
      const drawn = members.filter((m) => m.kind === "vec" && !m.rect).length;
      const texty = insideChars >= 30 && (coverage >= 0.2 || proseChars >= insideChars * 0.45);
      if (!hasImage && texty && drawn <= 4) {
        if (w > 60 && h > body * 1.5) {
          boxId++;
          for (const l of inside) l.boxed = boxId;
        }
        continue;
      }
      if (!hasImage && (shapes < 2 || w < 40 || h < 24)) continue;
      if (hasImage && w * h < 900) continue;

      // Labels drawn around the shapes — axis ticks, callouts — belong to
      // the figure. Grow it to take them in, but never to take in prose.
      let grown = bbox;
      for (let pass = 0; pass < 2; pass++) {
        for (const l of lines) {
          if (l.role !== "body") continue;
          const prose = l.n >= 45 && l.size >= body * 0.9;
          if (prose && !centerIn(l, grown, 0)) continue;
          if (centerIn(l, grown, 0) || (overlaps(rectOf(l), grown, 5) && l.n < 40)) grown = union(grown, rectOf(l));
        }
      }
      const taken = lines.filter((l) => l.role === "body" && centerIn(l, grown, 1));
      // A big image with paragraphs on it is a page background, not a figure.
      const takenProse = taken.filter((l) => l.n >= 45 && l.size >= body * 0.9).length;
      if (takenProse > 4) continue;
      for (const l of taken) l.role = "figure";
      const ordered = [...taken].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
      const firstOrder = Math.min(
        ...members.filter((m) => m.kind === "img").map((m) => m.order),
        ...taken.map((l) => l.order),
      );
      regions.push({
        kind: "figure",
        page: p.index,
        bbox: grown,
        photo: members.some((m) => m.photo) && shapes < 4,
        order: Number.isFinite(firstOrder) ? firstOrder : orderAt(lines, grown),
        text: ordered.map((l) => l.text).join(" "),
        caption: [],
        captionAbove: false,
      });
    }
  }

  // Merge figures that overlap (an image with a drawn frame and labels can
  // arrive as several clusters).
  const merged: Region[] = [];
  for (const r of regions.sort((a, b) => a.page - b.page || a.bbox[1] - b.bbox[1])) {
    const last = merged.find((m) => m.page === r.page && overlaps(m.bbox, r.bbox, 2));
    if (last) {
      last.bbox = union(last.bbox, r.bbox);
      last.order = Math.min(last.order, r.order);
      last.text = `${last.text} ${r.text}`.trim();
      last.photo = last.photo && r.photo;
    } else merged.push(r);
  }

  // Captions: the block right below a figure (or right above it) that
  // starts like one, or failing that, small or italic text hugging it.
  for (const r of merged) {
    const lines = all[r.page]!.filter((l) => l.role === "body");
    const byBlock = new Map<number, ALine[]>();
    for (const l of lines) {
      const list = byBlock.get(l.block);
      if (list) list.push(l);
      else byBlock.set(l.block, [l]);
    }
    let best: ALine[] | null = null;
    let above = false;
    let bestGap = Infinity;
    for (const group of byBlock.values()) {
      const first = group[0]!;
      const top = Math.min(...group.map((l) => l.y0));
      const bottom = Math.max(...group.map((l) => l.y1));
      const hOverlap = Math.min(r.bbox[2], Math.max(...group.map((l) => l.x1))) - Math.max(r.bbox[0], Math.min(...group.map((l) => l.x0)));
      if (hOverlap < 10) continue;
      const below = top - r.bbox[3];
      const aboveGap = r.bbox[1] - bottom;
      const looks = CAPTION.test(first.text.trim());
      const quiet = first.size < body * 0.95 || first.italic / Math.max(1, first.n) > 0.6;
      const chars = group.reduce((s, l) => s + l.n, 0);
      if (below > -2 && below < body * (looks ? 3.5 : 1.6) && (looks || (quiet && chars < 500)) && below < bestGap) {
        best = group;
        bestGap = below;
        above = false;
      } else if (looks && aboveGap > -2 && aboveGap < body * 3 && aboveGap < bestGap) {
        best = group;
        bestGap = aboveGap;
        above = true;
      }
    }
    if (best) {
      for (const l of best) l.role = "caption";
      r.caption = best;
      r.captionAbove = above;
    }
  }
  return merged;
}

/** Where a region with no text of its own falls in reading order: just before the first line below it. */
function orderAt(lines: ALine[], r: Rect): number {
  let best = Infinity;
  for (const l of lines) if (l.y0 >= r[1] - 2 && l.order < best) best = l.order;
  return Number.isFinite(best) ? best - 0.5 : (lines[lines.length - 1]?.order ?? 0) + 0.5;
}

// ─── 3. display equations ────────────────────────────────────────────────

function detectEquations(
  pages: XPage[],
  all: ALine[][],
  body: number,
  columns: Array<{ left: number; right: number }>,
): Region[] {
  const regions: Region[] = [];
  for (const p of pages) {
    const lines = all[p.index]!;
    const col = columns[p.index]!;
    const width = col.right - col.left;
    const mathy = (l: ALine) => {
      const frac = l.math / Math.max(1, l.n);
      return frac >= 0.45 || (frac >= 0.22 && l.n <= 30);
    };
    const seeds = lines.filter((l) => {
      if (l.role !== "body" || l.n === 0 || !mathy(l)) return false;
      const indented = l.x0 > col.left + body * 1.5;
      const narrow = l.x1 - l.x0 < width * 0.8;
      if (!indented || !narrow) return false;
      // MuPDF splits a line at an inline formula; the pieces of prose on
      // either side give it away as inline.
      const mid = (l.y0 + l.y1) / 2;
      const inline = lines.some(
        (o) =>
          o !== l &&
          o.role === "body" &&
          o.n >= 10 &&
          !mathy(o) &&
          mid > o.y0 &&
          mid < o.y1 &&
          (Math.abs(o.x0 - l.x1) < body * 2 || Math.abs(l.x0 - o.x1) < body * 2),
      );
      return !inline;
    });
    if (!seeds.length) continue;
    seeds.sort((a, b) => a.y0 - b.y0);
    const groups: Rect[] = [];
    for (const s of seeds) {
      const last = groups[groups.length - 1];
      if (last && s.y0 < last[3] + body * 0.7) groups[groups.length - 1] = union(last, rectOf(s));
      else groups.push(rectOf(s));
    }
    for (let g of groups) {
      // Take in the fragments that make up the display: indices, limits,
      // big operators, a "for all x" between the halves, the number at the
      // right margin. Never a full line of prose.
      const members: ALine[] = [];
      for (let pass = 0; pass < 2; pass++) {
        for (const l of lines) {
          if (l.role !== "body" || members.includes(l)) continue;
          const vIn = (l.y0 + l.y1) / 2 >= g[1] - body * 0.5 && (l.y0 + l.y1) / 2 <= g[3] + body * 0.5;
          if (!vIn) continue;
          const eqNumber = /^\(\s*[\dA-Z]+(\.\d+)*[a-z]?\s*\)$/.test(l.text.trim());
          // A display is set apart by its indent: an indented, short row
          // inside it belongs to it, words and all ("… otherwise.").
          const setApart = l.x0 > col.left + body * 1.5 && l.x1 - l.x0 < width * 0.8 && l.n <= 70;
          const prose = l.n > 40 && !mathy(l) && !setApart;
          if (prose) continue;
          if (mathy(l) || l.n <= 24 || eqNumber || l.size < body * 0.85 || setApart) {
            members.push(l);
            g = union(g, rectOf(l));
          }
        }
      }
      if (!members.length) continue;
      for (const v of p.vectors) if (overlaps(v.bbox, g, 1) && area(v.bbox) < area(g) * 1.2) g = union(g, v.bbox);
      // Line boxes carry their ascent and descent; keep the cut clear of the
      // text above and below so no stray descender rides along.
      const mid = (g[1] + g[3]) / 2;
      for (const l of lines) {
        if (members.includes(l) || l.role === "furniture" || l.x1 < g[0] || l.x0 > g[2]) continue;
        if ((l.y0 + l.y1) / 2 < mid && l.y1 > g[1] - 2.5) g = [g[0], Math.min(mid, l.y1 + 2.5), g[2], g[3]];
        if ((l.y0 + l.y1) / 2 > mid && l.y0 < g[3] + 2.5) g = [g[0], g[1], g[2], Math.max(mid, l.y0 - 2.5)];
      }
      for (const l of members) l.role = "equation";
      const boxed = members.find((l) => l.boxed)?.boxed ?? 0;
      const ordered = [...members].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
      regions.push({
        kind: "equation",
        boxed,
        page: p.index,
        bbox: g,
        photo: false,
        order: Math.min(...members.map((l) => l.order)),
        text: ordered.map((l) => l.text.trim()).join(" "),
        caption: [],
        captionAbove: false,
      });
    }
  }
  return regions;
}

// ─── tables ──────────────────────────────────────────────────────────────

/**
 * A run of three or more rows, each split into three or more cells with
 * real gaps between them, is a table. It is shown as an image of itself,
 * because a reflowed table is just a list of numbers.
 */
function detectTables(pages: XPage[], all: ALine[][], body: number): Region[] {
  const regions: Region[] = [];
  for (const p of pages) {
    const lines = all[p.index]!.filter((l) => (l.role === "body" || l.role === "code") && l.n > 0);
    const rows: ALine[][] = [];
    for (const l of [...lines].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0)) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row[0]!.baseline - l.baseline) < l.size * 0.35) row.push(l);
      else rows.push([l]);
    }
    const tabular = rows.map((row) => {
      const sorted = [...row].sort((a, b) => a.x0 - b.x0);
      let gaps = sorted.reduce((s, l) => s + l.cells - 1, 0);
      for (let i = 1; i < sorted.length; i++) if (sorted[i]!.x0 - sorted[i - 1]!.x1 > sorted[i]!.size * 1.0) gaps++;
      const mathy = row.reduce((s, l) => s + l.math, 0) / Math.max(1, row.reduce((s, l) => s + l.n, 0)) > 0.4;
      return gaps >= 2 && !mathy;
    });
    let i = 0;
    while (i < rows.length) {
      if (!tabular[i]) {
        i++;
        continue;
      }
      let j = i;
      while (
        j + 1 < rows.length &&
        (tabular[j + 1] || (j + 2 < rows.length && tabular[j + 2])) &&
        rows[j + 1]![0]!.y0 - rows[j]![0]!.y1 < body * 2.5
      )
        j++;
      if (j - i + 1 >= 3) {
        const members = rows.slice(i, j + 1).flat();
        let bbox = rectOf(members[0]!);
        for (const l of members) bbox = union(bbox, rectOf(l));
        for (const v of p.vectors) if (overlaps(v.bbox, bbox, 3) && area(v.bbox) < area(bbox) * 1.5) bbox = union(bbox, v.bbox);
        for (const l of members) l.role = "table";
        regions.push({
          kind: "table",
          page: p.index,
          bbox,
          photo: false,
          order: Math.min(...members.map((l) => l.order)),
          text: rows
            .slice(i, j + 1)
            .map((row) => [...row].sort((a, b) => a.x0 - b.x0).map((l) => l.text.trim()).join(" | "))
            .join("\n"),
          caption: [],
          captionAbove: false,
        });
      }
      i = j + 1;
    }
  }
  // Table captions usually sit above.
  for (const r of regions) {
    const above = all[r.page]!.filter(
      (l) => l.role === "body" && CAPTION.test(l.text.trim()) && l.y1 <= r.bbox[1] + 2 && r.bbox[1] - l.y1 < body * 3,
    );
    if (above.length) {
      const block = above[above.length - 1]!.block;
      const group = all[r.page]!.filter((l) => l.block === block && l.role === "body");
      for (const l of group) l.role = "caption";
      r.caption = group;
      r.captionAbove = true;
    }
  }
  return regions;
}

// ─── 4. footnotes ────────────────────────────────────────────────────────

function footnoteLabel(l: ALine): string | null {
  const first = l.spans[0];
  if (first && first.flags & F.SUP) {
    const t = first.text.trim();
    if (FOOTNOTE_MARK.test(t)) return t;
  }
  const m = /^([0-9]{1,3}|[*†‡§¶‖]+)[\s.)]\s*\S/.exec(l.text.trim());
  return m ? m[1]! : null;
}

function detectFootnotes(pages: XPage[], all: ALine[][], body: number): Footnote[] {
  const notes: Footnote[] = [];
  let id = 0;
  // Superscripts in each page's text: the marks footnotes answer to.
  const refsOn = pages.map((p) => {
    const refs = new Set<string>();
    for (const l of all[p.index]!)
      if (l.role === "body") for (const s of l.spans) if (s.flags & F.SUP && !(s.flags & F.MATH)) refs.add(s.text.trim());
    return refs;
  });
  for (const p of pages) {
    const lines = all[p.index]!.filter((l) => l.role === "body" && l.n > 0).sort((a, b) => b.y0 - a.y0);
    const small = (l: ALine) => l.size <= body * 0.93 && l.size >= body * 0.5;
    // The short rule most books set above their notes is the surest edge:
    // everything small beneath it is notes. Without one, take the small
    // lines at the foot of the page, stopping at code (often set small too).
    const rule = p.vectors
      .filter((v) => {
        const w = v.bbox[2] - v.bbox[0];
        return v.bbox[3] - v.bbox[1] < 1.6 && w > 25 && w < p.width * 0.6 && v.bbox[1] > p.height * 0.35;
      })
      .filter((v) => lines.some((l) => l.y0 >= v.bbox[1] - 1 && small(l)) && !lines.some((l) => l.y0 >= v.bbox[1] - 1 && !small(l)))
      .sort((a, b) => a.bbox[1] - b.bbox[1])[0];
    const run: ALine[] = [];
    if (rule) {
      for (const l of lines) if (l.y0 >= rule.bbox[1] - 1) run.push(l);
    } else {
      for (const l of lines) {
        if (small(l) && l.y0 > p.height * 0.4 && l.mono < l.n * 0.5) run.push(l);
        else break;
      }
    }
    if (!run.length) continue;
    run.reverse();
    const ruled = !!rule;
    // Without a rule the run has to stand apart from the text above it.
    const above = lines.find((l) => l.y1 <= run[0]!.y0 + 1 && !run.includes(l));
    if (above && run[0]!.y0 - above.y1 < body * 0.3 && !ruled) continue;

    // A marker set as a line of its own labels the line beside it.
    const labelOf = new Map<ALine, string>();
    for (let i = 0; i < run.length; i++) {
      const l = run[i]!;
      const t = l.text.trim();
      const next = run[i + 1];
      if (FOOTNOTE_MARK.test(t) && next && next.y0 < l.y1 + l.size * 0.5 && next.x0 >= l.x1 - 1) {
        labelOf.set(next, t);
        labelOf.set(l, "");
        continue;
      }
      if (!labelOf.has(l)) {
        const label = footnoteLabel(l);
        if (label) labelOf.set(l, label);
      }
    }
    const firstLabel = labelOf.get(run[0]!) || labelOf.get(run[1]!) || null;
    const cited =
      firstLabel !== null &&
      (refsOn[p.index]!.has(firstLabel) || refsOn[p.index - 1]?.has(firstLabel) || refsOn[p.index + 1]?.has(firstLabel));
    if (!firstLabel || (labelOf.get(run[0]!) === undefined && !labelOf.has(run[0]!))) {
      // A note carried over from the previous page, under its rule.
      const prev = notes[notes.length - 1];
      if (ruled && prev && prev.page === p.index - 1 && !labelOf.get(run[0]!)) {
        const carried: ALine[] = [];
        for (const l of run) {
          if (labelOf.get(l)) break;
          l.role = "footnote";
          l.fnId = prev.id;
          carried.push(l);
        }
        prev.lines.push(...carried);
        run.splice(0, carried.length);
        if (!run.length) continue;
      } else if (!firstLabel) continue;
    }
    if (!ruled && !cited) continue;
    const left = Math.min(...run.map((l) => l.x0));
    let current: Footnote | null = null;
    for (const l of run) {
      const label = labelOf.get(l);
      if (label && (l.x0 <= left + body * 2.5 || (l.spans[0]!.flags & F.SUP) !== 0) && (current === null || label !== current.label)) {
        current = { id: id++, page: p.index, label, lines: [] };
        notes.push(current);
      }
      if (!current) continue;
      l.role = "footnote";
      l.fnId = current.id;
      if (label !== "") current.lines.push(l);
    }
  }
  return notes;
}

// ─── 5. headings ─────────────────────────────────────────────────────────

function styleKey(l: XLine): string {
  return `${l.font}:${Math.round(l.size * 2) / 2}:${l.bold / Math.max(1, l.n) > 0.6 ? 1 : 0}`;
}

let headingSerial = 0;

/** Match each outline entry to the lines on its page that print it. Returns how many matched. */
function matchOutline(outline: OutlineEntry[], pages: XPage[], all: ALine[][], body: number): number {
  let matched = 0;
  for (const entry of outline) {
    const want = titleTokens(entry.title);
    if (!want.length) continue;
    type Match = { lines: ALine[]; score: number };
    const found: { best: Match | null } = { best: null };
    for (const pi of [entry.page, entry.page + 1]) {
      const lines = all[pi];
      if (!lines) continue;
      const candidates = lines.filter((l) => (l.role === "body" || l.role === "code") && l.n > 0);
      for (let i = 0; i < candidates.length; i++) {
        const first = candidates[i]!;
        if (first.size < body * 0.95) continue;
        let combined: ALine[] = [];
        for (let k = 0; k < 3 && i + k < candidates.length; k++) {
          const l = candidates[i + k]!;
          if (k > 0 && (l.block !== first.block || Math.abs(l.size - first.size) > first.size * 0.25)) break;
          combined = [...combined, l];
          const got = titleTokens(combined.map((x) => x.text).join(" "));
          let score = dice(want, got);
          if (first.size >= body * 1.12 || first.bold / first.n > 0.6) score += 0.08;
          if (pi !== entry.page) score -= 0.05;
          if (score >= 0.72 && (!found.best || score > found.best.score + 0.01)) found.best = { lines: combined, score };
        }
      }
      if (found.best && found.best.score >= 0.95) break;
    }
    const best = found.best;
    if (!best) continue;
    matched++;
    const hId = ++headingSerial;
    // "Chapter 2" set on its own line above the title belongs to it.
    const first = best.lines[0]!;
    const pageLines = all[first.page]!;
    const prev = pageLines
      .filter((l) => l.role === "body" && l !== first && l.y0 < first.y0 - 1 && l.baseline < first.baseline - 2 && first.y0 - l.y1 < first.size * 2.5)
      .sort((a, b) => b.y1 - a.y1)[0];
    if (prev && /^((chapter|part|appendix|lecture|unit|lesson|book)\s+\S+|\d{1,2})$/i.test(prev.text.trim()) && prev.size >= body) {
      prev.role = "heading";
      prev.hLevel = entry.level;
      prev.hId = hId;
    }
    for (const l of best.lines) {
      l.role = "heading";
      l.hLevel = entry.level;
      l.hId = hId;
    }
  }
  return matched;
}

/**
 * Headings by type style. With an outline, this only fills in levels the
 * outline left out — a line styled exactly like the outline's own headings
 * of some level gets that level, and a heading style the outline never
 * uses goes below its deepest level. Without one, the heading styles are
 * ranked by size and weight and become levels 1 to 4.
 */
function detectStyledHeadings(pages: XPage[], all: ALine[][], body: number, fonts: FontInfo[], fromOutline: boolean): void {
  const styleLevels = new Map<string, number>();
  let deepest = 0;
  if (fromOutline) {
    const votes = new Map<string, Map<number, number>>();
    for (const lines of all)
      for (const l of lines)
        if (l.role === "heading" && l.hLevel) {
          const k = styleKey(l);
          const v = votes.get(k) ?? new Map<number, number>();
          v.set(l.hLevel, (v.get(l.hLevel) ?? 0) + 1);
          votes.set(k, v);
          deepest = Math.max(deepest, l.hLevel);
        }
    for (const [k, v] of votes) {
      let level = 0;
      let count = 0;
      for (const [lv, c] of v) if (c > count) [level, count] = [lv, c];
      if (count >= 2) styleLevels.set(k, level);
    }
  }

  interface Cand {
    line: ALine;
    key: string;
  }
  const cands: Cand[] = [];
  // With an outline, the title page and the like before its first entry
  // are not structure, however large their type.
  let firstPage = Infinity;
  if (fromOutline) for (const lines of all) for (const l of lines) if (l.role === "heading") firstPage = Math.min(firstPage, l.page);
  for (const lines of all) {
    if (fromOutline && (lines[0]?.page ?? 0) < firstPage) continue;
    // A contents page lists every heading in heading type, each with its
    // page number after it. Those are not headings.
    const numbered = lines.filter((l) => /\s(\d{1,4}|[ivxlcdm]{1,6})$/i.test(l.text.trim())).length;
    if (numbered >= 5 && numbered >= lines.length * 0.3) continue;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.role !== "body" || l.n < 2 || l.n > 110) continue;
      const prev = lines[i - 1];
      const next = lines[i + 1];
      const startsBlock = !prev || prev.block !== l.block || prev.role !== "body" || styleKey(prev) !== styleKey(l);
      if (!startsBlock) continue;
      const text = l.text.trim();
      if (/[,;:]$/.test(text) || /^[\d\s.]+$/.test(text) || !/^[\p{Lu}\p{N}"“'‘(§]/u.test(text)) continue;
      if (l.math / l.n > 0.3 || l.mono / l.n > 0.5) continue;
      const boldish = l.bold / l.n > 0.85;
      const big = l.size >= body * 1.12;
      const alone = !next || next.block !== l.block || styleKey(next) !== styleKey(l);
      if (!(big || (boldish && l.size >= body * 0.97 && alone))) continue;
      if (CAPTION.test(text)) continue;
      cands.push({ line: l, key: styleKey(l) });
    }
  }

  const groups = new Map<string, Cand[]>();
  for (const c of cands) {
    const list = groups.get(c.key);
    if (list) list.push(c);
    else groups.set(c.key, [c]);
  }
  interface Style {
    key: string;
    size: number;
    bold: boolean;
    cands: Cand[];
  }
  const styles: Style[] = [];
  for (const [key, list] of groups) {
    const periods = list.filter((c) => /\.$/.test(c.line.text.trim()) && !/^\d+(\.\d+)*\.$/.test(c.line.text.trim())).length;
    if (periods > list.length * 0.5) continue; // run-in labels: "Proof.", "Example."
    const numbered = list.filter((c) => HEADING_LABEL.test(c.line.text.trim())).length;
    if (list.length > pages.length * 2.5 && numbered < list.length * 0.5) continue; // a styled body element, not structure
    const size = list[0]!.line.size;
    styles.push({ key, size, bold: list[0]!.line.bold / list[0]!.line.n > 0.6, cands: list });
  }
  styles.sort((a, b) => b.size - a.size || Number(b.bold) - Number(a.bold));
  if (process.env["APPRENTICE_DEBUG_HEADINGS"])
    for (const s of styles) console.error("style", s.key, fonts[Number(s.key.split(":")[0])]?.name, s.cands.length, s.cands.slice(0, 3).map((c) => c.line.text));

  const levelOf = new Map<string, number>();
  if (fromOutline) {
    let below = deepest;
    for (const s of styles) {
      const known = styleLevels.get(s.key);
      if (known) levelOf.set(s.key, known);
      else if (s.size >= body * 0.97 && below < 6) {
        // Only styles that are smaller than every outline heading style may
        // add a level; a big unmatched style is more likely a title page.
        const smallest = Math.min(...[...styleLevels.keys()].map((k) => Number(k.split(":")[1])), Infinity);
        if (s.size <= smallest + 0.01) levelOf.set(s.key, ++below);
      }
    }
  } else {
    // Only a style that recurs is structure; a one-off big line is a title
    // page or a part opener. "Chapter 3" labels join the title under them
    // (joinChapterLabels), so their style takes no level of its own.
    const label = /^((chapter|part|appendix|lecture|unit|lesson|book)\s+\S+|\d{1,2})$/i;
    let level = 0;
    let lastSize = Infinity;
    let lastBold = true;
    for (const s of styles) {
      if (s.cands.length < 2 || !(s.bold || s.size >= body * 1.3)) continue;
      if (s.cands.filter((c) => label.test(c.line.text.trim())).length > s.cands.length * 0.6) {
        levelOf.set(s.key, Math.max(1, level));
        continue;
      }
      if (s.size < lastSize - 0.4 || s.bold !== lastBold || level === 0) level++;
      lastSize = s.size;
      lastBold = s.bold;
      if (level > 4) break;
      levelOf.set(s.key, level);
    }
  }

  for (const s of styles) {
    const level = levelOf.get(s.key);
    if (!level) continue;
    for (const c of s.cands) {
      const l = c.line;
      let lv = level;
      const num = /^(\d+(?:\.\d+)+)\.?\s/.exec(l.text.trim());
      if (!fromOutline && num) lv = Math.min(4, num[1]!.split(".").length);
      l.role = "heading";
      l.hLevel = lv;
      l.hId = ++headingSerial;
      // A heading that wraps continues on the next line in the same style.
      const lines = all[l.page]!;
      const i = lines.indexOf(l);
      const next = lines[i + 1];
      if (next && next.block === l.block && next.role === "body" && styleKey(next) === styleKey(l) && next.n < 110) {
        next.role = "heading";
        next.hLevel = lv;
        next.hId = l.hId;
      }
    }
  }
  void fonts;
}

/** "Chapter 1" set above "Discrete Probability Distributions" is one heading. */
function joinChapterLabels(all: ALine[][]): void {
  for (const lines of all) {
    for (const l of lines) {
      if (l.role !== "heading" || !/^((chapter|part|appendix|lecture|unit|lesson|book)\s+\S+|\d{1,2})$/i.test(l.text.trim())) continue;
      const next = lines
        .filter((o) => o.role === "heading" && o.hId !== l.hId && o.y0 >= l.y1 - 1 && o.y0 - l.y1 < l.size * 4)
        .sort((a, b) => a.y0 - b.y0)[0];
      if (!next) continue;
      const level = Math.min(l.hLevel ?? 1, next.hLevel ?? 1);
      const from = next.hId;
      for (const o of lines)
        if (o.hId === from || o === l) {
          o.hId = from;
          o.hLevel = level;
        }
    }
  }
}

// ─── 6. assembly ─────────────────────────────────────────────────────────

function buildDictionary(all: ALine[][]): Set<string> {
  const words = new Set<string>();
  for (const lines of all)
    for (const l of lines) {
      if (l.role === "furniture") continue;
      const ws = l.text.toLowerCase().match(/[\p{L}]+(?:-[\p{L}]+)*/gu);
      if (!ws) continue;
      // The last word may be broken across the line, so it does not count.
      const end = /-$/.test(l.text.trim()) ? ws.length - 1 : ws.length;
      for (let i = 0; i < end; i++) words.add(ws[i]!);
    }
  return words;
}

/** Builds a block's text and marks span by span. */
class TextBuilder {
  text = "";
  marks: Mark[] = [];
  refs: Array<{ s: number; e: number; key: string }> = [];

  constructor(
    private readonly baseFlags: number,
    private readonly keepMarks: boolean,
  ) {}

  append(spans: XLine["spans"], page: number, refLabels: Set<string> | null): void {
    for (const span of spans) {
      const s = this.text.length;
      this.text += span.text;
      const e = this.text.length;
      const flags = (span.flags & ~this.baseFlags) & 63;
      if (refLabels && span.flags & F.SUP && !(span.flags & F.MATH)) {
        const label = span.text.trim();
        if (refLabels.has(label)) {
          const lead = span.text.length - span.text.trimStart().length;
          this.refs.push({ s: s + lead, e: s + lead + label.length, key: `${page}:${label}` });
        }
      }
      if (!this.keepMarks || !flags || !span.text.trim()) continue;
      const last = this.marks[this.marks.length - 1];
      if (last && last.f === flags && last.e >= s - 1) last.e = e;
      else this.marks.push({ s, e, f: flags });
    }
  }

  /** Join a new line on: a space, or nothing when undoing a hyphen break. */
  join(next: string, dictionary: Set<string>): void {
    if (!this.text) return;
    const m = /([\p{L}]+)[-‐]$/u.exec(this.text);
    const n = /^([\p{Ll}]+)/u.exec(next.trimStart());
    if (m && n) {
      const joined = (m[1]! + n[1]!).toLowerCase();
      const hyphenated = `${m[1]!}-${n[1]!}`.toLowerCase();
      if (dictionary.has(hyphenated) && !dictionary.has(joined)) return; // a real hyphen: "finite-dimensional"
      this.text = this.text.slice(0, -1);
      for (const mark of this.marks) if (mark.e > this.text.length) mark.e = this.text.length;
      return;
    }
    if (/[-‐/—–]$/.test(this.text)) return;
    this.text += " ";
  }

  trimEnd(): void {
    const t = this.text.replace(/\s+$/, "");
    if (t.length !== this.text.length) {
      this.text = t;
      for (const mark of this.marks) mark.e = Math.min(mark.e, t.length);
      this.marks = this.marks.filter((mark) => mark.e > mark.s);
    }
  }
}

function assemble(
  pages: XPage[],
  all: ALine[][],
  regions: Region[],
  footnotes: Footnote[],
  body: number,
  bodyFlags: number,
  columns: Array<{ left: number; right: number }>,
  dictionary: Set<string>,
): PBlock[] {
  const blocks: PBlock[] = [];
  const fnById = new Map(footnotes.map((f) => [f.id, f]));
  const fnByPage = new Map<number, Footnote[]>();
  for (const f of footnotes) {
    const list = fnByPage.get(f.page);
    if (list) list.push(f);
    else fnByPage.set(f.page, [f]);
  }
  void fnById;

  /** The paragraph text may still be flowing into, across a page break or a float. */
  let open: { block: PBlock; builder: TextBuilder; last: ALine } | null = null;
  let floatsSinceOpen = true;

  const flush = () => {
    if (!open) return;
    open.builder.trimEnd();
    open.block.text = open.builder.text;
    open.block.marks = open.builder.marks;
    if (open.builder.refs.length) open.block.refs = open.builder.refs;
  };

  const pushRegion = (r: Region) => {
    const pad = r.kind === "equation" ? 2 : 4;
    const bbox: Rect = [r.bbox[0] - pad, r.bbox[1] - pad, r.bbox[2] + pad, r.bbox[3] + pad];
    const pushCaption = () => {
      if (!r.caption.length) return;
      const b = new TextBuilder(bodyFlags, true);
      r.caption.sort((a, c) => a.order - c.order);
      r.caption.forEach((l, i) => {
        if (i) b.join(l.text, dictionary);
        b.append(l.spans, l.page, null);
      });
      b.trimEnd();
      blocks.push({
        type: "caption",
        level: 0,
        text: b.text,
        marks: b.marks,
        page: r.page,
        bbox: r.caption.map(rectOf).reduce(union),
        asset: null,
        boxed: 0,
        label: null,
      });
    };
    if (r.captionAbove) pushCaption();
    blocks.push({
      type: r.kind,
      level: 0,
      text: r.text,
      marks: [],
      page: r.page,
      bbox,
      asset: {
        page: r.page,
        bbox,
        kind: r.kind,
        scale: r.kind === "equation" ? 3 : r.photo ? 2.5 : 3,
        photo: r.photo,
      },
      boxed: r.boxed ?? 0,
      label: null,
    });
    if (!r.captionAbove) pushCaption();
  };

  for (const p of pages) {
    const lines = all[p.index]!;
    const col = columns[p.index]!;
    type Item = { order: number; kind: "line"; line: ALine } | { order: number; kind: "region"; region: Region };
    const items: Item[] = [];
    for (const l of lines) {
      if (l.role === "body" || l.role === "heading" || l.role === "code") items.push({ order: l.order, kind: "line", line: l });
    }
    for (const r of regions) if (r.page === p.index) items.push({ order: r.order, kind: "region", region: r });
    items.sort((a, b) => a.order - b.order);

    const merged = items;

    const pageNotes = fnByPage.get(p.index) ?? [];
    // LaTeX floats a note that does not fit onto the next page, so a
    // reference may answer to a note one page on (or, rarely, back).
    const refLabels = new Set(
      [p.index - 1, p.index, p.index + 1].flatMap((i) => (fnByPage.get(i) ?? []).map((f) => f.label)),
    );
    const blockBounds = new Map<number, { left: number; right: number }>();
    for (const l of lines) {
      const b = blockBounds.get(l.block);
      if (b) {
        b.left = Math.min(b.left, l.x0);
        b.right = Math.max(b.right, l.x1);
      } else blockBounds.set(l.block, { left: l.x0, right: l.x1 });
    }

    let code: { lines: ALine[] } | null = null;
    const flushCode = () => {
      if (!code) return;
      const ls = code.lines;
      const left = Math.min(...ls.map((l) => l.x0));
      const cws = ls.map((l) => l.charWidth).filter((w) => w > 0).sort((a, b) => a - b);
      const cw = cws[Math.floor(cws.length / 2)] || body * 0.5;
      const height = Math.min(...ls.map((l) => l.y1 - l.y0).filter((h) => h > 0), body * 1.3);
      let text = "";
      ls.forEach((l, i) => {
        if (i) {
          const gap = l.y0 - ls[i - 1]!.y1;
          const blank = Math.max(0, Math.round(gap / height - 0.35));
          text += "\n".repeat(1 + Math.min(blank, 1));
        }
        text += " ".repeat(Math.max(0, Math.round((l.x0 - left) / cw))) + l.text.replace(/\s+$/, "");
      });
      blocks.push({
        type: "code",
        level: 0,
        text,
        marks: [],
        page: ls[0]!.page,
        bbox: ls.map(rectOf).reduce(union),
        asset: null,
        boxed: ls[0]!.boxed,
        label: null,
      });
      code = null;
    };

    let heading: { lines: ALine[] } | null = null;
    const flushHeading = () => {
      if (!heading) return;
      const ls = heading.lines;
      let text = ls
        .map((l) => l.text.trim())
        .join(" ")
        .replace(/\s+/g, " ");
      let label: string | null = null;
      const m = HEADING_LABEL.exec(text);
      if (m) {
        label = m[1]!.replace(/[.:]$/, "");
        text = m[2]!;
      }
      blocks.push({
        type: "heading",
        level: ls[0]!.hLevel ?? 1,
        text,
        marks: [],
        page: ls[0]!.page,
        bbox: ls.map(rectOf).reduce(union),
        asset: null,
        boxed: 0,
        label,
      });
      heading = null;
    };

    let prevLine: ALine | null = null;
    for (const item of merged) {
      if (item.kind === "region") {
        flushCode();
        flushHeading();
        pushRegion(item.region);
        prevLine = null;
        if (item.region.kind === "equation") {
          // Text after a display continues the sentence, but on a line of its
          // own: close the paragraph so the order stays as printed.
          flush();
          open = null;
        } else floatsSinceOpen = true;
        continue;
      }
      const l = item.line;
      if (l.role === "heading") {
        flushCode();
        if (heading && heading.lines[0]!.hId === l.hId) heading.lines.push(l);
        else {
          flushHeading();
          flush();
          open = null;
          heading = { lines: [l] };
        }
        prevLine = l;
        continue;
      }
      flushHeading();
      if (l.role === "code") {
        if (code) {
          const last = code.lines[code.lines.length - 1]!;
          if (l.y0 - last.y1 > body * 3 || l.page !== last.page) flushCode();
        }
        if (!code) {
          flush();
          open = null;
          code = { lines: [] };
        }
        code.lines.push(l);
        prevLine = l;
        continue;
      }
      flushCode();

      // Body text.
      const text = l.text.trim();
      const bounds = blockBounds.get(l.block)!;
      const bullet = BULLET.exec(text);
      const enumerator = bullet ? null : ENUMERATOR.exec(text);
      const listStart = !!(bullet || enumerator);
      let startNew = true;
      if (open && !listStart) {
        const prev = open.last;
        const prevText = open.builder.text.trimEnd();
        const sizeBreak = Math.abs(l.size - prev.size) > Math.max(prev.size, l.size) * 0.12;
        const boxBreak = l.boxed !== prev.boxed;
        const consecutive = prevLine === prev && l.block === prev.block && l.page === prev.page;
        if (sizeBreak || boxBreak) {
          startNew = true;
        } else if (consecutive) {
          const indented = l.x0 > bounds.left + l.size * 0.8 && l.x0 - prev.x0 > l.size * 0.8;
          const prevShort = prev.x1 < bounds.right - l.size * 1.5;
          const gap = l.y0 - prev.y1 > l.size * 0.9;
          startNew = (indented && (prevShort || TERMINAL.test(prevText))) || gap;
          // A hanging indent continues a list item.
          if (open.block.type === "list") startNew = gap;
        } else if (!TERMINAL.test(prevText)) {
          // Another block, column or page. The same paragraph when the
          // sentence plainly is not over: it resumes in lower case, or the
          // last one broke off mid-clause.
          const lowerStart = /^[\p{Ll},;:)\]]/u.test(text);
          const softEnd = /[,;—–-]$/.test(prevText) || /[\p{L}\p{N}]$/u.test(prevText);
          const columnJump = l.y0 < prev.y0 - l.size * 2 && l.x0 > prev.x0 + 40;
          if (l.page !== prev.page || floatsSinceOpen || columnJump) startNew = !(lowerStart || softEnd);
          else startNew = !(lowerStart && Math.abs(l.y0 - prev.y1) < l.size * 2);
        }
      }
      if (startNew) {
        flush();
        const builder = new TextBuilder(bodyFlags, true);
        let label: string | null = null;
        let spans = l.spans;
        let type: BlockType = "paragraph";
        let level = 0;
        if (bullet || enumerator) {
          type = "list";
          label = (bullet ?? enumerator)![1]!;
          spans = dropPrefix(l.spans, (bullet ?? enumerator)![0]!.length + (l.text.length - l.text.trimStart().length));
          level = Math.max(0, Math.min(2, Math.round((l.x0 - col.left) / (body * 2.2))));
        }
        const block: PBlock = {
          type,
          level,
          text: "",
          marks: [],
          page: l.page,
          bbox: rectOf(l),
          asset: null,
          boxed: l.boxed,
          label,
        };
        blocks.push(block);
        builder.append(spans, l.page, refLabels);
        open = { block, builder, last: l };
        floatsSinceOpen = false;
        // Footnotes go right after the paragraph that cites them, so they
        // read where they are needed. Unreferenced ones go at page end.
      } else if (open) {
        open.builder.join(text, dictionary);
        open.builder.append(l.spans, l.page, refLabels);
        open.last = l;
        if (open.block.bbox && l.page === open.block.page) open.block.bbox = union(open.block.bbox, rectOf(l));
      }
      prevLine = l;
    }
    flushCode();
    flushHeading();

    // This page's footnotes, after everything on the page.
    if (pageNotes.length) {
      flush();
      for (const note of pageNotes) {
        const b = new TextBuilder(bodyFlags, true);
        note.lines.forEach((l, i) => {
          let spans = l.spans;
          if (i === 0) {
            const first = spans[0];
            const lead = first && first.flags & F.SUP ? first.text.length : (/^\s*([0-9]{1,3}|[*†‡§¶‖]+)[\s.)]?\s*/.exec(l.text)?.[0].length ?? 0);
            spans = dropPrefix(spans, lead);
          } else b.join(l.text, dictionary);
          b.append(spans, l.page, null);
        });
        b.trimEnd();
        blocks.push({
          type: "footnote",
          level: 0,
          text: b.text,
          marks: b.marks,
          page: note.page,
          bbox: note.lines.map(rectOf).reduce(union),
          asset: null,
          boxed: 0,
          label: note.label,
          fnKey: `${note.page}:${note.label}`,
        });
      }
      floatsSinceOpen = true;
    }
  }
  flush();

  // Point each reference at its note: same page first, then the next, then
  // the one before.
  const keys = new Set(blocks.filter((b) => b.fnKey).map((b) => b.fnKey!));
  for (const b of blocks) {
    if (!b.refs) continue;
    b.refs = b.refs.flatMap((r) => {
      const [page, label] = [Number(r.key.slice(0, r.key.indexOf(":"))), r.key.slice(r.key.indexOf(":") + 1)];
      for (const pg of [page, page + 1, page - 1]) if (keys.has(`${pg}:${label}`)) return [{ ...r, key: `${pg}:${label}` }];
      return [];
    });
    if (!b.refs.length) delete b.refs;
  }

  return blocks.filter((b) => b.type === "figure" || b.type === "equation" || b.type === "table" || b.text.trim().length > 0);
}

/** Spans with their first `n` characters removed. */
function dropPrefix(spans: XLine["spans"], n: number): XLine["spans"] {
  const out: XLine["spans"] = [];
  let left = n;
  for (const s of spans) {
    if (left >= s.text.length) {
      left -= s.text.length;
      continue;
    }
    out.push(left ? { ...s, text: s.text.slice(left) } : s);
    left = 0;
  }
  return out;
}

function sectionsFrom(blocks: PBlock[]): PSection[] {
  const sections: PSection[] = [];
  blocks.forEach((b, i) => {
    if (b.type !== "heading") return;
    // "Chapter 3" reads as "3" in the contents, beside "3.1 …" under it.
    const chapter = b.label ? /^chapter\s+(\S+)$/i.exec(b.label) : null;
    const title = !b.label ? b.text : chapter ? `${chapter[1]} ${b.text}` : /^[A-Za-z]{3,}/.test(b.label) ? `${b.label}: ${b.text}` : `${b.label} ${b.text}`;
    sections.push({ title, level: b.level, blockIndex: i, page: b.page, kind: sectionKind(b.text) });
  });
  return sections;
}

function guessTitle(all: ALine[][], body: number): string | null {
  let best: ALine[] = [];
  for (const lines of all.slice(0, 4))
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.n < 3 || l.n > 100 || l.size < body * 1.4 || sectionKind(l.text) !== "body") continue;
      if (best.length && l.size <= best[0]!.size) continue;
      // A title set over two lines.
      const group = [l];
      for (let j = i + 1; j < lines.length && Math.abs(lines[j]!.size - l.size) < 0.5 && lines[j]!.y0 - group[group.length - 1]!.y1 < l.size; j++)
        group.push(lines[j]!);
      best = group;
    }
  return best.length ? best.map((l) => l.text.trim()).join(" ") : null;
}
