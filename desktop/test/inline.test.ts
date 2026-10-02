import { describe, expect, test } from "bun:test";
import { parseInline, plainText, TEX } from "../../shared/inline.js";
import { MarkFlag } from "../../shared/types.js";

describe("parseInline", () => {
  test("turns light markdown into text and marks", () => {
    const { text, marks } = parseInline("A **primitive** is *built in*, like `+` or $x^2$.");
    expect(text).toBe("A primitive is built in, like + or x^2.");
    expect(marks).toEqual([
      { s: 2, e: 11, f: MarkFlag.BOLD },
      { s: 15, e: 23, f: MarkFlag.ITALIC },
      { s: 30, e: 31, f: MarkFlag.MONO },
      { s: 35, e: 38, f: TEX },
    ]);
  });
  test("leaves underscores inside words alone", () => {
    expect(plainText("print_lyrics and _this_")).toBe("print_lyrics and this");
  });
});
