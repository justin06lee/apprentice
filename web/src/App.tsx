/**
 * The shell: a slim rail on the left, the current view beside it, and the
 * things that float over everything — the command palette, toasts, the
 * drop target for new books.
 */
import { GraduationCap, LibraryBig, Settings as SettingsIcon, Upload, Waypoints } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { api, errorText, pathForFile } from "./api";
import { Toasts } from "./components/ui";
import { mod } from "./lib/format";
import { useApp, type Route } from "./store";
import { CommandPalette } from "./views/CommandPalette";
import { Library } from "./views/library/Library";
import { Reader } from "./views/reader/Reader";

const Review = lazy(() => import("./views/review/Review").then((m) => ({ default: m.Review })));
const KnowledgeMap = lazy(() => import("./views/map/KnowledgeMap").then((m) => ({ default: m.KnowledgeMap })));
const Settings = lazy(() => import("./views/settings/Settings").then((m) => ({ default: m.Settings })));

function useTheme() {
  const settings = useApp((s) => s.settings);
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme = settings.theme === "system" ? (media.matches ? "dark" : "light") : settings.theme;
      root.dataset["theme"] = theme;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.theme]);
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--reader-size", `${settings.fontSize}px`);
    root.setProperty("--reader-leading", String(settings.lineHeight));
    root.setProperty("--reader-measure", `${settings.measure}ch`);
    root.setProperty("--reader-font", settings.readerFont === "serif" ? "var(--font-serif)" : "var(--font-ui)");
  }, [settings.fontSize, settings.lineHeight, settings.measure, settings.readerFont]);
}

function Rail() {
  const route = useApp((s) => s.route);
  const go = useApp((s) => s.go);
  const due = useApp((s) => s.dueTotal);
  const item = (name: Route["name"], label: string, icon: React.ReactNode, target: Route, hint: string, badge?: number) => (
    <button
      className={`rail-btn ${route.name === name || (name === "library" && route.name === "reader") ? "on" : ""}`}
      onClick={() => go(target)}
      title={`${label}  ${hint}`}
      aria-label={label}
    >
      {icon}
      {badge ? <span className="rail-badge">{badge > 99 ? "99+" : badge}</span> : null}
    </button>
  );
  return (
    <nav className="rail">
      <div className="rail-mark" title="apprentice">
        <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden>
          <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--ink)" />
          <path d="M9.5 22.5 15.2 9.2c.3-.7 1.3-.7 1.6 0l5.7 13.3M11.8 17.6h8.4" stroke="var(--paper)" strokeWidth="2.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      {item("library", "Library", <LibraryBig size={19} />, { name: "library" }, `${mod}1`)}
      {item("review", "Review", <GraduationCap size={19} />, { name: "review" }, `${mod}2`, due)}
      {item("map", "Knowledge map", <Waypoints size={19} />, { name: "map" }, `${mod}3`)}
      <div style={{ flex: 1 }} />
      <Jobs />
      {item("settings", "Settings", <SettingsIcon size={19} />, { name: "settings" }, `${mod},`)}
    </nav>
  );
}

/** Background AI work in progress: a quiet spinner, its list on hover. */
function Jobs() {
  const all = useApp((s) => s.jobs);
  const jobs = all.filter((j) => j.state === "running");
  if (!jobs.length) return null;
  return (
    <div className="rail-jobs" tabIndex={0} aria-label={`${jobs.length} background tasks`}>
      <span className="spinner" />
      <div className="rail-jobs-list">
        {jobs.map((j) => (
          <div key={j.id}>{j.label}…</div>
        ))}
      </div>
    </div>
  );
}

function DropTarget() {
  const [over, setOver] = useState(false);
  const toast = useApp((s) => s.toast);
  const go = useApp((s) => s.go);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const overFn = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /\.pdf$/i.test(f.name));
      if (!files.length) {
        toast("apprentice reads PDF textbooks — that wasn't a PDF.", "error");
        return;
      }
      try {
        const ids = await api.books.import(files.map(pathForFile));
        go({ name: "library" });
        if (ids.length) toast(files.length === 1 ? `Adding “${files[0]!.name.replace(/\.pdf$/i, "")}”…` : `Adding ${files.length} books…`);
      } catch (err) {
        toast(errorText(err), "error");
      }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overFn);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overFn);
      window.removeEventListener("drop", drop);
    };
  }, [toast, go]);
  if (!over) return null;
  return (
    <div className="drop-target">
      <div className="drop-card">
        <Upload size={28} />
        <strong>Drop to add to your library</strong>
        <span className="muted">PDF textbooks are read, structured and mapped as they come in.</span>
      </div>
    </div>
  );
}

export function App() {
  useTheme();
  const route = useApp((s) => s.route);
  const go = useApp((s) => s.go);
  const setPalette = useApp((s) => s.setPalette);
  const palette = useApp((s) => s.palette);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const m = e.metaKey || e.ctrlKey;
      if (!m) return;
      if (e.key === "k" || (e.key === "p" && !e.shiftKey)) {
        e.preventDefault();
        setPalette(!useApp.getState().palette);
      } else if (e.key === "1") {
        e.preventDefault();
        go({ name: "library" });
      } else if (e.key === "2") {
        e.preventDefault();
        go({ name: "review" });
      } else if (e.key === "3") {
        e.preventDefault();
        go({ name: "map" });
      } else if (e.key === ",") {
        e.preventDefault();
        go({ name: "settings" });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [go, setPalette]);

  return (
    <div className="app">
      <Rail />
      <main className="view">
        <Suspense fallback={<div className="view-loading" />}>
          {route.name === "library" && <Library />}
          {route.name === "reader" && <Reader key={route.bookId} bookId={route.bookId} unitId={route.unitId} blockId={route.blockId} />}
          {route.name === "review" && <Review bookId={route.bookId ?? null} />}
          {route.name === "map" && <KnowledgeMap bookId={route.bookId ?? null} conceptId={route.conceptId ?? null} />}
          {route.name === "settings" && <Settings />}
        </Suspense>
      </main>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      <DropTarget />
      <Toasts />
    </div>
  );
}
