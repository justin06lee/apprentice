/**
 * Reviewing cards: one at a time, the answer on Space, a rating on 1–4
 * with FSRS's next interval shown on each. Cards that come due again within
 * the session (a lapse, a learning step) come back before it ends.
 */
import { BookOpen, CircleCheck, GraduationCap, Pencil, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CardStats, CardWithContext, Rating } from "../../../../shared/types";
import { api, errorText, on } from "../../api";
import { percent, plural } from "../../lib/format";
import { cardHtml, renderMarkdown } from "../../lib/markdown";
import { useApp } from "../../store";
import "../../styles/review.css";

const RATINGS: Array<[Rating, string, string]> = [
  [1, "Again", "again"],
  [2, "Hard", "hard"],
  [3, "Good", "good"],
  [4, "Easy", "easy"],
];

function Forecast({ counts }: { counts: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...counts);
  const W = 14 * 22;
  const H = 72;
  const day = (i: number) => (i === 0 ? "Today" : i === 1 ? "Tomorrow" : new Date(Date.now() + i * 86400000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }));
  return (
    <figure className="forecast">
      <figcaption className="label">Due over the next two weeks</figcaption>
      <div className="forecast-plot" onMouseLeave={() => setHover(null)}>
        <svg width={W} height={H + 18} viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label={`Cards due per day: ${counts.join(", ")}`}>
          <line x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} stroke="var(--line)" />
          {counts.map((c, i) => {
            const h = c ? Math.max(4, (c / max) * (H - 6)) : 0;
            const x = i * 22 + 1;
            return (
              <g key={i} onMouseEnter={() => setHover(i)}>
                {/* Hit target taller and wider than the bar. */}
                <rect x={x - 1} y={0} width={22} height={H} fill="transparent" />
                {h > 0 && <path d={`M${x} ${H} V${H - h + 4} q0 -4 4 -4 h12 q4 0 4 4 V${H} Z`} fill="var(--accent)" opacity={hover === null || hover === i ? 1 : 0.45} />}
              </g>
            );
          })}
          {[0, 7, 13].map((i) => (
            <text key={i} x={i * 22 + 11} y={H + 14} textAnchor="middle" fontSize="10.5" fill="var(--ink-3)">
              {i === 0 ? "today" : `+${i}d`}
            </text>
          ))}
        </svg>
        {hover !== null && (
          <div className="forecast-tip" style={{ left: hover * 22 + 11 }}>
            <strong>{counts[hover]}</strong> due · {day(hover)}
          </div>
        )}
      </div>
    </figure>
  );
}

