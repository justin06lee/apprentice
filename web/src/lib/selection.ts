/**
 * The reader's text selection, in the terms apprentice stores: which
 * blocks, and character offsets into each block's text.
 *
 * Every block's text is drawn once, in order, inside its `[data-text]`
 * element, so an offset is just a count of characters before a point —
 * except for typeset math, which is drawn by KaTeX as many nodes but stands
 * for `data-len` characters of source. Those count once, as a unit.
 */

export interface BlockRange {
  blockId: number;
  start: number;
  end: number;
}

export interface SelectionInfo {
  ranges: BlockRange[];
  quote: string;
  rect: DOMRect;
}

function textRoot(node: Node | null): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : node?.parentElement;
  return (el?.closest("[data-text]") as HTMLElement | null) ?? null;
}

/** Offset of the point (node, offset) within a block's text root. */
export function offsetIn(root: HTMLElement, node: Node, offset: number): number {
  const before = document.createRange();
  before.setStart(root, 0);
  try {
    before.setEnd(node, offset);
  } catch {
    return 0;
  }
  let count = 0;
  const atoms = new Set<HTMLElement>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const atom = n.parentElement?.closest<HTMLElement>("[data-atom]") ?? null;
    if (atom && root.contains(atom)) {
      if (atoms.has(atom)) continue;
      atoms.add(atom);
      if (!before.intersectsNode(atom)) break;
      // Typeset math counts whole if the point is past its end, else not at all.
      if (before.comparePoint(atom, atom.childNodes.length) <= 0) count += Number(atom.dataset["len"] ?? 0);
      else break;
      continue;
    }
    if (n === node) return count + offset;
    if (!before.intersectsNode(n)) break;
    count += n.textContent?.length ?? 0;
  }
  return count;
}

export function readSelection(container: HTMLElement): SelectionInfo | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const quote = sel.toString().replace(/\s+/g, " ").trim();
  if (!quote) return null;

  const roots = [...container.querySelectorAll<HTMLElement>("[data-text]")].filter((el) => range.intersectsNode(el));
  const ranges: BlockRange[] = [];
  const startRoot = textRoot(range.startContainer);
  const endRoot = textRoot(range.endContainer);
  for (const root of roots) {
    const blockId = Number(root.dataset["text"]);
    const length = Number(root.dataset["len"] ?? root.textContent?.length ?? 0);
    const start = root === startRoot ? offsetIn(root, range.startContainer, range.startOffset) : 0;
    const end = root === endRoot ? offsetIn(root, range.endContainer, range.endOffset) : length;
    if (end > start) ranges.push({ blockId, start, end });
  }
  if (!ranges.length) return null;
  const rects = range.getClientRects();
  const rect = rects.length ? rects[0]! : range.getBoundingClientRect();
  return { ranges, quote, rect };
}
