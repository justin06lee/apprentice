import { describe, expect, test } from "bun:test";
import { sentenceAround, termKey, TermMatcher } from "../knowledge/terms.js";

describe("termKey", () => {
  test("folds case, accents and plurals into one identity", () => {
    expect(termKey("Vector Spaces")).toBe("vector space");
    expect(termKey("vector space")).toBe("vector space");
    expect(termKey("Probabilities")).toBe("probability");
    expect(termKey("Café")).toBe("cafe");
  });
  test("leaves words that only look plural", () => {
    expect(termKey("basis")).toBe("basis");
    expect(termKey("analysis")).toBe("analysis");
    expect(termKey("mathematics")).toBe("mathematics");
  });
});

describe("TermMatcher", () => {
  const m = new TermMatcher();
  m.add(termKey("vector"), 1);
  m.add(termKey("vector space"), 2);
  m.add(termKey("linear map"), 3);

  test("prefers the longest term at each position", () => {
    const found = m.match("A vector space is a set; every vector in it… Linear maps between vector spaces.");
    expect(found.get(2)).toBe(2);
    expect(found.get(1)).toBe(1);
    expect(found.get(3)).toBe(1);
  });
  test("finds nothing in unrelated text", () => {
    expect(m.match("Nothing to see here.").size).toBe(0);
  });
});

describe("sentenceAround", () => {
  test("returns the sentence holding a span, not tripping on abbreviations", () => {
    const text = "Recall sets. A function, e.g. f, is called injective if it is one-to-one. Then more.";
    const at = text.indexOf("injective");
    expect(sentenceAround(text, at, at + 9).text).toBe("A function, e.g. f, is called injective if it is one-to-one.");
  });
});
