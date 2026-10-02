/**
 * Making a flashcard from a passage. It starts as a cloze — the selection
 * blanked out of its sentence — because that is right more often than not,
 * and a model can write a better one on request.
 */
import { Layers, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import type { CardKind } from "../../../../shared/types";
import { api, errorText } from "../../api";
import { Modal } from "../../components/ui";
import { cardHtml } from "../../lib/markdown";
import { useApp } from "../../store";
import { displayText, useReader } from "./state";

function sentenceWith(text: string, quote: string): string | null {
  const at = text.indexOf(quote);
  if (at < 0) return null;
  const before = text.slice(0, at);
  const after = text.slice(at + quote.length);
  const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("? "), before.lastIndexOf("! "));
  const ends = [after.indexOf(". "), after.indexOf("? "), after.indexOf("! ")].filter((i) => i >= 0);
  const end = ends.length ? Math.min(...ends) + 1 : after.length;
  return `${before.slice(start >= 0 ? start + 2 : 0)}{{c1::${quote}}}${after.slice(0, end)}`.trim();
}

export function CardComposer({ draft, onClose }: { draft: { blockId: number | null; quote: string }; onClose(): void }) {
  const bookId = useReader((s) => s.bookId)!;
  const content = useReader((s) => s.content);
  const ai = useApp((s) => s.ai);
  const toast = useApp((s) => s.toast);
  const block = content?.blocks.find((b) => b.id === draft.blockId);
  const initial = useMemo(() => {
    const text = block ? displayText(block) : "";
    const s = draft.quote.length < 160 ? sentenceWith(text, draft.quote) : null;
    return s ? { kind: "cloze" as CardKind, front: s, back: "" } : { kind: "basic" as CardKind, front: "", back: draft.quote };
  }, [block, draft.quote]);
  const [kind, setKind] = useState<CardKind>(initial.kind);
  const [front, setFront] = useState(initial.front);
  const [back, setBack] = useState(initial.back);
  const [writing, setWriting] = useState(false);

  const valid = kind === "cloze" ? /\{\{c\d+::.+?\}\}/.test(front) : front.trim().length > 0 && back.trim().length > 0;

  const write = async () => {
    if (!draft.blockId) return;
    setWriting(true);
    try {
      const card = await api.ai.suggestCard({ bookId, blockId: draft.blockId, quote: draft.quote });
      setKind(card.kind);
      setFront(card.front);
      setBack(card.back);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setWriting(false);
    }
  };

  const save = async () => {
    try {
      await api.cards.create({ bookId, blockId: draft.blockId, kind, front: front.trim(), back: back.trim() });
      toast("Card added. It's in today's reviews.", "success");
      const c = useReader.getState().content;
      if (c) useReader.getState().set({ content: { ...c, cards: { ...c.cards, active: c.cards.active + 1 } } });
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  return (
    <Modal onClose={onClose} width={600}>
      <div className="composer">
        <div className="composer-head">
          <Layers size={16} />
          <h3>New card</h3>
          <span style={{ flex: 1 }} />
          <div className="segmented">
            <button className={kind === "cloze" ? "on" : ""} onClick={() => setKind("cloze")}>
              Fill in the blank
            </button>
            <button className={kind === "basic" ? "on" : ""} onClick={() => setKind("basic")}>
              Question
            </button>
          </div>
        </div>
        {kind === "cloze" ? (
          <>
            <label className="label">Text — wrap what to recall in {"{{c1::…}}"}</label>
            <textarea className="textarea" rows={4} value={front} onChange={(e) => setFront(e.target.value)} autoFocus />
            <label className="label">Extra (shown after)</label>
            <textarea className="textarea" rows={2} value={back} onChange={(e) => setBack(e.target.value)} />
          </>
        ) : (
          <>
            <label className="label">Question</label>
            <textarea className="textarea" rows={2} value={front} onChange={(e) => setFront(e.target.value)} autoFocus />
            <label className="label">Answer</label>
            <textarea className="textarea" rows={4} value={back} onChange={(e) => setBack(e.target.value)} />
          </>
        )}
        {valid && (
          <div className="composer-preview">
            <span className="label">Preview</span>
            <div className="answer" dangerouslySetInnerHTML={{ __html: cardHtml(front, kind, false) }} />
          </div>
        )}
        <div className="dialog-actions">
          {ai?.available && draft.blockId && (
            <button className="btn ghost" onClick={() => void write()} disabled={writing} style={{ marginRight: "auto" }}>
              {writing ? <span className="spinner" /> : <Sparkles size={14} />} {writing ? "Writing…" : "Write it with AI"}
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid} onClick={() => void save()}>
            Add card
          </button>
        </div>
      </div>
    </Modal>
  );
}
