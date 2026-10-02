import { describe, expect, test } from "bun:test";
import type { PBlock, PSection } from "../ingest/analyze.js";
import { planUnits } from "../ingest/units.js";

const block = (page: number, type: PBlock["type"] = "paragraph"): PBlock => ({
  type,
  level: 0,
  text: "x".repeat(100),
  marks: [],
  page,
  bbox: null,
  asset: null,
  boxed: 0,
  label: null,
});

describe("planUnits", () => {
  test("reads a short chapter whole and splits a long one along its sections", () => {
    const blocks = [block(0, "heading"), block(1), block(2, "heading"), block(3), block(10, "heading"), block(60, "heading"), block(61)];
    const sections: PSection[] = [
      { title: "Short", level: 1, blockIndex: 0, page: 0, kind: "body" },
      { title: "Long", level: 1, blockIndex: 2, page: 2, kind: "body" },
      { title: "Long A", level: 2, blockIndex: 4, page: 10, kind: "body" },
      { title: "Long B", level: 2, blockIndex: 5, page: 60, kind: "body" },
    ];
    const plan = planUnits(sections, blocks, 100);
    const units = plan.sections.filter((s) => s.isUnit).map((s) => s.title);
    expect(units).toEqual(["Short", "Long", "Long A", "Long B"]);
    // Every block lands in the unit of its deepest section.
    expect(plan.blockSection.map((i) => plan.sections[i]!.title)).toEqual(["Short", "Short", "Long", "Long", "Long A", "Long B", "Long B"]);
  });

  test("puts text before the first heading in front matter", () => {
    const blocks = [block(0), block(1, "heading"), block(2)];
    const plan = planUnits([{ title: "One", level: 1, blockIndex: 1, page: 1, kind: "body" }], blocks, 3);
    expect(plan.sections[0]!.title).toBe("Front matter");
    expect(plan.sections[0]!.kind).toBe("front");
  });

  test("reads a book without headings in runs of pages", () => {
    const blocks = Array.from({ length: 40 }, (_, i) => block(i));
    const plan = planUnits([], blocks, 40);
    expect(plan.sections.map((s) => s.title)).toEqual(["Pages 1–15", "Pages 16–30", "Pages 31–40"]);
  });
});
