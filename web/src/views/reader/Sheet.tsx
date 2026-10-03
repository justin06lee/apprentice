/**
 * One page of the book: the PDF's own picture of it, and over it what the
 * reader has left there — highlights, search marks, the selection, their
 * own versions of passages laid on like slips of paper, and pins in the
 * margin for sketches and conversations.
 *
 * Everything is placed from the page's text layer, in points, times
 * `scale`. The sheet draws; it handles no pointer of its own except on the
 * slips and pins (marked `data-ui`) — selecting is the book's job, so a
 * drag can run from one page onto the next.
 */
import { MessageCircle, PenLine } from "lucide-react";
import { memo, useMemo } from "react";
import { findAll, rangeRects, type Rect } from "../../../../shared/pages";
import type { Highlight } from "../../../../shared/types";
import { pageUrl } from "../../api";
import { usePageText } from "../../lib/pages";
import { SlipBench, VersionSlip } from "./Slip";
import { useReader } from "./state";

export interface SheetProps {
  bookId: string;
  page: number;
  size: [number, number];
  /** The part of the page shown — all of it, or its printed area when margins are trimmed. */
  crop: Rect;
  /** CSS pixels per point. */
  scale: number;
  /** Width to draw the picture at, in device pixels. */
  px: number;
  side: "left" | "right" | "single";
  /** False for the leaf of a turning page: it is shown, not used. */
  interactive: boolean;
  /** The selection's ranges on this page. */
  selection?: Array<[number, number]> | undefined;
  /** A region being drawn on this page. */
  box?: Rect | null | undefined;
}

const none: never[] = [];

function Rects({ rects, scale, className, data }: { rects: Rect[]; scale: number; className: string; data?: Record<string, string | number> }) {
  return (
    <>
      {rects.map((r, i) => (
        <div
          key={i}
          className={className}
          {...data}
          style={{ left: r[0] * scale, top: r[1] * scale, width: (r[2] - r[0]) * scale, height: (r[3] - r[1]) * scale }}
        />
      ))}
    </>
  );
}

function SheetImpl({ bookId, page, size, crop, scale, px, side, interactive, selection, box }: SheetProps) {
  const pt = usePageText(bookId, page);
  const highlights = useReader((s) => s.highlights);
  const versions = useReader((s) => s.versions);
  const lifted = useReader((s) => s.lifted);
  const pins = useReader((s) => s.pins);
  const chats = useReader((s) => s.chats);
  const flash = useReader((s) => (s.flash?.page === page ? s.flash : null));
  const marks = useReader((s) => (s.marks?.page === page ? s.marks : null));
  const slip = useReader((s) => (s.slip?.passage.page === page ? s.slip : null));
  const w = size[0] * scale;
  const h = size[1] * scale;
  // The picture is clipped to the crop; what is drawn over it is not, so a
  // slip or a pin near the edge is never cut.
  const clip = `inset(${crop[1] * scale}px ${w - crop[2] * scale}px ${h - crop[3] * scale}px ${crop[0] * scale}px)`;

  const mine = useMemo(() => highlights.filter((x) => x.page === page), [highlights, page]);
  const myVersions = useMemo(() => versions.filter((v) => v.page === page), [versions, page]);
  const hlRects = useMemo(() => (pt ? mine.map((x) => [x, rangeRects(pt, x.start, x.end)] as [Highlight, Rect[]]) : []), [pt, mine]);
  const markRects = useMemo(() => {
    if (!pt || !marks) return none;
    return findAll(pt, marks.terms).flatMap(([a, b]) => rangeRects(pt, a, b));
  }, [pt, marks]);
  const selRects = useMemo(() => (pt && selection ? selection.flatMap(([a, b]) => rangeRects(pt, a, b)) : none), [pt, selection]);
  const flashRects = useMemo(() => {
    if (!flash) return none;
    if (flash.box) return [flash.box];
    if (flash.range && pt) return rangeRects(pt, flash.range[0], flash.range[1]);
    return none;
  }, [flash, pt]);
  const pinned = useMemo(() => {
    const out: Array<{ kind: "sketch" | "chat"; id: number; y: number; title: string }> = [];
    for (const p of pins) if (p.page === page) out.push({ kind: "sketch", id: p.id, y: p.y, title: p.title });
    for (const c of chats) {
      if (c.page !== page) continue;
      const line = pt && c.start !== null ? rangeRects(pt, c.start, c.start + 1)[0] : null;
      out.push({ kind: "chat", id: c.id, y: line ? line[1] : 40, title: "A conversation about this" });
    }
    return out;
  }, [pins, chats, page, pt]);

  return (
    <div
      className={`sheet side-${side}`}
      data-page={interactive ? page : undefined}
      style={{ width: (crop[2] - crop[0]) * scale, height: (crop[3] - crop[1]) * scale }}
    >
      <div className="sheet-page" style={{ width: w, height: h, left: -crop[0] * scale, top: -crop[1] * scale }}>
      <img className="sheet-img" src={pageUrl(bookId, page, px)} alt="" draggable={false} style={{ clipPath: clip }} />
      <div className="sheet-layer">
        {hlRects.map(([x, rects]) => (
          <Rects key={x.id} rects={rects} scale={scale} className={`hl-rect hl-${x.color}${x.note.trim() ? " has-note" : ""}`} data={{ "data-hl": x.id }} />
        ))}
        <Rects rects={markRects} scale={scale} className="mark-rect" />
        <Rects rects={selRects} scale={scale} className="sel-rect" />
        {flashRects.length > 0 && <Rects key={flash!.seq} rects={flashRects} scale={scale} className="flash-rect" />}
        {pt && myVersions.map((v) => <VersionSlip key={v.id} v={v} pt={pt} scale={scale} lifted={lifted.has(v.id)} />)}
        {pt && slip && interactive && <SlipBench slip={slip} pt={pt} scale={scale} crop={crop} />}
        {box && (
          <div className="box-draft" style={{ left: box[0] * scale, top: box[1] * scale, width: (box[2] - box[0]) * scale, height: (box[3] - box[1]) * scale }} />
        )}
        {pinned.map((p) => (
          <button
            key={`${p.kind}-${p.id}`}
            className={`pin pin-${p.kind}`}
            data-ui
            // Just off the page's outer edge, on the desk, clear of the words.
            style={{ top: p.y * scale, left: side === "left" ? crop[0] * scale - 30 : crop[2] * scale + 8 }}
            title={p.kind === "sketch" ? `Your sketch: ${p.title || "untitled"}` : p.title}
            onClick={() => (p.kind === "sketch" ? useReader.getState().sketch(null, p.id) : useReader.getState().openThread(p.id))}
          >
            {p.kind === "sketch" ? <PenLine size={12} /> : <MessageCircle size={12} />}
          </button>
        ))}
      </div>
      </div>
    </div>
  );
}

export const Sheet = memo(SheetImpl);
