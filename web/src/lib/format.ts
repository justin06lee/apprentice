export function duration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export function ago(at: number): string {
  const s = (Date.now() - at) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function percent(x: number): string {
  if (x > 0 && x < 0.01) return "<1%";
  return `${Math.round(x * 100)}%`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Strip {{c1::…}} to its answer, or blank it. */
export function cloze(text: string, reveal: boolean): string {
  return text.replace(/\{\{c\d+::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (_, answer: string, hint?: string) =>
    reveal ? `⟦${answer}⟧` : `⟦${hint ? `${hint}` : "…"}⟧`,
  );
}

export const isMac = navigator.platform.toLowerCase().includes("mac");
export const mod = isMac ? "⌘" : "Ctrl";