export function Review({ bookId }: { bookId: string | null }) {
  const books = useApp((s) => s.books);
  const go = useApp((s) => s.go);
  const toast = useApp((s) => s.toast);
  const [scope, setScope] = useState<string | null>(bookId);
  const [queue, setQueue] = useState<CardWithContext[] | null>(null);
  const [stats, setStats] = useState<CardStats | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);
  const [history, setHistory] = useState<Array<{ card: CardWithContext; rating: Rating }>>([]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(Date.now());
  const total = useRef(0);

  const load = useCallback(async () => {
    const [q, s] = await Promise.all([api.cards.queue(scope, 300), api.cards.stats(scope)]);
    setQueue(q.cards);
    setStats(s);
    total.current = q.cards.length;
    setDone(0);
    setRevealed(false);
    shownAt.current = Date.now();
  }, [scope]);
  useEffect(() => void load(), [load]);
  // New cards unlocked elsewhere: pick them up if the session is over.
  useEffect(() => on("cards.changed", () => queue?.length === 0 && void load()), [queue?.length, load]);

  const card = queue?.[0] ?? null;

  const rate = useCallback(
    async (rating: Rating) => {
      if (!card || busy) return;
      setBusy(true);
      try {
        const updated = await api.cards.review(card.id, rating, Date.now() - shownAt.current);
        setHistory((h) => [...h.slice(-50), { card, rating }]);
        setQueue((q) => {
          const rest = (q ?? []).slice(1);
          // Due again within the session: back of the line, refreshed.
          if (updated.status === "active" && updated.due - Date.now() < 20 * 60_000) {
            void api.cards.queue(scope, 300).then((fresh) => {
              const again = fresh.cards.find((c) => c.id === card.id);
              if (again) setQueue((cur) => (cur && !cur.some((c) => c.id === again.id) ? [...cur, again] : cur));
            });
          }
          return rest;
        });
        setDone((d) => d + 1);
        setRevealed(false);
        shownAt.current = Date.now();
      } catch (e) {
        toast(errorText(e), "error");
      } finally {
        setBusy(false);
      }
    },
    [busy, card, scope, toast],
  );

  const undo = useCallback(async () => {
    const last = history[history.length - 1];
    if (!last) return;
    await api.cards.undo(last.card.id);
    setHistory((h) => h.slice(0, -1));
    setQueue((q) => [last.card, ...(q ?? []).filter((c) => c.id !== last.card.id)]);
    setDone((d) => Math.max(0, d - 1));
    setRevealed(true);
  }, [history]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (editing || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "z") {
          e.preventDefault();
          void undo();
        }
        return;
      }
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!revealed) setRevealed(true);
        else void rate(3);
      } else if (revealed && ["1", "2", "3", "4"].includes(e.key)) void rate(Number(e.key) as Rating);
      else if (e.key === "z" || e.key === "u") void undo();
      else if (e.key === "e" && card) setEditing(true);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [card, editing, rate, revealed, undo]);

  const front = useMemo(() => (card ? cardHtml(card.front, card.kind, false) : ""), [card]);
  const answer = useMemo(() => (card ? cardHtml(card.front, card.kind, true) : ""), [card]);
  const back = useMemo(() => (card?.back ? renderMarkdown(card.back) : ""), [card]);

  const readyBooks = books.filter((b) => b.status === "ready");
  const remaining = queue?.length ?? 0;
  const progress = total.current ? done / Math.max(total.current, done + remaining) : 0;

  return (
    <div className="review">
      <header className="review-head">
        <div>
          <h1>Review</h1>
          {stats && (
            <p className="muted">
              {plural(stats.due + stats.newCards, "card")} to go
              {stats.reviewedToday ? ` · ${stats.reviewedToday} reviewed today` : ""}
              {stats.retention !== null ? ` · ${percent(stats.retention)} predicted recall` : ""}
              {stats.pending ? ` · ${stats.pending} waiting on unread chapters` : ""}
            </p>
          )}
        </div>
        <select className="input review-scope" value={scope ?? ""} onChange={(e) => setScope(e.target.value || null)}>
          <option value="">All books</option>
          {readyBooks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </select>
      </header>

      <div className="review-progress">
        <div className="progress-bar">
          <i style={{ transform: `scaleX(${progress})` }} />
        </div>
      </div>

      <div className="stage">
        {queue === null ? null : card ? (
          editing ? (
            <EditCard
              card={card}
              onDone={(front, back) => {
                setEditing(false);
                if (front !== null) setQueue((q) => (q ? [{ ...card, front, back: back ?? card.back }, ...q.slice(1)] : q));
              }}
            />
          ) : (
            <article className={`flash-card ${revealed ? "revealed" : ""}`} key={card.id} onClick={() => !revealed && setRevealed(true)}>
              <div className="fc-source">
                <span>{card.bookTitle}</span>
                {card.unitTitle && <span className="muted"> · {card.unitTitle}</span>}
                {card.state === 0 && <span className="chip accent fc-new">new</span>}
              </div>
              <div className="fc-front answer" dangerouslySetInnerHTML={{ __html: revealed && card.kind === "cloze" ? answer : front }} />
              {revealed && (card.kind === "basic" || back) && (
                <>
                  <hr className="fc-rule" />
                  <div className="fc-back answer" dangerouslySetInnerHTML={{ __html: back }} />
                </>
              )}
              {!revealed && (
                <div className="fc-hint muted">
                  <span className="kbd">Space</span> to show the answer
                </div>
              )}
            </article>
          )
        ) : (
          <div className="caught-up">
            <CircleCheck size={34} />
            <h2>{done ? "Session done" : "Nothing due"}</h2>
            <p className="muted">
              {done ? `You reviewed ${plural(done, "card")}. ` : ""}
              {stats?.pending
                ? `${plural(stats.pending, "card")} will join as you finish their chapters.`
                : stats?.total
                  ? "Come back when the next ones are due."
                  : "Cards appear as you read: highlight a passage and make one, or finish a chapter to unlock its cards."}
            </p>
            {stats && stats.forecast.some((n) => n > 0) && <Forecast counts={stats.forecast} />}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" onClick={() => go({ name: "library" })}>
                <BookOpen size={15} /> Back to reading
              </button>
              {history.length > 0 && (
                <button className="btn ghost" onClick={() => void undo()}>
                  <Undo2 size={15} /> Undo last
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {card && !editing && (
        <footer className="review-foot">
          {revealed ? (
            <div className="ratings">
              {RATINGS.map(([r, label, cls]) => (
                <button key={r} className={`rating r-${cls}`} onClick={() => void rate(r)} disabled={busy}>
                  <span className="rating-label">{label}</span>
                  <span className="rating-when">{card.preview[r].label}</span>
                  <span className="kbd">{r}</span>
                </button>
              ))}
            </div>
          ) : (
            <button className="btn large primary show-btn" onClick={() => setRevealed(true)}>
              Show answer
            </button>
          )}
          <div className="review-tools">
            <button className="btn small ghost" onClick={() => void undo()} disabled={!history.length} title="Undo  Z">
              <Undo2 size={13} /> Undo
            </button>
            <button className="btn small ghost" onClick={() => setEditing(true)} title="Edit  E">
              <Pencil size={13} /> Edit
            </button>
            {(card.blockId || card.page !== null) && (
              <button
                className="btn small ghost"
                onClick={() => go({ name: "reader", bookId: card.bookId, ...(card.blockId ? { blockId: card.blockId } : { page: card.page! }) })}
              >
                <GraduationCap size={13} /> See it in the book
              </button>
            )}
            <span className="muted review-left">{plural(remaining, "card")} left</span>
          </div>
        </footer>
      )}
    </div>
  );
}

function EditCard({ card, onDone }: { card: CardWithContext; onDone(front: string | null, back?: string): void }) {
  const [front, setFront] = useState(card.front);
  const [back, setBack] = useState(card.back);
  const toast = useApp((s) => s.toast);
  return (
    <div className="flash-card editing">
      <label className="label">{card.kind === "cloze" ? "Text (with {{c1::…}})" : "Question"}</label>
      <textarea className="textarea" rows={4} value={front} onChange={(e) => setFront(e.target.value)} autoFocus />
      <label className="label">{card.kind === "cloze" ? "Extra" : "Answer"}</label>
      <textarea className="textarea" rows={4} value={back} onChange={(e) => setBack(e.target.value)} />
      <div className="dialog-actions">
        <button className="btn ghost" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button
          className="btn primary"
          onClick={async () => {
            try {
              await api.cards.update(card.id, { front, back });
              onDone(front, back);
            } catch (e) {
              toast(errorText(e), "error");
            }
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
