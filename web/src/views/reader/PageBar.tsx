/**
 * The strip under the book: which chapter this is and how far into it, a
 * scrubber over the whole book — chapters ticked, pages read shaded — and
 * the page number, which takes a page to go to.
 */
import { Check, CircleCheck } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "../../api";
import { plural } from "../../lib/format";
import { useApp } from "../../store";
import { unitAtPage, unitPages, useReader } from "./state";

const UNIT_DONE = 0.85;

export function PageBar({ visible }: { visible: number[] }) {
  const bookId = useReader((s) => s.bookId)!;
  const units = useReader((s) => s.units);
  const count = useReader((s) => s.sizes.length);
  const read = useReader((s) => s.read);
  const toast = useApp((s) => s.toast);
  const first = visible[0] ?? 0;
  const last = visible[visible.length - 1] ?? first;
  const unit = unitAtPage(units, last);
  const [hover, setHover] = useState<number | null>(null);
  const [typing, setTyping] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  const ticks = useMemo(() => {
    const seen = new Set<number>();
    return units.filter((u) => u.kind === "body" && !seen.has(u.page) && seen.add(u.page)).map((u) => u.page);
  }, [units]);

  // Pages read, painted once per change rather than as a thousand elements.
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c || !count) return;
    const w = c.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.round(4 * dpr);
    const g = c.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = getComputedStyle(c).color;
    for (const p of read) g.fillRect(Math.floor((p / count) * c.width), 0, Math.max(1, Math.ceil(c.width / count)), c.height);
  }, [read, count]);

  const pageAt = (clientX: number) => {
    const b = track.current!.getBoundingClientRect();
    return Math.max(0, Math.min(count - 1, Math.floor(((clientX - b.left) / b.width) * count)));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setHover(pageAt(e.clientX));
    const move = (ev: PointerEvent) => setHover(pageAt(ev.clientX));
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setHover(null);
      useReader.getState().goTo(pageAt(ev.clientX));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const range = unit ? unitPages(units, unit.id, count) : null;
  const unitRead = (unit?.readFraction ?? 0) >= UNIT_DONE;
  const hoverUnit = hover === null ? null : unitAtPage(units, hover);

  return (
    <div className="pagebar">
      <div className="pagebar-unit">
        {unit && (
          <>
            <span className="pagebar-title" title={unit.title}>
              {unit.title}
            </span>
            {range && range[1] > range[0] && (
              <span className="muted pagebar-of">
                {Math.min(range[1] - range[0] + 1, Math.max(1, last - range[0] + 1))} of {range[1] - range[0] + 1}
              </span>
            )}
            {unit.kind === "body" &&
              (unitRead ? (
                <span className="chip good" title="Chapter read">
                  <CircleCheck size={12} />
                </span>
              ) : (
                <button
                  className="btn small ghost"
                  title="Count this chapter as read: its cards join your reviews"
                  onClick={async () => {
                    try {
                      const r = await api.reader.markUnit(bookId, unit.id, true);
                      useReader.getState().applyRead(r, range ? Array.from({ length: range[1] - range[0] + 1 }, (_, i) => range[0] + i) : []);
                      if (r.unlocked) toast(`${plural(r.unlocked, "card")} added to your reviews.`, "success");
                    } catch (e) {
                      toast(errorText(e), "error");
                    }
                  }}
                >
                  <Check size={13} /> Mark read
                </button>
              ))}
          </>
        )}
      </div>
      <div className="scrub" ref={track} onPointerDown={onPointerDown} onPointerMove={(e) => !e.buttons && setHover(pageAt(e.clientX))} onPointerLeave={(e) => !e.buttons && setHover(null)}>
        <div className="scrub-track">
          <canvas ref={canvas} className="scrub-read" />
          {ticks.map((p) => (
            <span key={p} className="scrub-tick" style={{ left: `${(p / count) * 100}%` }} />
          ))}
          <span className="scrub-thumb" style={{ left: `${(first / count) * 100}%`, width: `max(4px, ${((last - first + 1) / count) * 100}%)` }} />
        </div>
        {hover !== null && (
          <div className="scrub-tip" style={{ left: `${(hover / count) * 100}%` }}>
            <strong>{hover + 1}</strong>
            {hoverUnit && <span>{hoverUnit.title}</span>}
          </div>
        )}
      </div>
      <div className="pagebar-page">
        {typing ? (
          <GoToPage count={count} onDone={() => setTyping(false)} />
        ) : (
          <button className="pagebar-num" onClick={() => setTyping(true)} title="Go to a page">
            {first === last ? first + 1 : `${first + 1}–${last + 1}`} <span className="muted">/ {count}</span>
          </button>
        )}
      </div>
    </div>
  );
}

function GoToPage({ count, onDone }: { count: number; onDone(): void }) {
  const [v, setV] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <input
      ref={ref}
      className="pagebar-input"
      inputMode="numeric"
      placeholder={`1–${count}`}
      value={v}
      onChange={(e) => setV(e.target.value.replace(/\D/g, ""))}
      onBlur={onDone}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const n = Number(v);
          if (n >= 1) useReader.getState().goTo(Math.min(count, n) - 1);
          onDone();
        } else if (e.key === "Escape") onDone();
      }}
    />
  );
}
