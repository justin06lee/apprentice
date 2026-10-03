/**
 * The window's side of the book's pages: text layers fetched once and kept,
 * and how pages pair up into spreads.
 */
import { useEffect, useState } from "react";
import type { PageText } from "../../../shared/pages";
import { api } from "../api";

const texts = new Map<string, PageText>();
const loading = new Map<string, Promise<PageText>>();
const key = (bookId: string, page: number) => `${bookId}#${page}`;

/** A page's text layer if it has already arrived. */
export function pageTextNow(bookId: string, page: number): PageText | undefined {
  return texts.get(key(bookId, page));
}

export function loadPageText(bookId: string, page: number): Promise<PageText> {
  const k = key(bookId, page);
  const have = texts.get(k);
  if (have) return Promise.resolve(have);
  let p = loading.get(k);
  if (!p) {
    p = api.reader.pageText(bookId, page).then((t) => {
      texts.set(k, t);
      loading.delete(k);
      // A long session reads a few hundred pages; that is still only a few MB.
      if (texts.size > 600) texts.delete(texts.keys().next().value!);
      return t;
    });
    p.catch(() => loading.delete(k));
    loading.set(k, p);
  }
  return p;
}

export function usePageText(bookId: string, page: number | null): PageText | null {
  const [text, setText] = useState<PageText | null>(() => (page === null ? null : (pageTextNow(bookId, page) ?? null)));
  useEffect(() => {
    if (page === null) {
      setText(null);
      return;
    }
    const now = pageTextNow(bookId, page);
    setText(now ?? null);
    if (now) return;
    let live = true;
    void loadPageText(bookId, page)
      .then((t) => live && setText(t))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [bookId, page]);
  return text;
}

export type Layout = "spread" | "single";

/**
 * Pages pair as a printed book's do: the first page is a right-hand page on
 * its own, then 2–3, 4–5 … (counting from one). A spread is named by its
 * first page.
 */
export function spreadStart(page: number, layout: Layout): number {
  if (layout === "single" || page <= 0) return Math.max(0, page);
  return page % 2 === 1 ? page : page - 1;
}

/** The pages of a spread, left then right; null where a side is empty. */
export function spreadPages(start: number, layout: Layout, count: number): Array<number | null> {
  if (layout === "single") return [start];
  if (start === 0) return [null, 0];
  return [start, start + 1 < count ? start + 1 : null];
}

export function nextSpread(start: number, dir: 1 | -1, layout: Layout, count: number): number | null {
  let next: number;
  if (layout === "single") next = start + dir;
  else if (dir === 1) next = start === 0 ? 1 : start + 2;
  else next = start === 1 ? 0 : start - 2;
  return next >= 0 && next < count ? next : null;
}
