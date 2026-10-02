/**
 * The window's handle on the main process. `api.books.list()` and friends
 * are a proxy over one IPC call named by the dotted path; `on()` subscribes
 * to the events main sends back.
 */
import type { Api, Events, Remote } from "../../shared/api";

interface Bridge {
  call(method: string, args: unknown[]): Promise<unknown>;
  onEvent(listener: (name: string, payload: unknown) => void): () => void;
  pathForFile(file: File): string;
  platform: string;
}

declare global {
  interface Window {
    apprentice: Bridge;
  }
}

const bridge = window.apprentice;

function proxy(path: string[]): unknown {
  return new Proxy(() => {}, {
    get: (_t, key) => (typeof key === "string" ? proxy([...path, key]) : undefined),
    apply: (_t, _this, args: unknown[]) => bridge.call(path.join("."), args),
  });
}

export const api = proxy([]) as Remote<Api>;

type Listener<E extends keyof Events> = (payload: Events[E]) => void;
const listeners = new Map<keyof Events, Set<Listener<keyof Events>>>();

bridge.onEvent((name, payload) => {
  const set = listeners.get(name as keyof Events);
  if (set) for (const l of set) l(payload as Events[keyof Events]);
});

export function on<E extends keyof Events>(event: E, listener: Listener<E>): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(listener as Listener<keyof Events>);
  return () => set!.delete(listener as Listener<keyof Events>);
}

export const platform = bridge.platform;
export const pathForFile = (file: File) => bridge.pathForFile(file);

export function assetUrl(bookId: string, asset: string): string {
  return `apprentice://book/${bookId}/assets/${asset}`;
}

export function pageUrl(bookId: string, page: number, width: number): string {
  return `apprentice://book/${bookId}/page/${page}?w=${Math.round(width / 100) * 100}`;
}

/** Errors from main arrive as "Error invoking remote method 'rpc': Error: …"; keep the message. */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
