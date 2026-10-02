/**
 * One block of the book, drawn. Memoized on its inputs: scrolling, reading,
 * and highlighting elsewhere never re-render it.
 *
 * Text goes inside a `[data-text]` element and nothing else does — bullets,
 * labels and the gutter sit outside it — so selection offsets are plain
 * character counts (see lib/selection.ts).
 */
import { Ellipsis, PenLine, Sparkles } from "lucide-react";
import { memo, useMemo } from "react";
import { MarkFlag, type Block, type Highlight } from "../../../../shared/types";
import { assetUrl } from "../../api";
import { renderTex } from "../../lib/markdown";
import { parseInline, segments, TEX, TEX_DISPLAY } from "../../lib/text";

export interface BlockProps {
  block: Block;
  bookId: string;
  highlights: Highlight[];
  /** Pixels per PDF point: the reader's type size over the book's. */
  scale: number;
  showOriginal: boolean;
  read: boolean;
  hasChat: boolean;
  /** The heading that opens the chapter on screen: set as its title, whatever its depth in the book. */
  lead?: boolean;
  /** A sketch pinned beside this block. */
  sketchId?: number | undefined;
}

function Text({ blockId, text, marks, highlights }: { blockId: number; text: string; marks: Block["marks"]; highlights: Highlight[] }) {
  const segs = useMemo(() => segments(text.length, marks, highlights), [text, marks, highlights]);
  return (
    <span data-text={blockId} data-len={text.length}>
      {segs.map((sg) => {
        const t = text.slice(sg.s, sg.e);
        if (sg.f & TEX) {
          return (
            <span
              key={sg.s}
              data-atom
              data-len={t.length}
              className={`${sg.f & TEX_DISPLAY ? "tex-display" : "tex"}${sg.hl ? ` hl hl-${sg.hl.color}` : ""}`}
              {...(sg.hl ? { "data-hl": sg.hl.id } : {})}
              dangerouslySetInnerHTML={{ __html: renderTex(t, !!(sg.f & TEX_DISPLAY)) }}
            />
          );
        }
        let cls = "";
        if (sg.f & MarkFlag.BOLD) cls += " b";
        if (sg.f & MarkFlag.ITALIC) cls += " i";
        if (sg.f & MarkFlag.MONO) cls += " m";
        if (sg.f & MarkFlag.SUP) cls += " sup";
        if (sg.f & MarkFlag.SUB) cls += " sub";
        if (sg.f & MarkFlag.MATH) cls += " math";
        if (sg.ref) cls += " fnref";
        if (sg.hl) cls += ` hl hl-${sg.hl.color}${sg.hl.note ? " has-note" : ""}`;
        if (!cls) return t;
        return (
          <span key={sg.s} className={cls.trim()} {...(sg.hl ? { "data-hl": sg.hl.id } : {})} {...(sg.ref ? { "data-ref": sg.ref } : {})}>
            {t}
          </span>
        );
      })}
    </span>
  );
}

function Gutter({ block, hasChat, sketchId }: { block: Block; hasChat: boolean; sketchId?: number | undefined }) {
  return (
    <div className="gutter">
      {sketchId !== undefined && (
        <button className="gutter-sketch" data-open-sketch={sketchId} aria-label="Open the sketch beside this" title="Your sketch">
          <PenLine size={12} />
        </button>
      )}
      <button className="gutter-btn" data-block-menu={block.id} aria-label="Passage actions" title="Ask, rewrite, edit, card, sketch…">
        <Ellipsis size={15} />
      </button>
      {block.custom && (
        <span className="gutter-mine" data-toggle-original={block.id} title={block.custom.source === "ai" ? "Rewritten for you — click to compare with the book" : "Your version — click to compare with the book"}>
          {block.custom.source === "ai" ? <Sparkles size={11} /> : null}
        </span>
      )}
      {hasChat && <span className="gutter-chat" title="You asked about this" />}
    </div>
  );
}

function BlockViewImpl({ block, bookId, highlights, scale, showOriginal, read, hasChat, lead, sketchId }: BlockProps) {
  const mine = block.custom && !showOriginal;
  const { text, marks } = useMemo(() => (mine ? parseInline(block.custom!.text) : { text: block.text, marks: block.marks }), [mine, block]);
  const hls = useMemo(() => highlights.filter((h) => h.onCustom === !!mine), [highlights, mine]);
  const cls = `blk${read ? " read" : ""}${mine ? " mine" : ""}${block.custom && showOriginal ? " original" : ""}`;
  const body = <Text blockId={block.id} text={text} marks={marks} highlights={hls} />;
  const common = { "data-id": block.id, className: `${cls} t-${block.type}` };

  switch (block.type) {
    case "heading": {
      const level = lead ? 1 : Math.min(4, Math.max(2, block.level));
      const Tag = (`h${level + 1}` as "h2" | "h3" | "h4" | "h5");
      return (
        <div {...common} className={`${common.className} hd${level}`}>
          <Gutter block={block} hasChat={hasChat} sketchId={sketchId} />
          <Tag>
            {block.label && <span className="hd-label">{block.label}</span>}
            {body}
          </Tag>
        </div>
      );
    }
    case "equation":
    case "figure":
    case "table": {
      if (!block.asset) {
        return (
          <div {...common}>
            <Gutter block={block} hasChat={hasChat} sketchId={sketchId} />
            <pre className="fallback">{body}</pre>
          </div>
        );
      }
      const w = block.width * scale;
      const h = block.height * scale;
      return (
        <div {...common}>
          <Gutter block={block} hasChat={hasChat} sketchId={sketchId} />
          <figure className={block.type === "equation" ? "eq" : "fig"}>
            <img
              src={assetUrl(bookId, block.asset)}
              alt={block.text.slice(0, 300)}
              loading="lazy"
              decoding="async"
              draggable={false}
              style={{ width: w, aspectRatio: `${block.width} / ${block.height}`, maxHeight: block.type === "equation" ? undefined : `${Math.max(h, 1)}px` }}
            />
          </figure>
        </div>
      );
    }
    case "code":
      return (
        <div {...common}>
          <Gutter block={block} hasChat={hasChat} sketchId={sketchId} />
          <pre className="code">
            <code>{body}</code>
          </pre>
        </div>
      );
    case "list":
      return (
        <div {...common} style={{ ["--depth" as string]: block.level }}>
          <Gutter block={block} hasChat={hasChat} sketchId={sketchId} />
          <div className="li">
            <span className="li-mark">{block.label && /^[–—-]$/.test(block.label) ? "–" : (block.label ?? "•")}</span>
            <p>{body}</p>
          </div>
        </div>
      );
    case "footnote":
      return (
        <div {...common} id={`fn-${block.id}`}>
          <Gutter block={block} hasChat={hasChat} sketchId={sketchId} />
          <aside className="fn">
            <span className="fn-label">{block.label}</span>
            <p>{body}</p>
          </aside>
        </div>
      );
    case "caption":
      return (
        <div {...common}>
          <Gutter block={block} hasChat={hasChat} sketchId={sketchId} />
          <p className="cap">{body}</p>
        </div>
      );
    case "quote":
      return (
        <div {...common}>
          <Gutter block={block} hasChat={hasChat} sketchId={sketchId} />
          <blockquote>{body}</blockquote>
        </div>
      );
    default:
      return (
        <div {...common}>
          <Gutter block={block} hasChat={hasChat} sketchId={sketchId} />
          <p>{body}</p>
        </div>
      );
  }
}

export const BlockView = memo(BlockViewImpl);
