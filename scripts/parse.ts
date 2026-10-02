/**
 * Run the importer's parser on a PDF and print what it made of it, without
 * touching the library. For tuning the parser against real books.
 *
 *   bun scripts/parse.ts book.pdf                 summary + the sections
 *   bun scripts/parse.ts book.pdf --dump out.md   every block, as markdown
 *   bun scripts/parse.ts book.pdf --pages 40-45   only those pages (1-based)
 *   bun scripts/parse.ts book.pdf --assets dir    render figures/equations too
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { analyze } from "../desktop/ingest/analyze.js";
import { extractConcepts } from "../desktop/ingest/concepts.js";
import { planUnits } from "../desktop/ingest/units.js";
import { Extractor, type XPage } from "../desktop/ingest/extract.js";
import { meta, openPdf, readOutline, renderRegion } from "../desktop/ingest/pdf.js";

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error("usage: bun scripts/parse.ts <book.pdf> [--dump out.md] [--pages a-b] [--assets dir]");
  process.exit(1);
}
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const t0 = performance.now();
const doc = openPdf(fs.readFileSync(file));
const count = doc.countPages();
let from = 0;
let to = count;
const range = opt("--pages");
if (range) {
  const [a, b] = range.split("-").map(Number);
  from = (a ?? 1) - 1;
  to = Math.min(count, b ?? a ?? count);
}
const ex = new Extractor(doc);
const pages: XPage[] = [];
for (let i = from; i < to; i++) pages.push(ex.page(i));
const t1 = performance.now();
// analyze() indexes pages by their page number, so a partial run is padded.
const padded: XPage[] = [];
for (let i = 0; i < to; i++) padded.push(pages[i - from] ?? { index: i, label: "", width: 1, height: 1, lines: [], images: [], vectors: [] });
const outline = readOutline(doc).filter((e) => e.page >= from && e.page < to);
const book = analyze(padded, ex.fonts, outline, meta(doc));
const t2 = performance.now();

const counts = new Map<string, number>();
for (const b of book.blocks) counts.set(b.type, (counts.get(b.type) ?? 0) + 1);
console.log(`${path.basename(file)}: ${to - from} pages, body ${book.bodySize}pt`);
console.log(`  title  ${book.title ?? "?"}   author ${book.author ?? "?"}`);
console.log(`  extract ${((t1 - t0) / 1000).toFixed(2)}s  analyze ${((t2 - t1) / 1000).toFixed(2)}s`);
console.log(`  outline ${outline.length} entries, ${book.sections.length} sections`);
console.log(`  blocks  ${[...counts].map(([k, v]) => `${k} ${v}`).join(", ")}`);
for (const w of book.warnings) console.log(`  ! ${w}`);
if (!args.includes("--quiet"))
  for (const s of book.sections.slice(0, 400)) console.log(`  ${"  ".repeat(s.level - 1)}${s.title}  [p${s.page + 1}, ${s.kind}]`);

const dump = opt("--dump");
if (dump) {
  const out: string[] = [];
  for (const b of book.blocks) {
    const where = `<!-- p${b.page + 1}${b.boxed ? ` box${b.boxed}` : ""} -->`;
    switch (b.type) {
      case "heading":
        out.push(`${"#".repeat(Math.min(6, b.level))} ${b.label ? `${b.label} · ` : ""}${b.text} ${where}`);
        break;
      case "code":
        out.push("```" + ` ${where}\n${b.text}\n` + "```");
        break;
      case "figure":
      case "equation":
      case "table":
        out.push(`[${b.type.toUpperCase()} p${b.page + 1} ${b.bbox?.map(Math.round).join(",")}] ${b.text.slice(0, 160)}`);
        break;
      case "footnote":
        out.push(`> [^${b.label}] ${b.text} ${where}`);
        break;
      case "caption":
        out.push(`*caption:* ${b.text} ${where}`);
        break;
      case "list":
        out.push(`${"  ".repeat(b.level)}${b.label} ${b.text} ${where}`);
        break;
      default:
        out.push(`${b.text}${b.refs?.length ? ` [refs ${b.refs.map((r) => r.key).join(" ")}]` : ""} ${where}`);
    }
  }
  fs.writeFileSync(dump, out.join("\n\n"));
  console.log(`  wrote ${dump}`);
}

const assets = opt("--assets");
if (assets) {
  fs.mkdirSync(assets, { recursive: true });
  let n = 0;
  for (const b of book.blocks) {
    if (!b.asset) continue;
    const page = doc.loadPage(b.asset.page);
    const img = renderRegion(page, b.asset.bbox, b.asset.scale, b.asset.photo ? "jpeg" : "png", b.type === "equation");
    fs.writeFileSync(path.join(assets, `${b.type}-${b.page + 1}-${n++}.${b.asset.photo ? "jpg" : "png"}`), img.data);
    page.destroy();
  }
  console.log(`  rendered ${n} assets into ${assets}`);
}

if (args.includes("--concepts")) {
  const plan = planUnits(book.sections, book.blocks, to);
  const units = plan.sections.filter((s) => s.isUnit);
  console.log(`  units   ${units.length}: ${units.slice(0, 12).map((u) => u.title).join(" | ")}`);
  const kinds = plan.blockSection.map((si) => plan.sections[si]!.kind);
  const unitOf = plan.blockSection.map((si) => plan.sections[si]!.unit);
  const t3 = performance.now();
  const found = extractConcepts(book.blocks, kinds, unitOf);
  console.log(`  concepts ${found.concepts.length}, edges ${found.edges.length}, cards ${found.cards.length} (${((performance.now() - t3) / 1000).toFixed(2)}s)`);
  for (const c of found.concepts.slice(0, 40))
    console.log(`    ${c.importance.toFixed(2)} ${c.name}  [${c.mentions.size} blocks] ${c.definition ? "— " + c.definition.slice(0, 90) : ""}`);
  console.log("  edges:");
  for (const e of [...found.edges].sort((a, b) => b.weight - a.weight).slice(0, 15)) console.log(`    ${e.weight.toFixed(2)} ${e.a} — ${e.b}`);
  console.log("  cards:");
  for (const c of found.cards.slice(0, 12)) console.log(`    [${c.kind}] ${c.front.slice(0, 150)}${c.back ? " → " + c.back.slice(0, 80) : ""}`);
}
