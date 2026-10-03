/**
 * Asking about the book. A conversation is anchored to the passage (or the
 * boxed region) it began on; the model sees that, the pages around it, the
 * reader's notes and what they know. After an explanation it can offer to
 * rewrite the passage in the light of it — offered, not pushed.
 */
import { ArrowUp, ChevronLeft, Copy, Layers, MessageCircle, Plus, Settings, Square, SquareDashed, Trash2, Wand2, X } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage, ChatThread, Passage } from "../../../../shared/types";
import { api, errorText } from "../../api";
import { ago } from "../../lib/format";
import { renderMarkdown } from "../../lib/markdown";
import { follow } from "../../lib/stream";
import { useApp } from "../../store";
import { bench } from "../reader/Slip";
import { useReader, type Region } from "../reader/state";

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

type Context = { passage: Passage | null; region: Region | null };

/** Back to where a message was asked from. */
function show(m: ChatMessage) {
  if (m.page === null) return;
  useReader.getState().goTo(m.page, m.start !== null && m.end !== null ? { range: [m.start, m.end] } : undefined);
}

export function Ask() {
  const bookId = useReader((s) => s.bookId)!;
  const request = useReader((s) => s.askRequest);
  const ai = useApp((s) => s.ai);
  const settings = useApp((s) => s.settings);
  const toast = useApp((s) => s.toast);
  const go = useApp((s) => s.go);

  const [threads, setThreads] = useState<ChatThread[] | null>(null);
  const [threadId, setThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [context, setContext] = useState<Context | null>(null);
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
        quote: ctx?.passage?.quote ?? (ctx?.region ? `[the region of page ${ctx.region.page + 1} you boxed]` : null),
        page: ctx?.passage?.page ?? ctx?.region?.page ?? null,
        start: ctx?.passage?.start ?? null,
        end: ctx?.passage?.end ?? null,
        createdAt: Date.now(),
      };
      setMessages((m) => [...m, pending]);
      setContext(null);
      try {
        const visible = useReader.getState().visible;
        const r = await api.ai.ask({
          threadId,
          bookId,
          message,
          context: {
            ...(ctx?.passage ? { passage: { page: ctx.passage.page, start: ctx.passage.start, end: ctx.passage.end, quote: ctx.passage.quote } } : {}),
            ...(ctx?.region ? { region: ctx.region } : {}),
            ...(visible.length ? { pages: visible } : {}),
          },
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
    [bookId, context, loadThreads, stream, threadId, toast],
  );

  // A new question from the text: fresh conversation about that passage.
  useEffect(() => {
    if (!request || request.seq === handled.current) return;
    handled.current = request.seq;
    offRef.current?.();
    setStream(null);
    if (request.threadId) {
      void openThread(request.threadId);
      return;
    }
    setThreadId(null);
    setMessages([]);
    setView("thread");
    const ctx = { passage: request.passage, region: request.region };
    setContext(ctx);
    if (request.prompt) void send(request.prompt, ctx);
    else requestAnimationFrame(() => inputRef.current?.focus());
  }, [request, send]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // The passage the conversation is about, for a rewrite to work on.
  const asked = messages.find((m) => m.role === "user" && m.page !== null && m.start !== null && m.end !== null && m.quote);
  const anchor: Passage | null = asked ? { page: asked.page!, start: asked.start!, end: asked.end!, quote: asked.quote! } : null;
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
              Ask anything about these pages. Select a passage — or box a figure or an equation — to ask about it; the model sees the pages around it, your
              notes, and what you already know.
            </p>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="msg user">
              {m.quote && (
                <blockquote className="msg-quote" onClick={() => show(m)} title={m.page !== null ? `Page ${m.page + 1}` : undefined}>
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
                    useReader.getState().set({ cardDraft: { page: m.page, quote: `${q?.content ?? ""}\n\n${m.content}`.slice(0, 1500), context: "" } });
                  }}
                >
                  <Layers size={12} /> Card
                </button>
                {m === lastAssistant && anchor && settings.offerRewrites && (
                  <button
                    className="btn small offer"
                    onClick={() => {
                      useReader.getState().goTo(anchor.page);
                      useReader.getState().set({ slip: bench(anchor, "rewrite", threadId) });
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
        {context?.region && (
          <div className="ctx-chip">
            <span className="ctx-quote">
              <SquareDashed size={12} /> The box you drew on page {context.region.page + 1} — the model sees it as a picture
            </span>
            <button className="icon-btn small" onClick={() => setContext(null)} aria-label="Remove region">
              <X size={13} />
            </button>
          </div>
        )}
        {context?.passage && (
          <div className="ctx-chip">
            <span className="ctx-quote">“{context.passage.quote.length > 160 ? `${context.passage.quote.slice(0, 160)}…` : context.passage.quote}”</span>
            <button className="icon-btn small" onClick={() => setContext(null)} aria-label="Remove passage">
              <X size={13} />
            </button>
          </div>
        )}
        {(context?.passage || context?.region) && !input && !stream && (
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
            placeholder={context?.passage ? "Ask about this passage…" : context?.region ? "Ask about what you boxed…" : "Ask about these pages…"}
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
