/**
 * The parser on a real book, when one is at hand. Set APPRENTICE_TEST_PDF to
 * Think Python 2e (greenteapress.com/thinkpython2/thinkpython2.pdf) to run it.
 */
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs";
import { analyze } from "../ingest/analyze.js";
import { Extractor } from "../ingest/extract.js";
import { meta, openPdf, readOutline } from "../ingest/pdf.js";

const pdf = process.env["APPRENTICE_TEST_PDF"];
setDefaultTimeout(120_000);

describe.skipIf(!pdf || !fs.existsSync(pdf))("parsing Think Python", () => {
  // Loaded in beforeAll, not here: bun evaluates a skipped describe's body.
  let book: ReturnType<typeof analyze>;
  beforeAll(() => {
    const doc = openPdf(fs.readFileSync(pdf!));
    const ex = new Extractor(doc);
    const pages = Array.from({ length: doc.countPages() }, (_, i) => ex.page(i));
    book = analyze(pages, ex.fonts, readOutline(doc), meta(doc));
  });

  test("finds the chapters and their sections", () => {
    const titles = book.sections.map((s) => s.title);
    expect(titles).toContain("3 Functions");
    expect(titles).toContain("3.3 Composition");
  });
  test("drops running heads and keeps the last line of a page", () => {
    const text = book.blocks.map((b) => b.text).join("\n");
    expect(text).not.toContain("3.3. Composition");
    expect(text.split("0.707106781187").length - 1).toBe(2);
  });
  test("keeps code as code, indented", () => {
    const code = book.blocks.find((b) => b.type === "code" && b.text.startsWith("def print_lyrics():"));
    expect(code?.text).toContain('\n    print("I\'m a lumberjack, and I\'m okay.")');
  });
});
