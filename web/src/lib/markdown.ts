/**
 * Model answers → HTML: markdown by marked, math by KaTeX, and everything
 * the model wrote sanitized before it touches the page. Math is cut out
 * before markdown sees it (so `x_1 * y_2` stays math, not emphasis), and
 * typeset after sanitizing, from source KaTeX itself escapes.
 */
import DOMPurify from "dompurify";
import katex from "katex";
import { Marked } from "marked";

const marked = new Marked({ gfm: true, breaks: false });

marked.use({
  renderer: {
    link({ href, text }) {
      return `<a href="${href}" target="_blank" rel="noreferrer">${text}</a>`;
    },
  },
});

function tex(src: string, display: boolean): string {
  try {
    return katex.renderToString(src, { displayMode: display, throwOnError: false, strict: false, output: "html" });
  } catch {
    return `<code>${src.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</code>`;
  }
}

export function renderMarkdown(src: string): string {
  const stash: string[] = [];
  const keep = (html: string) => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };
  // Code first: nothing inside a code span or block is math.
  const code: string[] = [];
  let s = src.replace(/```[\s\S]*?(```|$)|`[^`\n]*`/g, (m) => {
    code.push(m);
    return `\u0001${code.length - 1}\u0001`;
  });
  s = s
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t: string) => keep(tex(t.trim(), true)))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t: string) => keep(tex(t.trim(), true)))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t: string) => keep(tex(t.trim(), false)))
    .replace(/(^|[^\\$\w])\$(?=\S)([^$\n]+?)(?<=\S)\$(?![\w$])/g, (_, pre: string, t: string) => pre + keep(tex(t, false)));
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i: string) => code[Number(i)]!);
  const html = DOMPurify.sanitize(marked.parse(s, { async: false }) as string, { ADD_ATTR: ["target"] });
  return html.replace(/\u0000(\d+)\u0000/g, (_, i: string) => stash[Number(i)]!);
}

/** One piece of inline TeX, for the reader's own text. */
export function renderTex(src: string, display = false): string {
  return tex(src, display);
}

/** A card's text as HTML, cloze gaps drawn as gaps (or, revealed, as the answer). */
export function cardHtml(text: string, kind: "basic" | "cloze", reveal: boolean): string {
  const src =
    kind === "cloze"
      ? text.replace(/\{\{c\d+::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (_, answer: string, hint?: string) => `⟦${reveal ? answer : (hint ?? "…")}⟧`)
      : text;
  return renderMarkdown(src).replace(/⟦([\s\S]*?)⟧/g, (_, inner: string) => `<span class="cloze${reveal ? " shown" : ""}">${inner}</span>`);
}
