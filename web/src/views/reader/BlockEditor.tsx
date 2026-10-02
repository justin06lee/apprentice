/**
 * Writing a passage your own way — by hand, or by asking for it.
 *
 * Either way the book's text is kept: a passage with a version of yours
 * shows yours, marked in the margin, and one click compares or restores.
 */
import { Check, RefreshCw, Sparkles, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Block } from "../../../../shared/types";
import { api, errorText } from "../../api";
import { renderMarkdown } from "../../lib/markdown";
import { follow } from "../../lib/stream";
import { mod } from "../../lib/format";
import { useApp } from "../../store";
import { useReader } from "./state";

export function BlockEditor({ block }: { block: Block }) {
  const [text, setText] = useState(block.custom?.text ?? block.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const r = useReader.getState();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const save = async () => {
    await r.saveBlock(block.id, text.trim() === block.text.trim() ? null : text, "user");
    r.set({ editing: null });
  };
  const cancel = () => r.set({ editing: null });

  return (
    <div className="editor" data-id={block.id}>
      <textarea
        ref={ref}
        className={`editor-text ${block.type === "code" ? "code" : ""}`}
        value={text}
        spellCheck
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="editor-bar">
        <span className="muted">
          Your version replaces the book's here, for you. **bold**, *italic*, $math$ work. <span className="kbd">{mod}</span>
          <span className="kbd">↵</span> saves.
        </span>
        <span style={{ flex: 1 }} />
        {block.custom && (
          <button className="btn small ghost" onClick={() => (void r.saveBlock(block.id, null), r.set({ editing: null }))}>
            Restore book's text
          </button>
        )}
        <button className="btn small ghost" onClick={cancel}>
          Cancel
        </button>
        <button className="btn small primary" onClick={() => void save()}>
          <Check size={13} /> Save
        </button>
      </div>
    </div>
  );
}

const SUGGESTIONS = ["Simpler", "With an example", "More intuition", "Step by step", "More concise", "More rigorous"];

export function RewriteCard({ block }: { block: Block }) {
  const rewrite = useReader((s) => s.rewrite);
  const toast = useApp((s) => s.toast);
  const [instruction, setInstruction] = useState(rewrite?.instruction ?? "");
  const offRef = useRef<(() => void) | null>(null);

  const start = async (extra = instruction) => {
    const r = useReader.getState();
    offRef.current?.();
    try {
      const { streamId } = await api.ai.rewrite({ blockId: block.id, instruction: extra, threadId: r.rewrite?.threadId ?? null });
      r.set({ rewrite: { blockId: block.id, streamId, text: "", state: "streaming", instruction: extra, threadId: r.rewrite?.threadId ?? null } });
      offRef.current = follow(streamId, {
        delta: (_d, all) => {
          const cur = useReader.getState().rewrite;
          if (cur?.streamId === streamId) useReader.getState().set({ rewrite: { ...cur, text: all } });
        },
        done: (_e, all) => {
          const cur = useReader.getState().rewrite;
          if (cur?.streamId === streamId) useReader.getState().set({ rewrite: { ...cur, text: all.trim(), state: "done" } });
        },
        error: (message) => {
          const cur = useReader.getState().rewrite;
          if (cur?.streamId === streamId) useReader.getState().set({ rewrite: { ...cur, state: "error", error: message } });
        },
      });
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  // Asked for from the passage menu: begin at once.
  useEffect(() => {
    if (rewrite?.state === "idle") void start("");
    return () => offRef.current?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rewrite) return null;
  const close = () => {
    if (rewrite.streamId && rewrite.state === "streaming") void api.ai.cancel(rewrite.streamId);
    offRef.current?.();
    useReader.getState().set({ rewrite: null });
  };
  const accept = async () => {
    await useReader.getState().saveBlock(block.id, rewrite.text, "ai");
    useReader.getState().set({ rewrite: null });
    toast("Saved as your version of this passage. The book's text is one click away in the margin.", "success");
  };

  return (
    <div className="rewrite">
      <div className="rewrite-head">
        <Sparkles size={14} />
        <strong>Rewritten for you</strong>
        {rewrite.state === "streaming" && <span className="muted dots">writing</span>}
        <span style={{ flex: 1 }} />
        <button className="icon-btn small" onClick={close} aria-label="Close">
          <X size={15} />
        </button>
      </div>
      {rewrite.state === "error" ? (
        <p className="rewrite-error">{rewrite.error}</p>
      ) : (
        <div className="rewrite-body answer" dangerouslySetInnerHTML={{ __html: renderMarkdown(rewrite.text || " ") }} />
      )}
      <div className="rewrite-chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chip-btn" disabled={rewrite.state === "streaming"} onClick={() => (setInstruction(s), void start(s))}>
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
        {rewrite.state === "streaming" ? (
          <button className="btn small" onClick={() => rewrite.streamId && (void api.ai.cancel(rewrite.streamId), useReader.getState().set({ rewrite: { ...rewrite, state: "done" } }))}>
            <Square size={12} /> Stop
          </button>
        ) : (
          <button className="btn small" onClick={() => void start()}>
            <RefreshCw size={13} /> Again
          </button>
        )}
        <button className="btn small primary" disabled={rewrite.state !== "done" || !rewrite.text.trim()} onClick={() => void accept()}>
          <Check size={13} /> Use this
        </button>
      </div>
    </div>
  );
}
