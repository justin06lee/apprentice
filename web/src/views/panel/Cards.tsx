/**
 * The open chapter's flashcards: waiting ones (until the chapter is read),
 * ones in rotation, and the way to write more — by hand or with a model.
 */
import { Check, GraduationCap, Layers, Pause, Pencil, Play, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Card } from "../../../../shared/types";
import { api, errorText, on } from "../../api";
import { cloze, plural } from "../../lib/format";
import { useApp } from "../../store";
import { useReader, useUnitId } from "../reader/state";

function CardRow({ card, onChanged }: { card: Card; onChanged(): void }) {
  const [editing, setEditing] = useState(false);
  const [front, setFront] = useState(card.front);
  const [back, setBack] = useState(card.back);
  const toast = useApp((s) => s.toast);
  const status = card.status === "pending" ? "waiting" : card.status === "suspended" ? "paused" : card.state === 0 ? "new" : "learning";
  if (editing) {
    return (
      <div className="card-row editing">
        <textarea className="textarea" rows={3} value={front} onChange={(e) => setFront(e.target.value)} />
        <textarea className="textarea" rows={2} value={back} onChange={(e) => setBack(e.target.value)} placeholder={card.kind === "cloze" ? "Extra (optional)" : "Answer"} />
        <div className="card-row-actions">
          <button className="btn small ghost" onClick={() => setEditing(false)}>
            <X size={13} /> Cancel
          </button>
          <button
            className="btn small primary"
            onClick={async () => {
              try {
                await api.cards.update(card.id, { front, back });
                setEditing(false);
                onChanged();
              } catch (e) {
                toast(errorText(e), "error");
              }
            }}
          >
            <Check size={13} /> Save
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="card-row">
      <div
        className="card-row-main"
        onClick={() => (card.blockId ? void useReader.getState().goToBlock(card.blockId) : card.page !== null && useReader.getState().goTo(card.page))}
      >
        <div className="card-front">{card.kind === "cloze" ? cloze(card.front, true) : card.front}</div>
        {card.kind === "basic" && <div className="card-back">{card.back}</div>}
        <div className="card-meta">
          <span className={`chip st-${status}`}>{status}</span>
          {card.source === "ai" && (
            <span className="chip">
              <Sparkles size={10} /> AI
            </span>
          )}
          {card.source === "auto" && <span className="chip">from the text</span>}
        </div>
      </div>
      <div className="card-row-tools">
        <button className="icon-btn small" onClick={() => setEditing(true)} aria-label="Edit card">
          <Pencil size={13} />
        </button>
        {card.status !== "pending" && (
          <button
            className="icon-btn small"
            onClick={() => void api.cards.update(card.id, { status: card.status === "suspended" ? "active" : "suspended" }).then(onChanged)}
            aria-label={card.status === "suspended" ? "Resume card" : "Pause card"}
            title={card.status === "suspended" ? "Resume" : "Pause (keep it out of reviews)"}
          >
            {card.status === "suspended" ? <Play size={13} /> : <Pause size={13} />}
          </button>
        )}
        <button className="icon-btn small" onClick={() => void api.cards.remove(card.id).then(onChanged)} aria-label="Delete card">
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

export function Cards() {
  const bookId = useReader((s) => s.bookId)!;
  const unitId = useUnitId();
  const units = useReader((s) => s.units);
  const ai = useApp((s) => s.ai);
  const jobs = useApp((s) => s.jobs);
  const go = useApp((s) => s.go);
  const toast = useApp((s) => s.toast);
  const books = useApp((s) => s.books);
  const [cards, setCards] = useState<Card[] | null>(null);

  const load = () => {
    if (unitId) void api.cards.list(bookId, unitId).then(setCards);
  };
  useEffect(load, [bookId, unitId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => on("cards.changed", (e) => e.bookId === bookId && load()), [bookId, unitId]); // eslint-disable-line react-hooks/exhaustive-deps

  const unit = units.find((u) => u.id === unitId);
  const writing = jobs.some((j) => j.state === "running" && j.bookId === bookId && j.label.startsWith("Writing cards") && unit && j.label.includes(unit.title));
  const due = books.find((b) => b.id === bookId)?.dueCards ?? 0;
  const pending = cards?.filter((c) => c.status === "pending").length ?? 0;

  return (
    <div className="cards-tab">
      <div className="cards-head">
        <div>
          <div className="label">This chapter</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
            {cards ? plural(cards.length, "card") : "…"}
            {pending ? ` · ${pending} waiting until it's read` : ""}
          </div>
        </div>
        {due > 0 && (
          <button className="btn small primary" onClick={() => go({ name: "review", bookId })}>
            <GraduationCap size={13} /> Review {due}
          </button>
        )}
      </div>
      <div className="cards-actions">
        <button className="btn small" onClick={() => useReader.getState().set({ cardDraft: { page: useReader.getState().visible[0] ?? null, quote: "", context: "" } })}>
          <Plus size={13} /> New card
        </button>
        {ai?.available && unitId && (
          <button
            className="btn small"
            disabled={writing}
            onClick={async () => {
              try {
                await api.ai.generateCards(bookId, unitId);
                toast("Writing cards for this chapter in the background…");
              } catch (e) {
                toast(errorText(e), "error");
              }
            }}
          >
            {writing ? <span className="spinner" /> : <Sparkles size={13} />} {writing ? "Writing cards…" : "Write cards with AI"}
          </button>
        )}
      </div>
      <div className="cards-list">
        {cards && !cards.length && (
          <div className="empty">
            <Layers size={24} />
            <h3>No cards for this chapter</h3>
            <p>Select a passage and choose Card, or let a model write a set when you finish reading.</p>
          </div>
        )}
        {cards?.map((c) => <CardRow key={c.id} card={c} onChanged={load} />)}
      </div>
    </div>
  );
}
