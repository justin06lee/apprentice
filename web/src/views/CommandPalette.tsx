/**
 * Ctrl/Cmd+K: go anywhere, do anything, find any passage. Books, the open
 * book's chapters and the common actions filter as you type; anything else
 * typed searches the text of every book.
 */
import { BookOpen, FileText, GraduationCap, LibraryBig, Moon, Plus, Search, Settings, Sun, Waypoints } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchHit } from "../../../shared/types";
import { api } from "../api";
import { useApp } from "../store";
import { useReader } from "./reader/state";
import { Snippet } from "./reader/SearchBox";

interface Item {
  id: string;
  group: string;
  label: string;
  sub?: string;
  icon: React.ReactNode;
  run(): void;
}

function score(text: string, q: string): number {
  const t = text.toLowerCase();
  if (!q) return 1;
  const i = t.indexOf(q);
  if (i === 0) return 3;
  if (i > 0) return 2;
  // Every word of the query somewhere in the label.
  return q.split(/\s+/).every((w) => t.includes(w)) ? 1 : 0;
}

export function CommandPalette({ onClose }: { onClose(): void }) {
  const books = useApp((s) => s.books);
  const route = useApp((s) => s.route);
  const go = useApp((s) => s.go);
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const units = useReader((s) => s.units);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const query = q.trim().toLowerCase();

  const items = useMemo(() => {
    const out: Item[] = [];
    const close = (fn: () => void) => () => {
      onClose();
      fn();
    };
    const actions: Item[] = [
      { id: "a-lib", group: "Go to", label: "Library", icon: <LibraryBig size={16} />, run: close(() => go({ name: "library" })) },
      { id: "a-rev", group: "Go to", label: "Review cards", icon: <GraduationCap size={16} />, run: close(() => go({ name: "review" })) },
      { id: "a-map", group: "Go to", label: "Knowledge map", icon: <Waypoints size={16} />, run: close(() => go({ name: "map" })) },
      { id: "a-set", group: "Go to", label: "Settings", icon: <Settings size={16} />, run: close(() => go({ name: "settings" })) },
      { id: "a-add", group: "Actions", label: "Add a textbook…", icon: <Plus size={16} />, run: close(() => void api.books.import()) },
      {
        id: "a-theme",
        group: "Actions",
        label: settings.theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        icon: settings.theme === "dark" ? <Sun size={16} /> : <Moon size={16} />,
        run: close(() => void setSettings({ theme: settings.theme === "dark" ? "light" : "dark" })),
      },
    ];
    if (route.name === "reader") {
      for (const u of units)
        out.push({
          id: `u-${u.id}`,
          group: "Chapters",
          label: u.title,
          icon: <FileText size={16} />,
          run: close(() => void useReader.getState().loadUnit(u.id)),
        });
    }
    for (const b of books)
      if (b.status === "ready")
        out.push({
          id: `b-${b.id}`,
          group: "Books",
          label: b.title,
          ...(b.author ? { sub: b.author } : {}),
          icon: <BookOpen size={16} />,
          run: close(() => go({ name: "reader", bookId: b.id })),
        });
    out.push(...actions);
    return out
      .map((it) => ({ it, s: score(it.label, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, query ? 12 : 30)
      .map((x) => x.it);
  }, [books, go, onClose, query, route.name, setSettings, settings.theme, units]);

  useEffect(() => {
    if (query.length < 3) {
      setHits([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => void api.reader.search(q, null).then((h) => live && setHits(h.slice(0, 12))), 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, query.length]);

  const all: Item[] = [
    ...items,
    ...hits.map((h) => ({
      id: `h-${h.blockId}`,
      group: "In the text",
      label: h.snippet,
      sub: `${h.bookTitle} · ${h.unitTitle}`,
      icon: <Search size={16} />,
      run: () => {
        onClose();
        go({ name: "reader", bookId: h.bookId, unitId: h.unitId, blockId: h.blockId });
      },
    })),
  ];

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let lastGroup = "";
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <div className="palette-input">
          <Search size={18} />
          <input
            autoFocus
            placeholder="Go to a book or chapter, run a command, or search the text…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(all.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") all[active]?.run();
            }}
          />
        </div>
        <div className="palette-list" ref={listRef}>
          {!all.length && <div className="empty">Nothing matches.</div>}
          {all.map((it, i) => {
            const header = it.group !== lastGroup ? <div className="palette-group label">{it.group}</div> : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {header}
                <button className={`palette-item ${i === active ? "active" : ""}`} onMouseEnter={() => setActive(i)} onClick={it.run}>
                  {it.icon}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className={it.group === "In the text" ? "search-line" : "main"}>{it.group === "In the text" ? <Snippet text={it.label} /> : it.label}</div>
                    {it.sub && <div className="sub">{it.sub}</div>}
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
