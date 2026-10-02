import { describe, expect, test } from "bun:test";
import { MarkFlag } from "../../shared/types.js";
import type { PBlock } from "../ingest/analyze.js";
import { extractConcepts } from "../ingest/concepts.js";

function para(text: string, bold: string[] = [], italic: string[] = []): PBlock {
  const marks = [
    ...bold.map((w) => ({ s: text.indexOf(w), e: text.indexOf(w) + w.length, f: MarkFlag.BOLD })),
    ...italic.map((w) => ({ s: text.indexOf(w), e: text.indexOf(w) + w.length, f: MarkFlag.ITALIC })),
  ];
  return { type: "paragraph", level: 0, text, marks, page: 0, bbox: null, asset: null, boxed: 0, label: null };
}

describe("extractConcepts", () => {
  const blocks = [
    para("A function is a named sequence of statements that performs a computation.", ["function"]),
    para("You call a function by name. A function may take an argument."),
    para("The value passed to a function is called an argument.", [], ["argument"]),
    para("Proof. This is not a concept.", ["Proof."]),
    para("Every argument is evaluated before the function runs."),
  ];
  const kinds = blocks.map(() => "body" as const);
  const found = extractConcepts(blocks, kinds, blocks.map(() => 0));

  test("finds bolded and italic-defined terms, not run-in labels", () => {
    const names = found.concepts.map((c) => c.name);
    expect(names).toContain("function");
    expect(names).toContain("argument");
    expect(names).not.toContain("Proof");
  });
  test("links concepts that share paragraphs", () => {
    expect(found.edges.some((e) => [e.a, e.b].sort().join("|") === "argument|function")).toBe(true);
  });
  test("writes a cloze card from each definition", () => {
    const card = found.cards.find((c) => c.front.includes("{{c1::function}}"));
    expect(card?.kind).toBe("cloze");
    expect(card?.front).toBe("A {{c1::function}} is a named sequence of statements that performs a computation.");
  });
});
