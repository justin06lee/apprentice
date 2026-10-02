/**
 * Terms: how a concept's name is normalized, and how its mentions are found
 * in text. Shared by import (which finds a book's concepts) and the main
 * process (which places concepts the AI names later).
 */

const KEEP_S = /(ss|us|is|os|as|ics)$/;

function singular(word: string): string {
  if (word.length <= 3 || KEEP_S.test(word)) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** Words of a text as the matcher sees them: lower case, accents off, plurals folded. */
export function termWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(singular);
}

/** The identity of a concept across books: "Vector spaces" and "vector space" are one. */
export function termKey(name: string): string {
  return termWords(name).join(" ");
}

interface Node {
  next: Map<string, Node>;
  id: number | null;
}

/**
 * Finds every known term in a text in one pass: a trie over the terms' word
 * sequences, walked from each word, longest match wins. Linear in the text,
 * whatever the number of terms.
 */
export class TermMatcher {
  private root: Node = { next: new Map(), id: null };
  size = 0;

  add(key: string, id: number): void {
    const words = key.split(" ").filter(Boolean);
    if (!words.length) return;
    let node = this.root;
    for (const w of words) {
      let next = node.next.get(w);
      if (!next) {
        next = { next: new Map(), id: null };
        node.next.set(w, next);
      }
      node = next;
    }
    if (node.id === null) this.size++;
    node.id = id;
  }

  /** Term id → number of mentions. */
  match(text: string): Map<number, number> {
    const found = new Map<number, number>();
    const words = termWords(text);
    let i = 0;
    while (i < words.length) {
      let node = this.root.next.get(words[i]!);
      let j = i;
      let hit: number | null = null;
      let hitEnd = i;
      while (node) {
        if (node.id !== null) {
          hit = node.id;
          hitEnd = j;
        }
        j++;
        node = j < words.length ? node.next.get(words[j]!) : undefined;
      }
      if (hit !== null) {
        found.set(hit, (found.get(hit) ?? 0) + 1);
        i = hitEnd + 1;
      } else i++;
    }
    return found;
  }
}

/** The sentence around [start, end) in a text. */
export function sentenceAround(text: string, start: number, end: number): { text: string; offset: number } {
  const boundary = /[.!?](?:["”’)\]]*)\s+(?=["“(]?[\p{Lu}\p{N}])/gu;
  let from = 0;
  let to = text.length;
  for (const m of text.matchAll(boundary)) {
    const at = m.index! + m[0].length;
    // "e.g. " and "i.e. " and initials are not ends of sentences.
    const before = text.slice(Math.max(0, m.index! - 4), m.index! + 1);
    if (/\b(e\.g|i\.e|etc|vs|cf|Fig|Eq|resp|al)\.$/i.test(before) || /\b\p{Lu}\.$/u.test(before)) continue;
    if (at <= start) from = at;
    else if (m.index! >= end) {
      to = m.index! + 1;
      break;
    }
  }
  return { text: text.slice(from, to).trim(), offset: from };
}
