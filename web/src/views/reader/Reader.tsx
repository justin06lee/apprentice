/**
 * Reading a book: contents on the left, the book in the middle, the study
 * tools — ask, notes, cards, concepts, sketch — on the right.
 */
import { BookOpen, ChevronLeft, ChevronRight, PanelLeft, PanelRight, Search, SquareDashedMousePointer } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Popover } from "../../components/ui";
import { percent } from "../../lib/format";
import { useApp } from "../../store";
import { Book } from "./Book";
import { CardComposer } from "./CardComposer";
import { SearchBox } from "./SearchBox";
import { lastVisible, unitAtPage, useReader } from "./state";
import { Toc } from "./Toc";
import { ViewMenu } from "./ViewMenu";
import "../../styles/reader.css";
import "../../styles/panel.css";

const Panel = lazy(() => import("../panel/Panel").then((m) => ({ default: m.Panel })));

export function Reader({ bookId, page, blockId, terms }: { bookId: string; page?: number | undefined; blockId?: number | undefined; terms?: string[] | undefined }) {
  const book = useReader((s) => s.book);
  const units = useReader((s) => s.units);
  const current = useReader(lastVisible);
  const loading = useReader((s) => s.loading);
  const ready = useReader((s) => s.sizes.length > 0);
  const error = useReader((s) => s.error);
  const tocOpen = useReader((s) => s.tocOpen);
  const panel = useReader((s) => s.panel);
  const boxMode = useReader((s) => s.boxMode);
  const cardDraft = useReader((s) => s.cardDraft);
  const go = useApp((s) => s.go);
  // Progress changes as the book is read; the library store has it live.
  const readFraction = useApp((s) => s.books.find((b) => b.id === bookId)?.readFraction ?? book?.readFraction ?? 0);
  const [view, setView] = useState<DOMRect | null>(null);
  const [search, setSearch] = useState(false);

  useEffect(() => {
    void useReader.getState().open(bookId, { page, blockId, terms });
  }, [bookId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A jump from elsewhere (search, a concept, a card) while the book is open.
  useEffect(() => {
    const r = useReader.getState();
    if (!r.book) return;
    if (blockId) void r.goToBlock(blockId, terms);
    else if (page !== undefined) r.goTo(page, terms ? { terms } : undefined);
  }, [page, blockId, terms]);

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
      } else if (e.key === "b") {
        r.set({ boxMode: !r.boxMode });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const unit = unitAtPage(units, current);
  const sorted = [...units].sort((a, b) => a.page - b.page);
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
          {book && (
            <span className="topbar-progress muted" title="Read of the whole book">
              {percent(readFraction)}
            </span>
          )}
          <button className="icon-btn" disabled={!unit || sorted[0]?.page === unit.page} onClick={() => r.nextUnit(-1)} title="Previous chapter  [" aria-label="Previous chapter">
            <ChevronLeft size={17} />
          </button>
          <button
            className="icon-btn"
            disabled={!unit || sorted[sorted.length - 1]?.page === unit.page}
            onClick={() => r.nextUnit(1)}
            title="Next chapter  ]"
            aria-label="Next chapter"
          >
            <ChevronRight size={17} />
          </button>
          <span className="topbar-sep" />
          <button className="icon-btn" onClick={() => setSearch(true)} title="Search this book  /" aria-label="Search">
            <Search size={17} />
          </button>
          <button
            className={`icon-btn ${boxMode ? "on" : ""}`}
            onClick={() => r.set({ boxMode: !boxMode })}
            title="Box a figure or equation to ask about it  B  (or Alt-drag)"
            aria-label="Box a region"
          >
            <SquareDashedMousePointer size={17} />
          </button>
          <button
            className={`icon-btn ${view ? "on" : ""}`}
            onClick={(e) => setView((e.currentTarget as HTMLElement).getBoundingClientRect())}
            title="Pages and theme"
            aria-label="Pages and theme"
          >
            <BookOpen size={17} />
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
        ) : ready ? (
          <Book />
        ) : null}
        {loading && <div className="loading-bar" />}
      </section>

      <aside className="side-pane">
        {panel && (
          <Suspense fallback={null}>
            <Panel />
          </Suspense>
        )}
      </aside>

      {view && (
        <Popover anchor={{ x: view.left + view.width / 2, y: view.top, h: view.height }} placement="below" onClose={() => setView(null)}>
          <ViewMenu />
        </Popover>
      )}
      {search && <SearchBox onClose={() => setSearch(false)} />}
      {cardDraft && <CardComposer draft={cardDraft} onClose={() => r.set({ cardDraft: null })} />}
    </div>
  );
}
