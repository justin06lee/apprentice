/**
 * The book as printed: the open chapter's original pages, drawn by the page
 * renderer at the width they are shown at. For checking a figure, a table,
 * or anything the reflowed text got wrong.
 */
import { BookOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, pageUrl } from "../../api";
import { useReader } from "./state";

export function PageView() {
  const bookId = useReader((s) => s.bookId)!;
  const content = useReader((s) => s.content);
  const target = useReader((s) => s.pageTarget);
  const [sizes, setSizes] = useState<Array<[number, number]> | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    void api.reader.pageSizes(bookId).then(setSizes);
  }, [bookId]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.min(980, e.contentRect.width - 48)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pages = useMemo(() => {
    const ps = (content?.blocks ?? []).map((b) => b.page);
    if (!ps.length) return [];
    const from = Math.min(...ps);
    const to = Math.max(...ps);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }, [content]);

  useEffect(() => {
    if (target === null || !sizes) return;
    requestAnimationFrame(() => ref.current?.querySelector(`[data-page="${target}"]`)?.scrollIntoView({ block: "start" }));
  }, [target, sizes]);

  const px = Math.round(width * Math.min(2, window.devicePixelRatio || 1));
  return (
    <div className="pages" ref={ref}>
      <div className="pages-note muted">
        <BookOpen size={14} /> Original pages {pages.length ? `${pages[0]! + 1}–${pages[pages.length - 1]! + 1}` : ""} · <span className="kbd">Esc</span> back to
        reading
      </div>
      {sizes &&
        pages.map((p) => {
          const [w, h] = sizes[p] ?? [612, 792];
          return (
            <div key={p} className="page" data-page={p} style={{ width, aspectRatio: `${w} / ${h}` }}>
              <img src={pageUrl(bookId, p, px)} loading="lazy" decoding="async" alt={`Page ${p + 1}`} draggable={false} />
              <span className="page-no">{p + 1}</span>
            </div>
          );
        })}
    </div>
  );
}
