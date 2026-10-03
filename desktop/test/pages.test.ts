/**
 * The text layer's geometry: what selecting, highlighting, versions and
 * search marks all stand on. A made-up page, so it runs without a PDF.
 */
import { describe, expect, test } from "bun:test";
import { cleanText, findAll, hitTest, lineIndexAt, locate, paragraphAt, rangeInRect, rangeRects, wordAt, type PageText } from "../../shared/pages.js";

/** Lines of monospaced text, 5pt a character, 12pt apart, starting at (50, 100). */
function page(lines: Array<[string, number]>): PageText {
  let text = "";
  const out: PageText["lines"] = [];
  lines.forEach(([t, block], i) => {
    if (i) text += "\n";
    const y0 = 100 + i * 12;
    out.push({ x0: 50, y0, x1: 50 + t.length * 5, y1: y0 + 10, s: text.length, xs: Array.from({ length: t.length + 1 }, (_, k) => 50 + k * 5), b: block });
    text += t;
  });
  return { page: 0, width: 400, height: 600, text, lines: out, ink: null };
}

const pt = page([
  ["The process is the OS's abstrac-", 0],
  ["tion of a running program.", 0],
  ["A second paragraph starts here.", 1],
]);

describe("the text layer", () => {
  test("a range draws one rectangle per line it touches", () => {
    const start = pt.text.indexOf("abstrac");
    const end = pt.text.indexOf("running") + "running".length;
    const rs = rangeRects(pt, start, end);
    expect(rs).toHaveLength(2);
    expect(rs[0]).toEqual([50 + 24 * 5, 100, 50 + 32 * 5, 110]);
    expect(rs[1]).toEqual([50, 112, 50 + 17 * 5, 122]);
  });

  test("a point finds the nearest character boundary, level with its line", () => {
    expect(hitTest(pt, 50 + 4 * 5 + 1, 105)).toBe(4);
    // Out in the right margin, level with the second line: that line's end.
    const second = pt.lines[1]!;
    expect(hitTest(pt, 390, 117)).toBe(second.s + second.xs.length - 1);
    expect(lineIndexAt(pt, second.s)).toBe(1);
  });

  test("double and triple clicks take a word and a paragraph", () => {
    const at = pt.text.indexOf("running") + 2;
    expect(pt.text.slice(...wordAt(pt, at))).toBe("running");
    const [a, b] = paragraphAt(pt, at);
    expect(pt.text.slice(a, b)).toBe("The process is the OS's abstrac-\ntion of a running program.");
  });

  test("prose mends words broken across lines", () => {
    expect(cleanText(pt.text)).toBe("The process is the OS's abstraction of a running program. A second paragraph starts here.");
  });

  test("a phrase finds its place whatever the line breaks did to it", () => {
    const at = locate(pt, "the OS's abstraction of a running");
    expect(at).not.toBeNull();
    expect(pt.text.slice(at![0], at![1])).toBe("the OS's abstrac-\ntion of a running");
    expect(locate(pt, "not on this page")).toBeNull();
  });

  test("search words are marked wherever they appear", () => {
    const hits = findAll(pt, ["paragraph", "process"]);
    expect(hits.map(([a, b]) => pt.text.slice(a, b))).toEqual(["process", "paragraph"]);
  });

  test("a box drawn on the page takes the words inside it", () => {
    const r = rangeInRect(pt, [45, 110, 400, 140]);
    expect(r).not.toBeNull();
    expect(pt.text.slice(r![0], r![1])).toBe("tion of a running program.\nA second paragraph starts here.");
  });
});
