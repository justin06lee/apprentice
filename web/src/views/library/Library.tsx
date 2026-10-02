/**
 * The library: every book, how far along it is, and the way back into the
 * last one. Books being imported sit in the grid filling in as they go.
 */
import { BookOpen, Ellipsis, FolderOpen, GraduationCap, Pencil, Plus, RotateCcw, Trash2, Upload, Waypoints } from "lucide-react";
import { memo, useMemo, useState } from "react";
import type { Book } from "../../../../shared/types";
import { api, errorText } from "../../api";
import { Modal, Popover, Ring, type Anchor } from "../../components/ui";
import { duration, percent, plural } from "../../lib/format";
import { useApp } from "../../store";
import "../../styles/library.css";

const STAGES: Record<string, string> = {
  extract: "Reading pages",
  analyze: "Finding structure",
  render: "Cutting out figures",
  concepts: "Mapping concepts",
  save: "Shelving",
};

function Cover({ book, size = "m" }: { book: Book; size?: "m" | "l" }) {
  const [failed, setFailed] = useState(false);
  if (book.cover && !failed) {
    return <img className={`cover cover-${size}`} src={book.cover} alt="" draggable={false} onError={() => setFailed(true)} loading="lazy" />;
  }
  // A typeset stand-in, tinted from the title so books are told apart.
  let hash = 0;
  for (const ch of book.title) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return (
    <div className={`cover cover-${size} cover-made`} style={{ ["--hue" as string]: hue }}>
      <span>{book.title}</span>
      {book.author && <small>{book.author}</small>}
    </div>
  );
}

const BookCard = memo(function BookCard({ book, onMenu }: { book: Book; onMenu(book: Book, at: Anchor): void }) {
  const go = useApp((s) => s.go);
  const importing = book.status === "importing";
  const failed = book.status === "error";
  return (
    <div
      className={`book ${importing ? "importing" : ""} ${failed ? "failed" : ""}`}
      onClick={() => !importing && !failed && go({ name: "reader", bookId: book.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(book, { x: e.clientX, y: e.clientY });
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && !importing && go({ name: "reader", bookId: book.id })}
    >
      <div className="book-cover">
        <Cover book={book} />
        {importing && (
          <div className="book-veil">
            <Ring value={book.importProgress} size={44} stroke={4} />
            <span>{STAGES[book.importStage ?? ""] ?? "Waiting"}…</span>
          </div>
        )}
        {failed && (
          <div className="book-veil bad">
            <span>Import failed</span>
            <button
              className="btn small"
              onClick={(e) => {
                e.stopPropagation();
                void api.books.retry(book.id);
              }}
            >
              <RotateCcw size={13} /> Retry
            </button>
          </div>
        )}
        {!importing && !failed && book.dueCards > 0 && <span className="book-due">{book.dueCards} due</span>}
      </div>
      <div className="book-meta">
        <div className="book-title" title={book.title}>
          {book.title}
        </div>
        <div className="book-sub">{book.author ?? (importing ? `${percent(book.importProgress)}` : `${book.pageCount} pages`)}</div>
        {!importing && !failed && (
          <div className="book-progress">
            <div className="progress-bar">
              <i style={{ transform: `scaleX(${book.readFraction})` }} />
            </div>
            <span>{percent(book.readFraction)}</span>
          </div>
        )}
      </div>
      <button
        className="icon-btn small book-menu"
        aria-label="Book options"
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onMenu(book, { x: r.left + r.width / 2, y: r.bottom, h: 0 });
        }}
      >
        <Ellipsis size={16} />
      </button>
    </div>
  );
});

