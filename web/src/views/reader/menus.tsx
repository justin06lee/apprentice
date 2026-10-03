/**
 * The reader's floating menus: on a selection, on a highlight, and on a
 * region boxed on the page.
 */
import { Copy, Ellipsis, Layers, MessageCircle, PenLine, Sparkles, StickyNote, Trash2, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cleanText, paragraphAt, rangeInRect } from "../../../../shared/pages";
import { HIGHLIGHT_COLORS, type Highlight, type HighlightColor, type Passage } from "../../../../shared/types";
import { Popover, type Anchor } from "../../components/ui";
import { pageTextNow } from "../../lib/pages";
import { useApp } from "../../store";
import { bench } from "./Slip";
import { useReader, type Region, type Selection } from "./state";

const COLOR_NAMES: Record<HighlightColor, string> = { yellow: "Yellow", green: "Green", blue: "Blue", pink: "Pink", purple: "Purple" };

function Swatches({ value, onPick }: { value?: HighlightColor; onPick(c: HighlightColor): void }) {
  return (
    <div className="swatches">
      {HIGHLIGHT_COLORS.map((c, i) => (
        <button
          key={c}
          className={`swatch sw-${c} ${value === c ? "on" : ""}`}
          onClick={() => onPick(c)}
          title={`${COLOR_NAMES[c]} highlight${i === 0 ? "  (H)" : ""}`}
          aria-label={`${COLOR_NAMES[c]} highlight`}
        />
      ))}
    </div>
  );
}

function copy(text: string) {
  void navigator.clipboard.writeText(text);
  useApp.getState().toast("Copied.");
}

/** The paragraph a passage sits in, as prose: what a card is written from. */
function paragraphOf(bookId: string, p: Passage): string {
  const pt = pageTextNow(bookId, p.page);
  if (!pt) return p.quote;
  const [a] = paragraphAt(pt, p.start);
  const [, b] = paragraphAt(pt, Math.max(p.start, p.end - 1));
  return cleanText(pt.text.slice(a, b));
}

export function SelectionMenu({
  sel,
  anchor,
  onClose,
  onNote,
}: {
  sel: Selection;
  anchor: Anchor;
  onClose(clear: boolean): void;
  /** A highlight was made to hang a note on: open it. */
  onNote(h: Highlight): void;
}) {
  const r = useReader.getState();
  const bookId = useReader((s) => s.bookId)!;
  const ai = useApp((s) => s.ai);
  const [more, setMore] = useState(false);
  const first = sel.parts[0]!;
  // A question about a passage that runs over the page names all of it.
  const passage: Passage = { ...first, quote: sel.quote };
  const onePage = sel.parts.length === 1;
  const done = () => onClose(true);
  const highlight = async (color: HighlightColor, note = false) => {
    const made = await r.addHighlights(sel, color);
    done();
    if (note && made[0]) onNote(made[0]);
  };
  const card = () => r.set({ cardDraft: { page: first.page, quote: sel.quote, context: paragraphOf(bookId, first) } });

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "h") void highlight("yellow");
      else if (e.key === "n") void highlight("yellow", true);
      else if (e.key === "a") (r.ask(passage), done());
      else if (e.key === "c") (card(), done());
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  if (more) {
    const item = (icon: React.ReactNode, label: string, run: () => void, hint?: string, disabled = false) => (
      <button
        className="menu-item"
        disabled={disabled}
        style={disabled ? { opacity: 0.45 } : undefined}
        onClick={() => {
          run();
          done();
        }}
      >
        {icon} {label} {hint && <span className="hint">{hint}</span>}
      </button>
    );
    return (
      <Popover anchor={anchor} onClose={() => onClose(false)} placement="below">
        <div className="menu">
          {item(
            <Wand2 size={15} />,
            "Rewrite it for me…",
            () => r.set({ slip: bench(first, "rewrite") }),
            !onePage ? "one page at a time" : ai?.available ? undefined : "needs a model",
            !onePage || !ai?.available,
          )}
          {item(<PenLine size={15} />, "Write it my way…", () => r.set({ slip: bench(first, "edit") }), onePage ? undefined : "one page at a time", !onePage)}
          <div className="menu-sep" />
          {item(<PenLine size={15} />, "Sketch beside it", () => {
            const pt = pageTextNow(bookId, first.page);
            const line = pt?.lines.find((l) => l.s + l.xs.length - 1 >= first.start);
            r.sketch({ page: first.page, y: line?.y0 ?? 60 });
          })}
          {item(<Copy size={15} />, "Copy", () => copy(sel.quote))}
        </div>
      </Popover>
    );
  }

  return (
    <Popover anchor={anchor} onClose={() => onClose(false)} className="selmenu">
      <Swatches onPick={(c) => void highlight(c)} />
      <span className="selmenu-sep" />
      <button className="selmenu-btn" onClick={() => void highlight("yellow", true)} title="Highlight with a note  (N)">
        <StickyNote size={15} /> Note
      </button>
      <button className="selmenu-btn" onClick={() => (r.ask(passage), done())} title="Ask about this  (A)">
        <MessageCircle size={15} /> Ask
      </button>
      <button
        className="selmenu-btn"
        onClick={() => (r.ask(passage, null, "Explain this passage in plain terms. What is it saying, and why does it matter here?"), done())}
        title="Explain this"
      >
        <Sparkles size={15} /> Explain
      </button>
      <button className="selmenu-btn" onClick={() => (card(), done())} title="Make a flashcard  (C)">
        <Layers size={15} /> Card
      </button>
      <button className="selmenu-btn icon" onClick={() => setMore(true)} title="Rewrite, write your own, sketch, copy">
        <Ellipsis size={15} />
      </button>
    </Popover>
  );
}

