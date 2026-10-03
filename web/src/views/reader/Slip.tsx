/**
 * The reader's own versions of passages, on the page.
 *
 * A version lies over the passage it rewrites like a slip of paper pasted
 * into the book: set in the book's type size, edge to edge with its lines.
 * Lifting it shows the book's text again; the book's text is never changed.
 * The bench is where a slip is written — by hand, or by a model, streaming
 * — in place, over the passage it will cover.
 */
import { Check, PenLine, RefreshCw, Sparkles, Square, Trash2, Undo2, Wand2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cleanText, rangeRects, type PageText, type Rect } from "../../../../shared/pages";
import type { Version } from "../../../../shared/types";
import { api, errorText } from "../../api";
import { Popover } from "../../components/ui";
import { mod } from "../../lib/format";
import { renderMarkdown } from "../../lib/markdown";
import { follow } from "../../lib/stream";
import { useApp } from "../../store";
import { useReader, type SlipState } from "./state";

/** The box a passage's lines fill, edge to edge. */
export function passageBox(pt: PageText, start: number, end: number): Rect | null {
  const rs = rangeRects(pt, start, end);
  if (!rs.length) return null;
  return [Math.min(...rs.map((r) => r[0])), rs[0]![1], Math.max(...rs.map((r) => r[2])), rs[rs.length - 1]![3]];
}

/** The book's type size around a passage, in points: what a slip is set in. */
function typeSize(pt: PageText, start: number, end: number): number {
  const hs = rangeRects(pt, start, end)
    .map((r) => r[3] - r[1])
    .sort((a, b) => a - b);
  return Math.max(6, Math.min(16, (hs[Math.floor(hs.length / 2)] ?? 11) * 0.9));
}

export function VersionSlip({ v, pt, scale, lifted }: { v: Version; pt: PageText; scale: number; lifted: boolean }) {
  const box = passageBox(pt, v.start, v.end);
  const html = useMemo(() => renderMarkdown(v.text), [v.text]);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const ai = useApp((s) => s.ai);
  if (!box) return null;
  const r = useReader.getState();
  const passage = { page: v.page, start: v.start, end: v.end, quote: v.quote };
  const style = { left: box[0] * scale - 4, top: box[1] * scale - 3, width: (box[2] - box[0]) * scale + 8 };
  const label = v.source === "ai" ? "Rewritten for you" : "Your version";
  const item = (icon: React.ReactNode, text: string, run: () => void, disabled = false) => (
    <button
      className="menu-item"
      disabled={disabled}
      style={disabled ? { opacity: 0.45 } : undefined}
      onClick={() => {
        setMenu(null);
        run();
      }}
    >
      {icon} {text}
    </button>
  );
  return (
    <>
      {lifted ? (
        <div className="slip-outline" style={{ ...style, height: (box[3] - box[1]) * scale + 6 }}>
          <button className="slip-tab" data-ui onClick={() => r.toggleLifted(v.id)} title={`${label} — lay it back over the book's text`}>
            <Undo2 size={11} /> yours
          </button>
        </div>
      ) : (
        <div className="slip" data-ui style={{ ...style, minHeight: (box[3] - box[1]) * scale + 6, fontSize: typeSize(pt, v.start, v.end) * scale }}>
          <div className="slip-text answer" dangerouslySetInnerHTML={{ __html: html }} />
          <button
            className="slip-tab"
            onClick={(e) => setMenu((e.currentTarget as HTMLElement).getBoundingClientRect())}
            title={`${label} — click for the book's text`}
          >
            {v.source === "ai" ? <Sparkles size={11} /> : <PenLine size={11} />} yours
          </button>
        </div>
      )}
      {menu && (
        <Popover anchor={{ x: menu.left + menu.width / 2, y: menu.top, h: menu.height }} placement="below" onClose={() => setMenu(null)}>
          <div className="menu">
            {item(<Undo2 size={15} />, "Show the book's text", () => r.toggleLifted(v.id))}
            {item(<PenLine size={15} />, "Edit my version", () => r.set({ slip: bench(passage, "edit") }))}
            {item(<Wand2 size={15} />, "Rewrite it again…", () => r.set({ slip: bench(passage, "rewrite") }), !ai?.available)}
            <div className="menu-sep" />
            {item(<Trash2 size={15} />, "Remove my version", () => void r.removeVersion(v.id))}
          </div>
        </Popover>
      )}
    </>
  );
}

export function bench(passage: SlipState["passage"], mode: SlipState["mode"], threadId: number | null = null): SlipState {
  return { passage, mode, streamId: null, text: "", state: "idle", instruction: "", threadId };
}

const SUGGESTIONS = ["Simpler", "With an example", "More intuition", "Step by step", "More concise", "More rigorous"];

/**
 * Where the bench sits: over its passage, at least wide enough to work in,
 * within the part of the page shown, and growing upward when the passage is
 * low on it.
 */
function benchStyle(box: Rect, scale: number, crop: Rect, height: number): React.CSSProperties {
  const [cx0, cy0, cx1, cy1] = crop.map((v) => v * scale) as Rect;
  const width = Math.min(cx1 - cx0 - 12, Math.max((box[2] - box[0]) * scale + 8, 380));
  const left = Math.max(cx0 + 6, Math.min(cx1 - width - 6, box[0] * scale - 4));
  return box[1] * scale > cy0 + (cy1 - cy0) * 0.55 ? { left, width, bottom: height - box[3] * scale - 3 } : { left, width, top: box[1] * scale - 3 };
}

