/**
 * A book's concepts, found without a model, at import.
 *
 * Textbooks announce their concepts: a term is set in bold (or in italics
 * inside a sentence that says "is called" or "we define") where it is
 * defined, glossaries list them, section titles name them. Those are the
 * candidates. Every candidate is then looked for everywhere in the book,
 * which gives each one its mentions — where it is used — and, from the
 * paragraphs two concepts share, how strongly they are related.
 *
 * The same pass writes the first flashcards: each defining sentence, with
 * the term blanked out. They wait, pending, until their chapter is read.
 */
import { MarkFlag, type SectionKind } from "../../shared/types.js";
import { sentenceAround, termKey, TermMatcher, termWords } from "../knowledge/terms.js";
import type { PBlock } from "./analyze.js";

export interface FoundConcept {
  key: string;
  name: string;
  definition: string | null;
  /** Block index of the definition. */
  defBlock: number | null;
  importance: number;
  /** Block index → mentions in it. */
  mentions: Map<number, number>;
}

export interface FoundEdge {
  a: string;
  b: string;
  weight: number;
}

export interface FoundCard {
  block: number;
  kind: "basic" | "cloze";
  front: string;
  back: string;
  concepts: string[];
}

const LABELS = new Set(
  (
    "note notes example examples exercise exercises proof theorem lemma corollary definition definitions remark remarks solution solutions " +
    "answer answers hint hints warning important summary introduction chapter section figure fig table step case problem problems question " +
    "questions key tip tips caution observe notice glossary debugging overview conclusion conclusions review practice part appendix " +
    "algorithm proposition claim conjecture axiom property properties fact facts exploration activity objective objectives goal goals " +
    "background motivation preview recap checkpoint aside sidebar historical history reference references bibliography index contents"
  ).split(" "),
);

const STOP = new Set(
  (
    "a an the of and or not no nor but if then else to in on at by for with from as is are was were be been being this that these those " +
    "it its we you they he she i me my our your their all any each every some only must never always very also just so such than too can " +
    "will would should could may might do does did done have has had one two three first second new old same other more most less least " +
    "here there now how why what when where which who whom whose yes thus hence therefore however recall consider suppose let note see " +
    "following above below using use given"
  ).split(" "),
);

const DEFINES =
  /\b(is|are|was|were) (called|termed|known as|said to be|referred to as|defined (as|to be|by))\b|\bwe (call|say|define|refer to|denote|write)\b|\b(is|are) defined\b|\bmeans?\b|\bdenotes?\b|\brefers? to\b|\bcalled\b|\bknown as\b|\bstands? for\b/i;

