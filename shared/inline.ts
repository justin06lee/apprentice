/**
 * The reader's own text is written in a sliver of markdown — **bold**,
 * *italic*, `code`, $math$ — parsed here into plain text and marks, so it
 * highlights and searches like the book's own. Shared because the main
 * process has to agree with the window on what the plain text is: that is
 * what highlight offsets count.
 */
import type { Mark } from "./types.js";

/** Mark flags above the six MarkFlag bits: typeset math, inline and display. */
export const TEX = 64;
export const TEX_DISPLAY = 128;

export function parseInline(src: string): { text: string; marks: Mark[] } {
  const token = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\*\*[^*\n]+?\*\*|`[^`\n]+`|\*[^*\s][^*\n]*?\*|(?<![\w])_[^_\s][^_\n]*?_(?![\w]))/g;
  let text = "";
  const marks: Mark[] = [];
  let last = 0;
  for (const m of src.matchAll(token)) {
    text += src.slice(last, m.index);
    const t = m[0];
    let inner: string;
    let f: number;
    if (t.startsWith("$$")) {
      inner = t.slice(2, -2);
      f = TEX | TEX_DISPLAY;
    } else if (t.startsWith("$")) {
      inner = t.slice(1, -1);
      f = TEX;
    } else if (t.startsWith("**")) {
      inner = t.slice(2, -2);
      f = 1;
    } else if (t.startsWith("`")) {
      inner = t.slice(1, -1);
      f = 4;
    } else {
      inner = t.slice(1, -1);
      f = 2;
    }
    const s = text.length;
    text += inner;
    marks.push({ s, e: text.length, f });
    last = m.index! + t.length;
  }
  text += src.slice(last);
  return { text, marks };
}


export function plainText(src: string): string {
  return parseInline(src).text;
}
