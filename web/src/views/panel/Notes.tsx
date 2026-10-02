/**
 * Every highlight and note in the book, in reading order, filterable by
 * color and words, and exportable as Markdown.
 */
import { ClipboardCopy, Search, StickyNote } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { HighlightRow } from "../../../../shared/api";
import { HIGHLIGHT_COLORS, type HighlightColor } from "../../../../shared/types";
import { api } from "../../api";
import { useApp } from "../../store";
import { useReader } from "../reader/state";

export function Notes() {
  const bookId = useReader((s) => s.bookId)!;
  const book = useReader((s) => s.book);
  const content = useReader((s) => s.content);
  const toast = useApp((s) => s.toast);
  const [rows, setRows] = useState<HighlightRow[] | null>(null);
  const [color, setColor] = useState<HighlightColor | null>(null);
  const [q, setQ] = useState("");
  const [onlyNotes, setOnlyNotes] = useState(false);

  // The open chapter's highlights change under us; reload when they do.
  useEffect(() => {
    void api.highlights.list(bookId).then(setRows);
  }, [bookId, content?.highlights]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows ?? []).filter(
      (r) =>
        (!color || r.color === color) &&
        (!onlyNotes || r.note.trim()) &&
        (!needle || r.quote.toLowerCase().includes(needle) || r.note.toLowerCase().includes(needle)),
    );
  }, [rows, color, q, onlyNotes]);

  const groups = useMemo(() => {
    const g: Array<{ unit: string; rows: HighlightRow[] }> = [];
    for (const r of shown) {
      const last = g[g.length - 1];
      if (last && last.unit === r.unitTitle) last.rows.push(r);
      else g.push({ unit: r.unitTitle, rows: [r] });
    }
    return g;
  }, [shown]);

  const exportMd = () => {
    const lines = [`# ${book?.title ?? "Notes"}`, ""];
    for (const g of groups) {
      lines.push(`## ${g.unit}`, "");
      for (const r of g.rows) {
        lines.push(`> ${r.quote.replace(/\n/g, " ")}`, "");
        if (r.note.trim()) lines.push(r.note.trim(), "");
      }
    }
    void navigator.clipboard.writeText(lines.join("\n"));
    toast("Notes copied as Markdown.");
  };

  return (
    <div className="notes">
      <div className="notes-tools">
        <div className="notes-search">
          <Search size={14} />
          <input placeholder="Search highlights and notes" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="notes-filters">
          <button className={`swatch-all ${!color ? "on" : ""}`} onClick={() => setColor(null)}>
            All
          </button>
          {HIGHLIGHT_COLORS.map((c) => (
            <button key={c} className={`swatch sw-${c} ${color === c ? "on" : ""}`} onClick={() => setColor(color === c ? null : c)} aria-label={c} />
          ))}
          <span style={{ flex: 1 }} />
          <button className={`chip-btn ${onlyNotes ? "on" : ""}`} onClick={() => setOnlyNotes(!onlyNotes)}>
            With notes
          </button>
          <button className="icon-btn small" onClick={exportMd} title="Copy all as Markdown" aria-label="Copy as Markdown">
            <ClipboardCopy size={14} />
          </button>
        </div>
      </div>
      <div className="notes-list">
        {rows && !rows.length && (
          <div className="empty">
            <StickyNote size={24} />
            <h3>No highlights yet</h3>
            <p>Select text while reading to highlight it, or press N to add a note.</p>
          </div>
        )}
        {groups.map((g) => (
          <section key={g.unit + g.rows[0]!.id}>
            <div className="notes-unit label">{g.unit}</div>
            {g.rows.map((r) => (
              <article key={r.id} className={`note-card nc-${r.color}`} onClick={() => void useReader.getState().goToBlock(r.blockId)}>
                <p className="note-quote">{r.quote}</p>
                {r.note.trim() && <p className="note-text">{r.note}</p>}
              </article>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
