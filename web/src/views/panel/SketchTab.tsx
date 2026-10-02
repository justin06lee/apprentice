/**
 * The drawing tab: a pad for working something out by hand beside the
 * text, saved as you draw. A sketch can be pinned to a passage, which then
 * shows it in the margin of the chapter.
 */
import { ChevronLeft, PenLine, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Sketch, SketchData } from "../../../../shared/types";
import { api, errorText } from "../../api";
import { ago } from "../../lib/format";
import { useApp } from "../../store";
import { SketchPad } from "../sketch/SketchPad";
import { sketchToSvg } from "../sketch/render";
import { displayText, useReader } from "../reader/state";

const EMPTY: SketchData = { version: 1, strokes: [] };

export function SketchTab() {
  const bookId = useReader((s) => s.bookId)!;
  const unitId = useReader((s) => s.unitId);
  const content = useReader((s) => s.content);
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
    async (blockId: number | null) => {
      const block = content?.blocks.find((b) => b.id === blockId);
      const t = block ? displayText(block).slice(0, 60) : `Sketch ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
      try {
        const s = await api.sketches.save({ bookId, blockId, unitId, title: t, data: EMPTY, svg: sketchToSvg(EMPTY) });
        // The margin marks the passage it was pinned to.
        const c = useReader.getState().content;
        if (c && s.unitId === c.unitId)
          useReader.getState().set({ content: { ...c, sketches: [{ id: s.id, blockId: s.blockId, title: s.title, svg: s.svg, updatedAt: s.updatedAt }, ...c.sketches] } });
        setOpen(s);
        setTitle(s.title);
        load();
      } catch (e) {
        toast(errorText(e), "error");
      }
    },
    [bookId, content, load, toast, unitId],
  );

  useEffect(() => {
    if (!request || request.seq === handled.current) return;
    handled.current = request.seq;
    if (request.sketchId) void api.sketches.get(request.sketchId).then((s) => (setOpen(s), setTitle(s.title)));
    else void start(request.blockId);
  }, [request, start]);

  const save = useCallback(
    (data: SketchData) => {
      const s = current.current;
      if (!s) return;
      const svg = sketchToSvg(data);
      void api.sketches
        .save({ id: s.id, bookId, blockId: s.blockId, unitId: s.unitId, title: title || s.title, data, svg })
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
    const anchor = content?.blocks.find((b) => b.id === open.blockId);
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
            onBlur={() => void api.sketches.save({ id: open.id, bookId, blockId: open.blockId, unitId: open.unitId, title, data: current.current?.data ?? open.data, svg: current.current?.svg ?? open.svg })}
          />
          <button
            className="icon-btn small"
            onClick={async () => {
              await api.sketches.remove(open.id);
              const c = useReader.getState().content;
              if (c) useReader.getState().set({ content: { ...c, sketches: c.sketches.filter((x) => x.id !== open.id) } });
              setOpen(null);
              load();
            }}
            aria-label="Delete sketch"
          >
            <Trash2 size={14} />
          </button>
        </div>
        {anchor && (
          <button className="sketch-anchor" onClick={() => void useReader.getState().goToBlock(anchor.id)}>
            Beside: <span>{displayText(anchor).slice(0, 90)}</span>
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
          <p>Diagrams, derivations, mind maps — sketch beside the text. Use a passage's ⋯ menu to pin a sketch to it.</p>
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
