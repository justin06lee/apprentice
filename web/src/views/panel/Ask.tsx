/**
 * Asking about the book. A conversation is anchored to the passage it began
 * on; the model sees that passage, the chapter around it, the reader's notes
 * and what they know. After an explanation it can offer to rewrite the
 * passage in the light of it — offered, not pushed.
 */
import { ArrowUp, ChevronLeft, Copy, Layers, MessageCircle, Plus, Settings, Square, Trash2, Wand2, X } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage, ChatThread } from "../../../../shared/types";
import { api, errorText } from "../../api";
import { ago } from "../../lib/format";
import { renderMarkdown } from "../../lib/markdown";
import { follow } from "../../lib/stream";
import { useApp } from "../../store";
import { useReader } from "../reader/state";

const QUICK = [
  ["Explain", "Explain this in plain terms."],
  ["Example", "Give me a concrete example of this."],
  ["Why?", "Why is this true? Walk me through the reasoning."],
  ["Connect", "How does this connect to what came earlier in the book?"],
  ["Quiz me", "Ask me one question that checks whether I understood this. Don't give the answer until I reply."],
] as const;

const Answer = memo(function Answer({ text }: { text: string }) {
  return <div className="answer selectable" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
});

export function Ask() {
  const bookId = useReader((s) => s.bookId)!;
  const unitId = useReader((s) => s.unitId);
  const request = useReader((s) => s.askRequest);
  const ai = useApp((s) => s.ai);
  const settings = useApp((s) => s.settings);
  const toast = useApp((s) => s.toast);
  const go = useApp((s) => s.go);

  const [threads, setThreads] = useState<ChatThread[] | null>(null);
  const [threadId, setThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [context, setContext] = useState<{ quote: string | null; blockIds: number[] } | null>(null);
  const [input, setInput] = useState("");
  const [stream, setStream] = useState<{ id: string; text: string } | null>(null);
  const [view, setView] = useState<"list" | "thread">("thread");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const handled = useRef(0);
  const offRef = useRef<(() => void) | null>(null);

  const loadThreads = useCallback(() => void api.chats.list(bookId).then(setThreads), [bookId]);
  useEffect(loadThreads, [loadThreads]);
  useEffect(() => () => offRef.current?.(), []);

  const openThread = async (id: number) => {
    setThreadId(id);
    setMessages(await api.chats.messages(id));
    setContext(null);
    setView("thread");
  };

  const send = useCallback(
    async (text: string, ctx = context) => {
      const message = text.trim();
      if (!message || stream) return;
      setInput("");
      const pending: ChatMessage = {
        id: -Date.now(),
        threadId: threadId ?? -1,
        role: "user",
        content: message,
        quote: ctx?.quote ?? null,
        blockId: ctx?.blockIds[0] ?? null,
        createdAt: Date.now(),
      };
      setMessages((m) => [...m, pending]);
      setContext(null);
      try {
        const r = await api.ai.ask({
          threadId,
          bookId,
          message,
          context: { ...(ctx?.blockIds.length ? { blockIds: ctx.blockIds } : {}), ...(ctx?.quote ? { quote: ctx.quote } : {}), ...(unitId ? { unitId } : {}) },
        });
        setThreadId(r.threadId);
        setStream({ id: r.streamId, text: "" });
        offRef.current = follow(r.streamId, {
          delta: (_d, all) => setStream((s) => (s && s.id === r.streamId ? { ...s, text: all } : s)),
          done: (e) => {
            setStream(null);
            if (e.message) setMessages((m) => [...m, e.message!]);
            loadThreads();
          },
          error: (msg) => {
            setStream(null);
            toast(msg, "error");
          },
        });
      } catch (e) {
        toast(errorText(e), "error");
        setMessages((m) => m.filter((x) => x.id !== pending.id));
      }
    },
    [bookId, context, loadThreads, stream, threadId, toast, unitId],
  );

  // A new question from the text: fresh conversation about that passage.
  useEffect(() => {
    if (!request || request.seq === handled.current) return;
    handled.current = request.seq;
    offRef.current?.();
    setStream(null);
    setThreadId(null);
    setMessages([]);
    setView("thread");
    const ctx = { quote: request.quote, blockIds: request.blockIds };
    setContext(ctx);
    if (request.prompt) void send(request.prompt, ctx);
    else requestAnimationFrame(() => inputRef.current?.focus());
  }, [request, send]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, stream?.text]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(180, el.scrollHeight)}px`;
  }, [input]);

  if (ai && !ai.available) {
    return (
      <div className="empty">
        <MessageCircle size={26} />
        <h3>No model to ask yet</h3>
        <p>
          apprentice uses the coding-agent CLIs signed in on this computer — Claude Code, Codex, Gemini and others — through yagami. No API key
          needed.
        </p>
        <p className="muted" style={{ fontSize: 12 }}>
          {ai.reason}
        </p>
        <button className="btn" onClick={() => go({ name: "settings" })}>
          <Settings size={14} /> AI settings
        </button>
      </div>
    );
  }

  if (view === "list") {
    return (
      <div className="ask">
        <div className="ask-bar">
          <span className="label">Conversations</span>
          <button
            className="btn small"
            onClick={() => {
              setThreadId(null);
              setMessages([]);
              setView("thread");
            }}
          >
            <Plus size={13} /> New
          </button>
        </div>
        <div className="thread-list">
          {threads?.length === 0 && <div className="empty">Nothing asked in this book yet.</div>}
          {threads?.map((t) => (
            <div key={t.id} className="thread-row" onClick={() => void openThread(t.id)}>
              <MessageCircle size={14} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="thread-title">{t.title}</div>
                <div className="muted thread-meta">
                  {t.messageCount} messages · {ago(t.updatedAt)}
                </div>
              </div>
              <button
                className="icon-btn small"
                onClick={(e) => {
                  e.stopPropagation();
                  void api.chats.remove(t.id).then(loadThreads);
                }}
                aria-label="Delete conversation"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const anchor = messages.find((m) => m.blockId)?.blockId ?? context?.blockIds[0] ?? null;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  return (
    <div className="ask">
      <div className="ask-bar">
        <button className="btn small ghost" onClick={() => (loadThreads(), setView("list"))}>
          <ChevronLeft size={14} /> {threads?.length ? `${threads.length} conversations` : "Conversations"}
        </button>
        {(messages.length > 0 || context) && (
          <button
            className="btn small ghost"
            onClick={() => {
              offRef.current?.();
              setStream(null);
              setThreadId(null);
              setMessages([]);
              setContext(null);
            }}
          >
            <Plus size={13} /> New
          </button>
        )}
      </div>

      <div className="messages" ref={listRef}>
        {!messages.length && !stream && (
          <div className="ask-intro">
            <MessageCircle size={22} />
            <p>
              Ask anything about this book. Select a passage first to ask about it specifically — the model sees the chapter around it, your
              notes, and what you already know.
            </p>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="msg user">
              {m.quote && (
                <blockquote className="msg-quote" onClick={() => m.blockId && void useReader.getState().goToBlock(m.blockId)}>
                  {m.quote.length > 280 ? `${m.quote.slice(0, 280)}…` : m.quote}
                </blockquote>
              )}
              <div className="msg-text">{m.content}</div>
            </div>
          ) : (
            <div key={m.id} className="msg assistant">
              <Answer text={m.content} />
              <div className="msg-actions">
                <button className="btn small ghost" onClick={() => (void navigator.clipboard.writeText(m.content), toast("Copied."))}>
                  <Copy size={12} /> Copy
                </button>
                <button
                  className="btn small ghost"
                  onClick={() => {
                    const q = [...messages].reverse().find((x) => x.role === "user" && x.createdAt <= m.createdAt);
                    useReader.getState().set({ cardDraft: { blockId: anchor, quote: `${q?.content ?? ""}\n\n${m.content}`.slice(0, 1500) } });
                  }}
                >
                  <Layers size={12} /> Card
                </button>
                {m === lastAssistant && anchor && settings.offerRewrites && (
                  <button
                    className="btn small offer"
                    onClick={() => {
                      useReader.getState().set({ rewrite: { blockId: anchor, streamId: null, text: "", state: "idle", instruction: "", threadId } });
                      void useReader.getState().goToBlock(anchor, false);
                    }}
                    title="Rewrite the passage you asked about, folding in this explanation. It becomes your version of it; the book's stays one click away."
                  >
                    <Wand2 size={12} /> Rewrite the passage this way
                  </button>
                )}
              </div>
            </div>
          ),
        )}
        {stream && (
          <div className="msg assistant">
            {stream.text ? <Answer text={stream.text} /> : <div className="thinking dots">Reading the chapter</div>}
          </div>
        )}
      </div>

      <div className="composer-box">
        {context?.quote && (
          <div className="ctx-chip">
            <span className="ctx-quote">“{context.quote.length > 160 ? `${context.quote.slice(0, 160)}…` : context.quote}”</span>
            <button className="icon-btn small" onClick={() => setContext(null)} aria-label="Remove passage">
              <X size={13} />
            </button>
          </div>
        )}
        {context?.quote && !input && !stream && (
          <div className="quick">
            {QUICK.map(([label, prompt]) => (
              <button key={label} className="chip-btn" onClick={() => void send(prompt)}>
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="composer-row">
          <textarea
            ref={inputRef}
            rows={1}
            placeholder={context?.quote ? "Ask about this passage…" : "Ask about the book…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
          />
          {stream ? (
            <button className="send stop" onClick={() => (void api.ai.cancel(stream.id), offRef.current?.(), setStream(null))} aria-label="Stop">
              <Square size={13} />
            </button>
          ) : (
            <button className="send" disabled={!input.trim()} onClick={() => void send(input)} aria-label="Send">
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
