/**
 * Following one model answer as it streams in over `ai.stream` events.
 *
 * Events are buffered from the moment the app starts, because the call that
 * starts a stream returns its id over the same channel the first words come
 * back on, and nothing promises the id arrives first. A late subscriber
 * replays what it missed.
 */
import type { AiStreamEvent } from "../../../shared/api";
import { on } from "../api";

const buffered = new Map<string, { events: AiStreamEvent[]; at: number }>();
const live = new Map<string, Set<(e: AiStreamEvent) => void>>();

on("ai.stream", (e) => {
  const subs = live.get(e.streamId);
  if (subs?.size) for (const s of subs) s(e);
  else {
    const b = buffered.get(e.streamId) ?? { events: [], at: Date.now() };
    b.events.push(e);
    buffered.set(e.streamId, b);
  }
  // Forget streams nobody claimed within a minute.
  const cutoff = Date.now() - 60_000;
  for (const [id, b] of buffered) if (b.at < cutoff) buffered.delete(id);
});

export function follow(
  streamId: string,
  handlers: { delta?(text: string, all: string): void; done?(e: AiStreamEvent, all: string): void; error?(message: string): void },
): () => void {
  let all = "";
  let closed = false;
  const handle = (e: AiStreamEvent) => {
    if (closed) return;
    if (e.kind === "delta" && e.text) {
      all += e.text;
      handlers.delta?.(e.text, all);
    } else if (e.kind === "done") {
      off();
      handlers.done?.(e, e.text ?? all);
    } else if (e.kind === "error") {
      off();
      handlers.error?.(e.error ?? "The model stopped unexpectedly.");
    }
  };
  const off = () => {
    closed = true;
    live.get(streamId)?.delete(handle);
  };
  const subs = live.get(streamId) ?? new Set();
  subs.add(handle);
  live.set(streamId, subs);
  const missed = buffered.get(streamId);
  buffered.delete(streamId);
  for (const e of missed?.events ?? []) handle(e);
  return off;
}