export function Library() {
  const books = useApp((s) => s.books);
  const loaded = useApp((s) => s.booksLoaded);
  const go = useApp((s) => s.go);
  const toast = useApp((s) => s.toast);
  const [menu, setMenu] = useState<{ book: Book; at: Anchor } | null>(null);
  const [renaming, setRenaming] = useState<Book | null>(null);
  const [removing, setRemoving] = useState<Book | null>(null);

  const recent = useMemo(() => books.filter((b) => b.status === "ready" && b.openedAt).sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))[0], [books]);
  const due = books.reduce((s, b) => s + b.dueCards, 0);
  const time = books.reduce((s, b) => s + b.timeMs, 0);

  const add = async () => {
    try {
      await api.books.import();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  if (loaded && !books.length) {
    return (
      <div className="library">
        <div className="library-empty">
          <div className="library-empty-art">
            <Upload size={30} />
          </div>
          <h1>Your study desk is empty</h1>
          <p>
            Add a textbook PDF. apprentice reads it into clean, reflowed text — headings, figures, footnotes and equations intact — and maps
            what it teaches, so you can highlight, ask, sketch and remember as you go.
          </p>
          <button className="btn primary large" onClick={add}>
            <Plus size={16} /> Add a textbook
          </button>
          <span className="muted">or drop PDFs anywhere in this window</span>
        </div>
      </div>
    );
  }

  return (
    <div className="library">
      <header className="library-head">
        <div>
          <h1>Library</h1>
          <p className="muted">
            {plural(books.length, "book")}
            {time > 60000 ? ` · ${duration(time)} read` : ""}
            {due ? ` · ${plural(due, "card")} due` : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {due > 0 && (
            <button className="btn" onClick={() => go({ name: "review" })}>
              <GraduationCap size={15} /> Review {due}
            </button>
          )}
          <button className="btn primary" onClick={add}>
            <Plus size={15} /> Add textbook
          </button>
        </div>
      </header>

      {recent && (
        <section className="hero" onClick={() => go({ name: "reader", bookId: recent.id })}>
          <Cover book={recent} size="l" />
          <div className="hero-body">
            <span className="label">Continue reading</span>
            <h2>{recent.title}</h2>
            {recent.author && <p className="muted">{recent.author}</p>}
            <div className="hero-progress">
              <div className="progress-bar">
                <i style={{ transform: `scaleX(${recent.readFraction})` }} />
              </div>
              <span>{percent(recent.readFraction)} read</span>
            </div>
            <div className="hero-actions">
              <button className="btn primary">
                <BookOpen size={15} /> Continue
              </button>
              {recent.dueCards > 0 && (
                <button
                  className="btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    go({ name: "review", bookId: recent.id });
                  }}
                >
                  <GraduationCap size={15} /> {recent.dueCards} due
                </button>
              )}
              <button
                className="btn ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  go({ name: "map", bookId: recent.id });
                }}
              >
                <Waypoints size={15} /> {plural(recent.conceptCount, "concept")}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="shelf">
        {books.map((b) => (
          <BookCard key={b.id} book={b} onMenu={(book, at) => setMenu({ book, at })} />
        ))}
        <button className="book-add" onClick={add}>
          <Plus size={22} />
          <span>Add textbook</span>
        </button>
      </section>

      {menu && (
        <Popover anchor={menu.at} placement="below" onClose={() => setMenu(null)}>
          <div className="menu">
            <button className="menu-item" onClick={() => (setMenu(null), go({ name: "reader", bookId: menu.book.id }))}>
              <BookOpen size={15} /> Open
            </button>
            <button className="menu-item" onClick={() => (setMenu(null), go({ name: "review", bookId: menu.book.id }))}>
              <GraduationCap size={15} /> Review this book
            </button>
            <button className="menu-item" onClick={() => (setMenu(null), go({ name: "map", bookId: menu.book.id }))}>
              <Waypoints size={15} /> Knowledge map
            </button>
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => (setMenu(null), setRenaming(menu.book))}>
              <Pencil size={15} /> Rename
            </button>
            <button className="menu-item" onClick={() => (setMenu(null), void api.books.reveal(menu.book.id))}>
              <FolderOpen size={15} /> Show PDF
            </button>
            <div className="menu-sep" />
            <button className="menu-item danger" onClick={() => (setMenu(null), setRemoving(menu.book))}>
              <Trash2 size={15} /> Remove from library
            </button>
          </div>
        </Popover>
      )}
      {renaming && <RenameDialog book={renaming} onClose={() => setRenaming(null)} />}
      {removing && (
        <Modal onClose={() => setRemoving(null)} width={440}>
          <div className="dialog">
            <h3>Remove “{removing.title}”?</h3>
            <p className="muted">
              Its highlights, notes, sketches, cards and review history go with it. The original PDF on your disk is not touched.
            </p>
            <div className="dialog-actions">
              <button className="btn ghost" onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                style={{ background: "var(--bad)", borderColor: "var(--bad)" }}
                onClick={() => {
                  void api.books.remove(removing.id);
                  setRemoving(null);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RenameDialog({ book, onClose }: { book: Book; onClose(): void }) {
  const [title, setTitle] = useState(book.title);
  const save = () => {
    void api.books.rename(book.id, title).then(() => void useApp.getState().refreshBooks());
    onClose();
  };
  return (
    <Modal onClose={onClose} width={460}>
      <div className="dialog">
        <h3>Rename book</h3>
        <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
        <div className="dialog-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={!title.trim()}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
