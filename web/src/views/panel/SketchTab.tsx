/**
 * The drawing tab: a pad for working something out by hand beside the
 * text, saved as you draw. A sketch can be pinned to a place on a page,
 * which then shows it in that page's margin.
 */
import { ChevronLeft, PenLine, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Sketch, SketchData } from "../../../../shared/types";
import { api, errorText } from "../../api";
import { ago } from "../../lib/format";
import { useApp } from "../../store";
import { SketchPad } from "../sketch/SketchPad";
import { sketchToSvg } from "../sketch/render";
import { useReader } from "../reader/state";

const EMPTY: SketchData = { version: 1, strokes: [] };

export function SketchTab() {
  const bookId = useReader((s) => s.bookId)!;
  const request = useReader((s) => s.sketchRequest);
  const toast = useApp((s) => s.toast);
  const [list, setList] = useState<Sketch[] | null>(null);
  const [open, setOpen] = useState<Sketch | null>(null);
  const [title, setTitle] = useState("");
  const handled = useRef(0);
  // The sketch the pad is editing. Not cleared on close: the pad flushes
  // its last edit as it unmounts, after the panel has moved on.
  const current = useRef<Sketch | null>(null);
  if (open) current.current = open;

  const load = useCallback(() => void api.sketches.list(bookId).then(setList), [bookId]);
  useEffect(load, [load]);

  const start = useCallback(
    async (anchor: { page: number; y: number } | null) => {
      const day = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const t = anchor ? `Page ${anchor.page + 1} · ${day}` : `Sketch ${day}`;
      try {
        const s = await api.sketches.save({ bookId, page: anchor?.page ?? null, y: anchor?.y ?? null, title: t, data: EMPTY, svg: sketchToSvg(EMPTY) });
        // The margin of its page marks it.
        if (s.page !== null) {
          const r = useReader.getState();
          r.set({ pins: [...r.pins, { id: s.id, page: s.page, y: s.y ?? 60, title: s.title }] });
        }
        setOpen(s);
        setTitle(s.title);
        load();
      } catch (e) {
        toast(errorText(e), "error");
      }
    },
    [bookId, load, toast],
  );

  useEffect(() => {
    if (!request || request.seq === handled.current) return;
    handled.current = request.seq;
    if (request.sketchId) void api.sketches.get(request.sketchId).then((s) => (setOpen(s), setTitle(s.title)));
    else void start(request.anchor);
  }, [request, start]);

  const save = useCallback(
    (data: SketchData) => {
      const s = current.current;
      if (!s) return;
      const svg = sketchToSvg(data);
      void api.sketches
        .save({ id: s.id, bookId, page: s.page, y: s.y, title: title || s.title, data, svg })
        .then((saved) => {
          if (current.current?.id === saved.id) current.current = saved;
          // Thumbnails follow the drawing.
          load();
        })
        .catch((e) => toast(errorText(e), "error"));
    },
    [bookId, load, title, toast],
  );

  if (open) {
    return (
      <div className="sketch-tab">
        <div className="sketch-bar">
          <button className="icon-btn small" onClick={() => (setOpen(null), load())} aria-label="All sketches">
            <ChevronLeft size={15} />
          </button>
          <input
            className="sketch-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void api.sketches.save({ id: open.id, bookId, page: open.page, y: open.y, title, data: current.current?.data ?? open.data, svg: current.current?.svg ?? open.svg })}
          />
          <button
            className="icon-btn small"
            onClick={async () => {
              await api.sketches.remove(open.id);
              const r = useReader.getState();
              r.set({ pins: r.pins.filter((x) => x.id !== open.id) });
              setOpen(null);
              load();
            }}
            aria-label="Delete sketch"
          >
            <Trash2 size={14} />
          </button>
        </div>
        {open.page !== null && (
          <button className="sketch-anchor" onClick={() => useReader.getState().goTo(open.page!)}>
            Pinned to <span>page {open.page + 1}</span>
          </button>
        )}
        <div className="sketch-area">
          <SketchPad key={open.id} initial={open.data} onChange={save} />
        </div>
      </div>
    );
  }

  return (
    <div className="sketch-tab">
      <div className="cards-head">
        <div className="label">Sketches in this book</div>
        <button className="btn small primary" onClick={() => void start(null)}>
          <Plus size={13} /> New sketch
        </button>
      </div>
      {list && !list.length && (
        <div className="empty">
          <PenLine size={24} />
          <h3>Draw it out</h3>
          <p>Diagrams, derivations, mind maps — sketch beside the text. Select a passage and choose ⋯ → Sketch beside it to pin one to its page.</p>
        </div>
      )}
      <div className="sketch-grid">
        {list?.map((s) => (
          <button key={s.id} className="sketch-thumb" onClick={() => (setOpen(s), setTitle(s.title))}>
            <div className="sketch-thumb-art" dangerouslySetInnerHTML={{ __html: s.svg }} />
            <div className="sketch-thumb-title">{s.title || "Untitled"}</div>
            <div className="muted sketch-thumb-meta">{ago(s.updatedAt)}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