const GENERIC_HEADINGS =
  /^(exercises?|problems?|introduction|summary|glossary|debugging|historical remarks|review|overview|examples?|notes?|references|conclusions?|further reading|solutions?|answers?|preview|key terms|step \d+|step k\b|case \d+|what'?s next|chapter review|self[- ]check|practice|projects?|appendix)/i;

function cleanTerm(raw: string): string | null {
  const t = raw
    .replace(/^[\s"“‘'(\[.,;:!?—–-]+|[\s"”’'):;,.\]!?—–-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length < 2 || t.length > 60) return null;
  const words = t.split(" ");
  if (words.length > 5) return null;
  if (!/\p{L}{2}/u.test(t)) return null;
  const norm = termWords(t);
  if (!norm.length || LABELS.has(norm[0]!)) return null;
  // "is a", "and returns", "the function": a phrase, not a name.
  if (norm.every((w) => STOP.has(w))) return null;
  if (STOP.has(norm[0]!) || STOP.has(norm[norm.length - 1]!)) return null;
  // Names carry the odd "of" or "and"; a clause carries several.
  if (norm.filter((w) => STOP.has(w)).length > 1) return null;
  if (/^\d/.test(t) || /[=<>{}[\]|\\]/.test(t)) return null;
  return t;
}

export function extractConcepts(
  blocks: PBlock[],
  kinds: SectionKind[],
  unitOf: number[],
): { concepts: FoundConcept[]; edges: FoundEdge[]; cards: FoundCard[] } {
  interface Cand {
    key: string;
    forms: Map<string, number>;
    bold: number;
    italicDef: number;
    heading: boolean;
    glossary: boolean;
    def: { block: number; sentence: string; surface: string; glossary: boolean } | null;
    defRank: number;
  }
  const cands = new Map<string, Cand>();
  const cand = (name: string): Cand => {
    const key = termKey(name);
    let c = cands.get(key);
    if (!c) {
      c = { key, forms: new Map(), bold: 0, italicDef: 0, heading: false, glossary: false, def: null, defRank: -1 };
      cands.set(key, c);
    }
    c.forms.set(name, (c.forms.get(name) ?? 0) + 1);
    return c;
  };

  let inGlossary = false;
  blocks.forEach((b, i) => {
    const kind = kinds[i]!;
    if (b.type === "heading") {
      inGlossary = /^(glossary|key terms|vocabulary|definitions)\b/i.test(b.text);
      if (b.level >= 2 && (kind === "body" || kind === "exercises") && !GENERIC_HEADINGS.test(b.text)) {
        const name = cleanTerm(b.text);
        if (name && name.split(" ").length <= 5) cand(name).heading = true;
      }
      return;
    }
    // Exercises bold their labels and their instructions, not their terms.
    if (kind !== "body") return;
    if (b.type !== "paragraph" && b.type !== "list") return;
    for (const m of b.marks) {
      if (m.f & (MarkFlag.MATH | MarkFlag.MONO)) continue;
      const bold = (m.f & MarkFlag.BOLD) !== 0;
      const italic = (m.f & MarkFlag.ITALIC) !== 0;
      if (!bold && !italic) continue;
      const raw = b.text.slice(m.s, m.e);
      // A whole paragraph in bold is a heading the parser kept as text.
      if (raw.length >= b.text.trim().length * 0.8) continue;
      const name = cleanTerm(raw);
      if (!name) continue;
      const { text: sentence } = sentenceAround(b.text, m.s, m.e);
      // "variable: a name that refers to a value" — a glossary entry, in a
      // glossary or not.
      const atStart = b.text.slice(0, m.s).trim().length === 0;
      const after = b.text.slice(m.e).trimStart();
      const glossaryEntry = atStart && (/[:—–]\s*$/.test(raw) || /^[:—–]/.test(after));
      const defining = bold || DEFINES.test(sentence) || glossaryEntry;
      if (!defining) continue;
      const c = cand(name);
      if (bold) c.bold++;
      else c.italicDef++;
      if (glossaryEntry && inGlossary) c.glossary = true;
      // Keep the occurrence that most reads like a definition.
      const def = { block: i, sentence: glossaryEntry ? b.text.trim() : sentence, surface: raw.trim(), glossary: glossaryEntry };
      const rank = (d: typeof def, isBold: boolean) =>
        (d.glossary ? 4 : 0) + (DEFINES.test(d.sentence) ? 2 : 0) + (isBold ? 1 : 0) + (d.sentence.length >= 30 && d.sentence.length <= 320 ? 1 : 0);
      if (!c.def || rank(def, bold) > c.defRank) {
        c.def = def;
        c.defRank = rank(def, bold);
      }
    }
  });

  // Where each candidate is used.
  const list = [...cands.values()];
  const matcher = new TermMatcher();
  list.forEach((c, i) => matcher.add(c.key, i));
  const mentions = list.map(() => new Map<number, number>());
  const units = list.map(() => new Set<number>());
  const blockConcepts: number[][] = blocks.map(() => []);
  blocks.forEach((b, i) => {
    const kind = kinds[i]!;
    if (kind !== "body" && kind !== "exercises") return;
    if (b.type === "code" || b.type === "equation" || b.type === "table" || b.type === "figure") return;
    for (const [id, n] of matcher.match(b.text)) {
      mentions[id]!.set(i, n);
      units[id]!.add(unitOf[i]!);
      blockConcepts[i]!.push(id);
    }
  });

  // Rank, and keep the ones the book itself treats as concepts.
  const scored = list
    .map((c, i) => {
      const total = [...mentions[i]!.values()].reduce((s, n) => s + n, 0);
      const announced = c.bold + c.italicDef + (c.heading ? 1 : 0);
      const score =
        (c.def ? 2 : 0) + (c.glossary ? 1 : 0) + (c.heading ? 1.5 : 0) + Math.log2(1 + total) + Math.log2(1 + units[i]!.size) + Math.min(announced, 3) * 0.3;
      return { c, i, total, score };
    })
    .filter((x) => {
      if (x.total < 1) return false;
      // Defined once and never used again is an aside ("isos means equal").
      if (x.c.def) return x.total >= 2 || x.c.glossary;
      // A section titled with one everyday word ("Time", "Odds") is a topic
      // only if the book also sets it apart somewhere else.
      return x.c.heading && x.total >= 2 && (x.c.key.includes(" ") || x.c.bold + x.c.italicDef > 0);
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 500);
  const maxScore = scored[0]?.score ?? 1;
  const kept = new Map(scored.map((x) => [x.i, x]));

  const displayName = (c: Cand): string => {
    let best = "";
    let n = -1;
    for (const [form, count] of c.forms) if (count > n) [best, n] = [form, count];
    // The form the book defines it under is its name ("variable", not the
    // "variables" it is mostly bolded as).
    if (c.def) {
      const surface = cleanTerm(c.def.surface);
      if (surface && termKey(surface) === c.key) best = surface;
    }
    // "Variable" set in bold at the start of a sentence is "variable".
    // A name known only from a Title Cased heading reads in lower case,
    // acronyms and proper names aside.
    if (c.bold + c.italicDef === 0 && c.heading && /\s/.test(best)) {
      best = best
        .split(" ")
        .map((w, i) => (/^\p{Lu}\p{Ll}+$/u.test(w) && (i > 0 || true) ? w.toLowerCase() : w))
        .join(" ");
    }
    if (/^\p{Lu}\p{Ll}/u.test(best) && best.slice(1) === best.slice(1).toLowerCase()) {
      for (const form of c.forms.keys()) if (form === best.toLowerCase()) return form;
      if (!c.heading || c.forms.size > 1) return best[0]!.toLowerCase() + best.slice(1);
    }
    return best;
  };

  const concepts: FoundConcept[] = scored.map(({ c, i, score }) => ({
    key: c.key,
    name: displayName(c),
    definition: c.def?.sentence ?? null,
    defBlock: c.def?.block ?? null,
    importance: Math.round((score / maxScore) * 1000) / 1000,
    mentions: mentions[i]!,
  }));

  // Relatedness: shared paragraphs, normalized by how common each is, plus
  // a strong link from a concept to the concepts its definition uses.
  const pair = new Map<string, number>();
  const bump = (a: number, b: number, by: number) => {
    if (a === b || !kept.has(a) || !kept.has(b)) return;
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    pair.set(k, (pair.get(k) ?? 0) + by);
  };
  for (const ids of blockConcepts) {
    if (ids.length > 25) continue; // an index-like paragraph relates nothing
    for (let x = 0; x < ids.length; x++) for (let y = x + 1; y < ids.length; y++) bump(ids[x]!, ids[y]!, 1);
  }
  for (const { c, i } of scored) {
    if (!c.def) continue;
    for (const id of matcher.match(c.def.sentence).keys()) bump(i, id, 2);
  }
  const freq = (i: number) => mentions[i]!.size;
  const raw: Array<{ a: number; b: number; w: number }> = [];
  for (const [k, n] of pair) {
    if (n < 2) continue;
    const [a, b] = k.split(":").map(Number) as [number, number];
    // Cosine over shared paragraphs, discounted while the evidence is thin.
    raw.push({ a, b, w: (n / Math.sqrt(freq(a) * freq(b))) * Math.min(1, Math.log2(1 + n) / 3) });
  }
  // Each concept keeps its strongest few links, so the map stays readable.
  const perNode = new Map<number, Array<{ a: number; b: number; w: number }>>();
  for (const e of raw) {
    for (const end of [e.a, e.b]) {
      const l = perNode.get(end) ?? [];
      l.push(e);
      perNode.set(end, l);
    }
  }
  const chosen = new Set<{ a: number; b: number; w: number }>();
  for (const l of perNode.values()) for (const e of l.sort((p, q) => q.w - p.w).slice(0, 8)) chosen.add(e);
  const maxW = Math.max(0.0001, ...[...chosen].map((e) => e.w));
  const edges: FoundEdge[] = [...chosen]
    .filter((e) => e.w / maxW >= 0.05)
    .map((e) => ({ a: list[e.a]!.key, b: list[e.b]!.key, weight: Math.round(Math.min(1, e.w / maxW) * 1000) / 1000 }));

  // First cards: each definition, with the term to recall.
  const cards: FoundCard[] = [];
  const perUnit = new Map<number, number>();
  for (const { c } of scored) {
    if (!c.def) continue;
    const unit = unitOf[c.def.block]!;
    if ((perUnit.get(unit) ?? 0) >= 15) continue;
    const name = displayName(c);
    const sentence = c.def.sentence;
    let card: FoundCard | null = null;
    if (c.def.glossary) {
      const body = sentence.replace(/^[^:—–]*[:—–]\s*/, "").trim();
      if (body.length >= 15) card = { block: c.def.block, kind: "basic", front: `What does “${name}” mean?`, back: body, concepts: [c.key] };
    } else {
      const at = sentence.toLowerCase().indexOf(c.def.surface.toLowerCase());
      if (at >= 0 && sentence.length >= 30) {
        let text = `${sentence.slice(0, at)}{{c1::${sentence.slice(at, at + c.def.surface.length)}}}${sentence.slice(at + c.def.surface.length)}`;
        if (text.length > 360) {
          const from = Math.max(0, at - 160);
          text = `${from ? "…" : ""}${text.slice(from, from + 330)}…`;
        }
        card = { block: c.def.block, kind: "cloze", front: text, back: "", concepts: [c.key] };
      }
    }
    if (!card) continue;
    for (const id of matcher.match(sentence).keys()) if (kept.has(id) && list[id]!.key !== c.key) card.concepts.push(list[id]!.key);
    cards.push(card);
    perUnit.set(unit, (perUnit.get(unit) ?? 0) + 1);
  }

  return { concepts, edges, cards };
}
