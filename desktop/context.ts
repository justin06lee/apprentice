/**
 * What every part of the main process shares: the database, where things
 * live on disk, and the way back to the window.
 */
import * as path from "node:path";
import type { Events } from "../shared/api.js";
import type { PageText, Rect, Trim } from "../shared/pages.js";
import { DEFAULT_SETTINGS, type Settings } from "../shared/types.js";
import type { Db } from "./db.js";

export interface Ctx {
  db: Db;
  dataDir: string;
  dbPath: string;
  emit<E extends keyof Events>(event: E, payload: Events[E]): void;
  settings(): Settings;
  /** A book's pages, as the page renderer reads them. */
  pages: {
    text(bookId: string, page: number): Promise<PageText>;
    sizes(bookId: string): Promise<Array<[number, number]>>;
    /** Where the book's pages are printed, for trimming their margins. */
    trim(bookId: string): Promise<Trim | null>;
    /** A rectangle of a page as a PNG about `width` pixels wide. */
    region(bookId: string, page: number, rect: Rect, width: number): Promise<Uint8Array>;
  };
}

export function bookDir(ctx: Pick<Ctx, "dataDir">, bookId: string): string {
  return path.join(ctx.dataDir, "books", bookId);
}

export function loadSettings(db: Db): Settings {
  const rows = db.prepare("select key, value from settings").all() as Array<{ key: string; value: string }>;
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const { key, value } of rows) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    try {
      (out as unknown as Record<string, unknown>)[key] = JSON.parse(value);
    } catch {
      // a value that no longer parses falls back to the default
    }
  }
  return out;
}

export function saveSettings(db: Db, patch: Partial<Settings>): void {
  const put = db.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value");
  for (const [key, value] of Object.entries(patch)) {
    if (key in DEFAULT_SETTINGS && value !== undefined) put.run(key, JSON.stringify(value));
  }
}

/** Local calendar day, "2026-10-01". Reading time and "today" are the reader's days. */
export function today(at = Date.now()): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