export function HighlightMenu({ highlight, anchor, focusNote, onClose }: { highlight: Highlight; anchor: Anchor; focusNote: boolean; onClose(): void }) {
  const r = useReader.getState();
  const bookId = useReader((s) => s.bookId)!;
  const [note, setNote] = useState(highlight.note);
  const ref = useRef<HTMLTextAreaElement>(null);
  const saved = useRef(highlight.note);
  useEffect(() => {
    if (focusNote) ref.current?.focus();
  }, [focusNote]);
  const save = () => {
    if (note !== saved.current) {
      saved.current = note;
      void r.updateHighlight(highlight.id, { note });
    }
  };
  useEffect(() => () => save()); // save on close
  return (
    <Popover anchor={anchor} onClose={onClose} className="hlmenu">
      <div className="hlmenu-row">
        <Swatches value={highlight.color} onPick={(c) => void r.updateHighlight(highlight.id, { color: c })} />
        <span style={{ flex: 1 }} />
        <button className="icon-btn small" title="Ask about this" onClick={() => (r.ask(highlight), onClose())}>
          <MessageCircle size={15} />
        </button>
        <button
          className="icon-btn small"
          title="Make a card"
          onClick={() => (r.set({ cardDraft: { page: highlight.page, quote: highlight.quote, context: paragraphOf(bookId, highlight) } }), onClose())}
        >
          <Layers size={15} />
        </button>
        <button className="icon-btn small" title="Copy" onClick={() => copy(highlight.quote)}>
          <Copy size={15} />
        </button>
        <button className="icon-btn small" title="Remove highlight" onClick={() => (void r.removeHighlight(highlight.id), onClose())}>
          <Trash2 size={15} />
        </button>
      </div>
      <textarea
        ref={ref}
        className="hl-note"
        placeholder="Add a note…"
        value={note}
        rows={Math.min(8, Math.max(2, note.split("\n").length + 1))}
        onChange={(e) => setNote(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            save();
            onClose();
          }
        }}
      />
    </Popover>
  );
}

export function RegionMenu({ region, anchor, onClose }: { region: Region; anchor: Anchor; onClose(): void }) {
  const r = useReader.getState();
  const bookId = useReader((s) => s.bookId)!;
  const pt = pageTextNow(bookId, region.page);
  const range = pt ? rangeInRect(pt, region.rect) : null;
  const text = pt && range ? cleanText(pt.text.slice(range[0], range[1])) : "";
  const item = (icon: React.ReactNode, label: string, run: () => void) => (
    <button
      className="menu-item"
      onClick={() => {
        run();
        onClose();
      }}
    >
      {icon} {label}
    </button>
  );
  return (
    <Popover anchor={anchor} onClose={onClose} placement="below">
      <div className="menu">
        {item(<MessageCircle size={15} />, "Ask about this", () => r.ask(null, region))}
        {item(<Sparkles size={15} />, "Explain it", () =>
          r.ask(null, region, "Explain what this shows, step by step. Assume I understand what came before it in the book."),
        )}
        {item(<Layers size={15} />, "Make a card", () => r.set({ cardDraft: { page: region.page, quote: text, context: text } }))}
        {item(<PenLine size={15} />, "Sketch beside it", () => r.sketch({ page: region.page, y: region.rect[1] }))}
        {text && item(<Copy size={15} />, "Copy its text", () => copy(text))}
      </div>
    </Popover>
  );
}
