/**
 * Reading a book: contents on the left, the chapter in the middle, the
 * study tools — ask, notes, cards, concepts, sketch — on the right.
 */
import { ChevronLeft, ChevronRight, FileText, PanelLeft, PanelRight, Search, Type } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useApp } from "../../store";
import { Popover } from "../../components/ui";
import { percent } from "../../lib/format";
import { CardComposer } from "./CardComposer";
import { PageView } from "./PageView";
import { SearchBox } from "./SearchBox";
import { useReader } from "./state";
import { Toc } from "./Toc";
import { Typography } from "./Typography";
import { UnitView } from "./UnitView";
import "../../styles/reader.css";
import "../../styles/panel.css";

const Panel = lazy(() => import("../panel/Panel").then((m) => ({ default: m.Panel })));

export function Reader({ bookId, unitId, blockId }: { bookId: string; unitId?: number | undefined; blockId?: number | undefined }) {
  const book = useReader((s) => s.book);
  const units = useReader((s) => s.units);
  const current = useReader((s) => s.unitId);
  const loading = useReader((s) => s.loading);
  const error = useReader((s) => s.error);
  const tocOpen = useReader((s) => s.tocOpen);
  const panel = useReader((s) => s.panel);
  const pageView = useReader((s) => s.pageView);
  const cardDraft = useReader((s) => s.cardDraft);
  const go = useApp((s) => s.go);
  // Progress changes as the book is read; the library store has it live.
  const readFraction = useApp((s) => s.books.find((b) => b.id === bookId)?.readFraction ?? book?.readFraction ?? 0);
  const scroller = useRef<HTMLDivElement>(null);
  const [typo, setTypo] = useState<DOMRect | null>(null);
  const [search, setSearch] = useState(false);

  useEffect(() => {
    void useReader.getState().open(bookId, unitId, blockId);
  }, [bookId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A jump to a block from elsewhere (search, a concept) while the book is open.
  useEffect(() => {
    if (blockId && useReader.getState().book) void useReader.getState().goToBlock(blockId);
    else if (unitId && useReader.getState().book) void useReader.getState().loadUnit(unitId);
  }, [unitId, blockId]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable;
      const r = useReader.getState();
      const m = e.metaKey || e.ctrlKey;
      if (m && e.key === "f") {
        e.preventDefault();
        setSearch(true);
      } else if (m && e.key === "\\") {
        e.preventDefault();
        r.set({ tocOpen: !r.tocOpen });
      } else if (m && e.key === "j") {
        e.preventDefault();
        r.setPanel(r.panel ? null : "ask");
      } else if (typing || m || e.altKey) {
        return;
      } else if (e.key === "[") {
        r.nextUnit(-1);
      } else if (e.key === "]") {
        r.nextUnit(1);
      } else if (e.key === "/") {
        e.preventDefault();
        setSearch(true);
      } else if (e.key === "Escape") {
        if (r.pageView) r.set({ pageView: false });
        else if (r.editing) r.set({ editing: null });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const unit = units.find((u) => u.id === current);
  const index = units.findIndex((u) => u.id === current);
  const r = useReader.getState();

  return (
    <div className={`reader ${tocOpen ? "with-toc" : ""} ${panel ? "with-panel" : ""}`}>
      <header className="topbar">
        <div className="topbar-left">
          <button className="icon-btn" onClick={() => go({ name: "library" })} title="Library" aria-label="Back to library">
            <ChevronLeft size={18} />
          </button>
          <button className={`icon-btn ${tocOpen ? "on" : ""}`} onClick={() => r.set({ tocOpen: !tocOpen })} title="Contents  Ctrl+\" aria-label="Contents">
            <PanelLeft size={17} />
          </button>
          <div className="crumbs">
            <span className="crumb-book" title={book?.title}>
              {book?.title ?? ""}
            </span>
            {unit && (
              <>
                <ChevronRight size={13} className="muted" />
                <span className="crumb-unit" title={unit.title}>
                  {unit.title}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="topbar-right">
          {book && <span className="topbar-progress muted" title="Read of the whole book">{percent(readFraction)}</span>}
          <button className="icon-btn" disabled={index <= 0} onClick={() => r.nextUnit(-1)} title="Previous chapter  [" aria-label="Previous chapter">
            <ChevronLeft size={17} />
          </button>
          <button className="icon-btn" disabled={index < 0 || index >= units.length - 1} onClick={() => r.nextUnit(1)} title="Next chapter  ]" aria-label="Next chapter">
            <ChevronRight size={17} />
          </button>
          <span className="topbar-sep" />
          <button className="icon-btn" onClick={() => setSearch(true)} title="Search this book  /" aria-label="Search">
            <Search size={17} />
          </button>
          <button
            className={`icon-btn ${typo ? "on" : ""}`}
            onClick={(e) => setTypo((e.currentTarget as HTMLElement).getBoundingClientRect())}
            title="Text and theme"
            aria-label="Text and theme"
          >
            <Type size={17} />
          </button>
          <button className={`icon-btn ${pageView ? "on" : ""}`} onClick={() => r.set({ pageView: !pageView, pageTarget: null })} title="Original pages" aria-label="Original pages">
            <FileText size={17} />
          </button>
          <button className={`icon-btn ${panel ? "on" : ""}`} onClick={() => r.setPanel(panel ? null : "ask")} title="Study panel  Ctrl+J" aria-label="Study panel">
            <PanelRight size={17} />
          </button>
        </div>
      </header>

      <aside className="toc-pane">{tocOpen && <Toc />}</aside>

      <section className="read-pane">
        {error ? (
          <div className="empty">
            <h3>Couldn't open this book</h3>
            <p>{error}</p>
          </div>
        ) : pageView ? (
          <PageView />
        ) : (
          <div className="scroller" ref={scroller}>
            {loading && !useReader.getState().content && <ColumnSkeleton />}
            <UnitView scroller={scroller} />
          </div>
        )}
        {loading && useReader.getState().content && <div className="loading-bar" />}
      </section>

      <aside className="side-pane">
        {panel && (
          <Suspense fallback={null}>
            <Panel />
          </Suspense>
        )}
      </aside>

      {typo && (
        <Popover anchor={{ x: typo.left + typo.width / 2, y: typo.top, h: typo.height }} placement="below" onClose={() => setTypo(null)}>
          <Typography />
        </Popover>
      )}
      {search && <SearchBox onClose={() => setSearch(false)} />}
      {cardDraft && <CardComposer draft={cardDraft} onClose={() => r.set({ cardDraft: null })} />}
    </div>
  );
}

function ColumnSkeleton() {
  return (
    <div className="column skeleton" aria-hidden>
      <div className="sk-line w40 tall" />
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className={`sk-line ${i % 3 === 2 ? "w70" : "w100"}`} />
      ))}
    </div>
  );
}
