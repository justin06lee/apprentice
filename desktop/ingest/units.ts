/**
 * Reading units: the pieces a book is read in, one at a time on screen.
 *
 * A unit is usually a chapter. But "chapter" means different things in
 * different books — a top-level outline entry can be a 6-page preface or a
 * 120-page Part — so the rule is about size, not depth: a section is read
 * whole unless it runs long and has subsections to split along, in which
 * case its opening pages are one unit and each subsection is considered in
 * turn. A book with no headings at all is read in runs of pages.
 */
import type { BlockType, SectionKind } from "../../shared/types.js";
import type { PBlock, PSection } from "./analyze.js";

/** Pages beyond which a section with subsections is split into them. */
const SPLIT_PAGES = 36;
/** Unit size, in pages, for a book without headings. */
const PAGE_RUN = 15;

export interface PlannedSection extends PSection {
  parent: number | null;
  isUnit: boolean;
  /** Index (into the planned list) of the unit the section is drawn in. */
  unit: number;
}

export interface Plan {
  sections: PlannedSection[];
  /** For each block, the index of its (deepest) section. */
  blockSection: number[];
}

export function blockWeight(type: BlockType, text: string): number {
  switch (type) {
    case "figure":
    case "table":
    case "equation":
      return 60;
    case "footnote":
    case "caption":
      return Math.round(text.length * 0.5);
    case "heading":
      return 0;
    default:
      return text.length;
  }
}

export function planUnits(found: PSection[], blocks: PBlock[], pageCount: number): Plan {
  let sections: PSection[] = [...found];

  if (!sections.length) {
    // No structure at all: runs of pages, broken at block boundaries.
    let start = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (i === start || blocks[i]!.page - blocks[start]!.page < PAGE_RUN) continue;
      sections.push(pageRun(blocks, start, i - 1));
      start = i;
    }
    if (blocks.length) sections.push(pageRun(blocks, start, blocks.length - 1));
  } else if (sections[0]!.blockIndex > 0) {
    const lead = blocks.slice(0, sections[0]!.blockIndex);
    if (lead.some((b) => b.text.trim().length > 0 || b.asset)) {
      sections.unshift({ title: "Front matter", level: 1, blockIndex: 0, page: 0, kind: "front" as SectionKind });
    }
  }
  sections = sections.map((s) => ({ ...s, level: Math.max(1, s.level) }));

  const planned: PlannedSection[] = sections.map((s) => ({ ...s, parent: null, isUnit: false, unit: -1 }));
  const stack: number[] = [];
  planned.forEach((s, i) => {
    while (stack.length && planned[stack[stack.length - 1]!]!.level >= s.level) stack.pop();
    s.parent = stack.length ? stack[stack.length - 1]! : null;
    stack.push(i);
  });
  // A section inside front matter, a contents or an index is that too,
  // whatever its own title ("Contributor List" in a preface is not reading).
  planned.forEach((s) => {
    const parentKind = s.parent === null ? null : planned[s.parent]!.kind;
    if (parentKind && parentKind !== "body" && parentKind !== "exercises") s.kind = parentKind;
  });
  const children = planned.map(() => [] as number[]);
  planned.forEach((s, i) => {
    if (s.parent !== null) children[s.parent]!.push(i);
  });
  // Where each section ends: the next section that is not inside it.
  const endPage = planned.map((s, i) => {
    for (let j = i + 1; j < planned.length; j++) if (planned[j]!.level <= s.level) return planned[j]!.page;
    return pageCount;
  });

  const assign = (i: number, unit: number) => {
    planned[i]!.unit = unit;
    for (const c of children[i]!) assign(c, unit);
  };
  const decide = (i: number) => {
    const s = planned[i]!;
    s.isUnit = true;
    const long = endPage[i]! - s.page > SPLIT_PAGES;
    if (long && children[i]!.length >= 2) {
      s.unit = i;
      for (const c of children[i]!) decide(c);
    } else assign(i, i);
  };
  planned.forEach((s, i) => {
    if (s.parent === null) decide(i);
  });

  const blockSection: number[] = new Array(blocks.length);
  let current = 0;
  const starts = planned.map((s) => s.blockIndex);
  for (let b = 0; b < blocks.length; b++) {
    while (current + 1 < planned.length && starts[current + 1]! <= b) current++;
    blockSection[b] = current;
  }
  return { sections: planned, blockSection };
}

function pageRun(blocks: PBlock[], from: number, to: number): PSection {
  const a = blocks[from]!.page + 1;
  const b = blocks[to]!.page + 1;
  return { title: a === b ? `Page ${a}` : `Pages ${a}–${b}`, level: 1, blockIndex: from, page: a - 1, kind: "body" };
}
