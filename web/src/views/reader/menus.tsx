/**
 * The reader's floating menus: on a selection, on a highlight, on a
 * passage's gutter button, and the peek at a footnote.
 */
import { Copy, FileText, Layers, MessageCircle, Pencil, PenLine, RotateCcw, Sparkles, StickyNote, Trash2, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { HIGHLIGHT_COLORS, type Block, type Highlight, type HighlightColor } from "../../../../shared/types";
import { Popover, type Anchor } from "../../components/ui";
import type { SelectionInfo } from "../../lib/selection";
import { useApp } from "../../store";
import { displayText, useReader } from "./state";

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

export function SelectionMenu({ sel, onClose }: { sel: SelectionInfo; onClose(): void }) {
  const r = useReader.getState();
  const anchor = { x: sel.rect.left + sel.rect.width / 2, y: sel.rect.top, h: sel.rect.height };
  const blockIds = [...new Set(sel.ranges.map((x) => x.blockId))];
  const done = () => {
    window.getSelection()?.removeAllRanges();
    onClose();
  };
  const highlight = async (color: HighlightColor, note = false) => {
    const made = await r.addHighlights(sel.ranges, sel.quote, color);
    done();
    if (note && made[0]) {
      // Reopen on the new highlight with its note field ready.
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-hl="${made[0]!.id}"]`);
        el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".hl-note")?.focus());
      });
    }
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "h") void highlight("yellow");
      else if (e.key === "n") void highlight("yellow", true);
      else if (e.key === "a") {
        r.ask(sel.quote, blockIds);
        done();
      } else if (e.key === "c") {
        r.set({ cardDraft: { blockId: blockIds[0] ?? null, quote: sel.quote } });
        done();
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  return (
    <Popover anchor={anchor} onClose={onClose} className="selmenu">
      <Swatches onPick={(c) => void highlight(c)} />
      <span className="selmenu-sep" />
      <button className="selmenu-btn" onClick={() => void highlight("yellow", true)} title="Highlight with a note  (N)">
        <StickyNote size={15} /> Note
      </button>
      <button
        className="selmenu-btn"
        onClick={() => {
          r.ask(sel.quote, blockIds);
          done();
        }}
        title="Ask about this  (A)"
      >
        <MessageCircle size={15} /> Ask
      </button>
      <button
        className="selmenu-btn"
        onClick={() => {
          r.ask(sel.quote, blockIds, "Explain this passage in plain terms. What is it saying, and why does it matter here?");
          done();
        }}
        title="Explain this"
      >
        <Sparkles size={15} /> Explain
      </button>
      <button
        className="selmenu-btn"
        onClick={() => {
          r.set({ cardDraft: { blockId: blockIds[0] ?? null, quote: sel.quote } });
          done();
        }}
        title="Make a flashcard  (C)"
      >
        <Layers size={15} /> Card
      </button>
      <button className="selmenu-btn icon" onClick={() => (copy(sel.quote), done())} title="Copy">
        <Copy size={15} />
      </button>
    </Popover>
  );
}

export function HighlightMenu({ highlight, anchor, focusNote, onClose }: { highlight: Highlight; anchor: Anchor; focusNote: boolean; onClose(): void }) {
  const r = useReader.getState();
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
        <button className="icon-btn small" title="Ask about this" onClick={() => (r.ask(highlight.quote, [highlight.blockId]), onClose())}>
          <MessageCircle size={15} />
        </button>
        <button className="icon-btn small" title="Make a card" onClick={() => (r.set({ cardDraft: { blockId: highlight.blockId, quote: highlight.quote } }), onClose())}>
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

export function BlockMenu({ block, anchor, onClose }: { block: Block; anchor: Anchor; onClose(): void }) {
  const r = useReader.getState();
  const ai = useApp((s) => s.ai);
  const text = displayText(block);
  const isText = !["figure", "equation", "table"].includes(block.type);
  const item = (icon: React.ReactNode, label: string, run: () => void, hint?: string, disabled = false) => (
    <button
      className="menu-item"
      disabled={disabled}
      style={disabled ? { opacity: 0.45 } : undefined}
      onClick={() => {
        onClose();
        run();
      }}
    >
      {icon} {label} {hint && <span className="hint">{hint}</span>}
    </button>
  );
  const what = block.type === "figure" ? "this figure" : block.type === "equation" ? "this equation" : block.type === "table" ? "this table" : "this passage";
  return (
    <Popover anchor={anchor} onClose={onClose} placement="below">
      <div className="menu">
        {item(<MessageCircle size={15} />, `Ask about ${what}`, () => r.ask(text.slice(0, 1200), [block.id]))}
        {item(<Sparkles size={15} />, "Explain it simply", () =>
          r.ask(text.slice(0, 1200), [block.id], `Explain ${what} simply, step by step. Assume I understand what came before it in the book.`),
        )}
        {isText &&
          item(
            <Wand2 size={15} />,
            "Rewrite it for me…",
            () => r.set({ rewrite: { blockId: block.id, streamId: null, text: "", state: "idle", instruction: "", threadId: null } }),
            ai?.available ? undefined : "needs a model",
            !ai?.available,
          )}
        {isText && item(<Pencil size={15} />, block.custom ? "Edit my version" : "Edit the text", () => r.set({ editing: block.id }))}
        {block.custom && item(<RotateCcw size={15} />, "Restore the book's text", () => void r.saveBlock(block.id, null))}
        <div className="menu-sep" />
        {item(<Layers size={15} />, "Make a card", () => r.set({ cardDraft: { blockId: block.id, quote: text.slice(0, 600) } }))}
        {item(<PenLine size={15} />, "Sketch beside it", () => r.sketch(block.id))}
        {item(<FileText size={15} />, "Show on the page", () => r.set({ pageView: true, pageTarget: block.page }), `p. ${block.page + 1}`)}
        {item(<Copy size={15} />, "Copy text", () => copy(text))}
      </div>
    </Popover>
  );
}

export function FootnotePeek({ block, anchor, onClose }: { block: Block; anchor: Anchor; onClose(): void }) {
  return (
    <Popover anchor={anchor} onClose={onClose} className="fnpeek">
      <div className="fnpeek-body">
        <span className="fn-label">{block.label}</span>
        <p>{displayText(block)}</p>
      </div>
      <button
        className="btn small ghost"
        onClick={() => {
          onClose();
          void useReader.getState().goToBlock(block.id);
        }}
      >
        Go to note
      </button>
    </Popover>
  );
}
