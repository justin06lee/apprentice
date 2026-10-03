/**
 * App-wide state: where the reader is, settings, the library, toasts,
 * background jobs. Per-view state lives in the views.
 */
import { create } from "zustand";
import type { AiStatus, Book, Job, Settings } from "../../shared/types";
import { DEFAULT_SETTINGS } from "../../shared/types";
import { api, errorText, on } from "./api";

export type Route =
  | { name: "library" }
  | { name: "reader"; bookId: string; page?: number; blockId?: number; terms?: string[] }
  | { name: "review"; bookId?: string | null }
  | { name: "map"; bookId?: string | null; conceptId?: number }
  | { name: "settings" };

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error" | "success";
  action?: { label: string; run: () => void };
}

interface AppState {
  route: Route;
  /** Routes visited, for back. */
  history: Route[];
  settings: Settings;
  books: Book[];
  booksLoaded: boolean;
  ai: AiStatus | null;
  jobs: Job[];
  toasts: Toast[];
  palette: boolean;
  dueTotal: number;

  go(route: Route): void;
  back(): void;
  setSettings(patch: Partial<Settings>): Promise<void>;
  refreshBooks(): Promise<void>;
  refreshAi(refresh?: boolean): Promise<void>;
  toast(text: string, tone?: Toast["tone"], action?: Toast["action"]): void;
  dismiss(id: number): void;
  setPalette(open: boolean): void;
}

let toastSeq = 0;

export const useApp = create<AppState>((set, get) => ({
  route: { name: "library" },
  history: [],
  settings: DEFAULT_SETTINGS,
  books: [],
  booksLoaded: false,
  ai: null,
  jobs: [],
  toasts: [],
  palette: false,
  dueTotal: 0,

  go(route) {
    const cur = get().route;
    if (JSON.stringify(cur) === JSON.stringify(route)) return;
    set({ route, history: [...get().history.slice(-30), cur] });
  },
  back() {
    const h = get().history;
    const prev = h[h.length - 1];
    if (prev) set({ route: prev, history: h.slice(0, -1) });
    else set({ route: { name: "library" } });
  },
  async setSettings(patch) {
    set({ settings: { ...get().settings, ...patch } });
    try {
      set({ settings: await api.settings.set(patch) });
    } catch (e) {
      get().toast(errorText(e), "error");
    }
  },
  async refreshBooks() {
    const books = await api.books.list();
    set({ books, booksLoaded: true, dueTotal: books.reduce((s, b) => s + b.dueCards, 0) });
  },
  async refreshAi(refresh = false) {
    set({ ai: await api.ai.status(refresh) });
  },
  toast(text, tone = "info", action) {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts.slice(-3), { id, text, tone, ...(action ? { action } : {}) }] });
    setTimeout(() => get().dismiss(id), tone === "error" ? 8000 : 4500);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  setPalette(open) {
    set({ palette: open });
  },
}));

/** Wire main's events into the store once, at startup. */
export function connectStore(): void {
  const s = useApp;
  void api.settings.get().then((settings) => s.setState({ settings }));
  void s.getState().refreshBooks();
  void s.getState().refreshAi();
  void api.jobs.list().then((jobs) => s.setState({ jobs }));

  on("books.changed", (book) => {
    const books = s.getState().books;
    const i = books.findIndex((b) => b.id === book.id);
    const prev = books[i];
    const next = i >= 0 ? books.map((b) => (b.id === book.id ? book : b)) : [book, ...books];
    s.setState({ books: next, dueTotal: next.reduce((n, b) => n + b.dueCards, 0) });
    if (prev?.status === "importing" && book.status === "ready") {
      s.getState().toast(`“${book.title}” is ready to read.`, "success", {
        label: "Open",
        run: () => s.getState().go({ name: "reader", bookId: book.id }),
      });
    }
    if (prev?.status === "importing" && book.status === "error") s.getState().toast(`Could not import “${book.title}”: ${book.error ?? "unknown error"}`, "error");
  });
  on("books.removed", ({ id }) => {
    const next = s.getState().books.filter((b) => b.id !== id);
    s.setState({ books: next, dueTotal: next.reduce((n, b) => n + b.dueCards, 0) });
  });
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  on("cards.changed", () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void s.getState().refreshBooks(), 400);
  });
  on("jobs.changed", (job) => {
    const jobs = s.getState().jobs;
    const i = jobs.findIndex((j) => j.id === job.id);
    s.setState({ jobs: i >= 0 ? jobs.map((j) => (j.id === job.id ? job : j)) : [...jobs, job].slice(-20) });
    if (job.state === "error") s.getState().toast(`${job.label} failed: ${job.error ?? ""}`, "error");
  });
  on("app.open", ({ bookId }) => s.getState().go({ name: "reader", bookId }));
}