export function SlipBench({ slip, pt, scale, crop }: { slip: SlipState; pt: PageText; scale: number; crop: Rect }) {
  const box = passageBox(pt, slip.passage.start, slip.passage.end);
  if (!box) return null;
  const style = benchStyle(box, scale, crop, pt.height * scale);
  return slip.mode === "edit" ? <Editor slip={slip} pt={pt} style={style} /> : <Rewriter slip={slip} style={style} />;
}

function Editor({ slip, pt, style }: { slip: SlipState; pt: PageText; style: React.CSSProperties }) {
  const { passage } = slip;
  const existing = useReader((s) => s.versions.find((v) => v.page === passage.page && v.start === passage.start && v.end === passage.end));
  const original = cleanText(pt.text.slice(passage.start, passage.end));
  const [text, setText] = useState(existing?.text ?? original);
  const ref = useRef<HTMLTextAreaElement>(null);
  const r = useReader.getState();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(420, el.scrollHeight + 2)}px`;
  }, [text]);
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const close = () => r.set({ slip: null });
  const save = async () => {
    if (!text.trim() || text.trim() === original) {
      if (existing) await r.removeVersion(existing.id);
    } else await r.saveVersion({ ...passage, quote: original }, text, "user");
    close();
  };

  return (
    <div className="bench" data-ui style={style}>
      <textarea
        ref={ref}
        className="bench-text"
        value={text}
        spellCheck
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="bench-bar">
        <span className="muted">
          Lies over the book's text, for you. **bold**, *italic*, $math$. <span className="kbd">{mod}</span>
          <span className="kbd">↵</span>
        </span>
        <span style={{ flex: 1 }} />
        {existing && (
          <button className="btn small ghost" onClick={() => (void r.removeVersion(existing.id), close())}>
            Remove
          </button>
        )}
        <button className="btn small ghost" onClick={close}>
          Cancel
        </button>
        <button className="btn small primary" onClick={() => void save()}>
          <Check size={13} /> Save
        </button>
      </div>
    </div>
  );
}

function Rewriter({ slip, style }: { slip: SlipState; style: React.CSSProperties }) {
  const toast = useApp((s) => s.toast);
  const bookId = useReader((s) => s.bookId)!;
  const [instruction, setInstruction] = useState(slip.instruction);
  const offRef = useRef<(() => void) | null>(null);
  const html = useMemo(() => renderMarkdown(slip.text || " "), [slip.text]);

  const update = (patch: Partial<SlipState>, streamId: string) => {
    const cur = useReader.getState().slip;
    if (cur?.streamId === streamId) useReader.getState().set({ slip: { ...cur, ...patch } });
  };

  const start = async (extra = instruction) => {
    const r = useReader.getState();
    offRef.current?.();
    try {
      const { streamId } = await api.ai.rewrite({ bookId, passage: slip.passage, instruction: extra, threadId: slip.threadId });
      r.set({ slip: { ...slip, streamId, text: "", state: "streaming", instruction: extra } });
      offRef.current = follow(streamId, {
        delta: (_d, all) => update({ text: all }, streamId),
        done: (_e, all) => update({ text: all.trim(), state: "done" }, streamId),
        error: (message) => update({ state: "error", error: message }, streamId),
      });
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  // Asked for from a menu: begin at once.
  useEffect(() => {
    if (slip.state === "idle") void start("");
    return () => offRef.current?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    if (slip.streamId && slip.state === "streaming") void api.ai.cancel(slip.streamId);
    offRef.current?.();
    useReader.getState().set({ slip: null });
  };
  const accept = async () => {
    const v = await useReader.getState().saveVersion(slip.passage, slip.text, "ai");
    useReader.getState().set({ slip: null });
    if (v) toast("Laid over the passage as your version. The book's text is under it — click the slip's tab.", "success");
  };

  return (
    <div className="bench rewrite" data-ui style={style}>
      <div className="rewrite-head">
        <Sparkles size={14} />
        <strong>Rewritten for you</strong>
        {slip.state === "streaming" && <span className="muted dots">writing</span>}
        <span style={{ flex: 1 }} />
        <button className="icon-btn small" onClick={close} aria-label="Close">
          <X size={15} />
        </button>
      </div>
      {slip.state === "error" ? <p className="rewrite-error">{slip.error}</p> : <div className="rewrite-body answer" dangerouslySetInnerHTML={{ __html: html }} />}
      <div className="rewrite-chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chip-btn" disabled={slip.state === "streaming"} onClick={() => (setInstruction(s), void start(s))}>
            {s}
          </button>
        ))}
      </div>
      <div className="rewrite-bar">
        <input
          className="input"
          placeholder="Or say how you'd like it written…"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && instruction.trim() && void start()}
        />
        {slip.state === "streaming" ? (
          <button
            className="btn small"
            onClick={() => slip.streamId && (void api.ai.cancel(slip.streamId), useReader.getState().set({ slip: { ...slip, state: "done" } }))}
          >
            <Square size={12} /> Stop
          </button>
        ) : (
          <button className="btn small" onClick={() => void start()}>
            <RefreshCw size={13} /> Again
          </button>
        )}
        <button className="btn small primary" disabled={slip.state !== "done" || !slip.text.trim()} onClick={() => void accept()}>
          <Check size={13} /> Use this
        </button>
      </div>
    </div>
  );
}
