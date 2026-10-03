/**
 * Search inside the open book (or, with a toggle, every book), as you type.
 * Opening a hit turns to its page with the words marked on it.
 */
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SearchHit } from "../../../../shared/types";
import { api } from "../../api";
import { useReader } from "./state";

export function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\u0001[^\u0002]*\u0002)/);
  return (
    <span className="search-snippet">
      {parts.map((p, i) => (p.startsWith("\u0001") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}
    </span>
  );
}

/** The words of a query, for marking on the page. */
export function searchTerms(q: string): string[] {
  return q
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1)
    .slice(0, 8);
}

export function SearchBox({ onClose }: { onClose(): void }) {
  const bookId = useReader((s) => s.bookId);
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void api.reader.search(q, all ? null : bookId).then((h) => {
        if (live) {
          setHits(h);
          setActive(0);
        }
      });
    }, 90);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, all, bookId]);

  useEffect(() => {
    listRef.current?.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const open = (h: SearchHit) => {
    onClose();
    void useReader.getState().goToBlock(h.blockId, searchTerms(q));
  };

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <div className="palette-input">
          <Search size={18} />
          <input
            autoFocus
            placeholder={all ? "Search every book…" : "Search this book…"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(hits.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter" && hits[active]) open(hits[active]!);
            }}
          />
          <div className="segmented">
            <button className={!all ? "on" : ""} onClick={() => setAll(false)}>
              This book
            </button>
            <button className={all ? "on" : ""} onClick={() => setAll(true)}>
              All books
            </button>
          </div>
        </div>
        <div className="palette-list" ref={listRef}>
          {q.trim() && !hits.length && <div className="empty">No passage mentions that.</div>}
          {hits.map((h, i) => (
            <button key={h.blockId} className={`palette-item ${i === active ? "active" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => open(h)}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="sub">
                  {all ? `${h.bookTitle} · ` : ""}
                  {h.unitTitle} · p. {h.page + 1}
                </div>
                <div className="search-line">
                  <Snippet text={h.snippet} />
                </div>
              </div>
            </button>
          ))}
        </div>
        <div className="palette-foot">
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> to move
          </span>
          <span>
            <span className="kbd">↵</span> to open
          </span>
          <span>
            <span className="kbd">Esc</span> to close
          </span>
        </div>
      </div>
    </div>
  );
}
