/**
 * apprentice's main process: the window, the database, the workers, and the
 * one IPC door the window talks through.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, shell } from "electron";
import type { Api, Events } from "../shared/api.js";
import type { Settings } from "../shared/types.js";
import { Ai } from "./ai.js";
import { bookDir, loadSettings, saveSettings, type Ctx } from "./context.js";
import { openDb } from "./db.js";
import { Knowledge } from "./knowledge/graph.js";
import { Library } from "./library.js";
import { PageRenderer } from "./render.js";
import { Sketches } from "./sketches.js";
import { Scheduler } from "./srs.js";

const here = import.meta.dirname;
const devUrl = process.env["APPRENTICE_DEV_URL"];

// Must happen before `ready`: apprentice:// serves covers, figures and
// rendered pages to the window, with fetch and streaming like https.
// app:// serves the window itself. A page loaded from file:// has an
// opaque origin, and Chromium will not start a module worker (the map's
// layout runs in one) for it; a standard, secure scheme is a real origin.
protocol.registerSchemesAsPrivileged([
  { scheme: "apprentice", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);
const APP_URL = "app://apprentice/index.html";

// A separate library, for trying things without touching the real one:
// APPRENTICE_DATA_DIR=… or --data-dir=…
const dataArg = process.argv.find((a) => a.startsWith("--data-dir="))?.slice("--data-dir=".length);
const dataOverride = dataArg ?? process.env["APPRENTICE_DATA_DIR"];
if (dataOverride) app.setPath("userData", path.resolve(dataOverride));
app.setName("apprentice");

/**
 * A desktop launch gets the session's PATH, set before anyone's shell rc
 * ran — no ~/.local/bin, which is where `claude` installs itself. The
 * common directories go on at once; the login shell's real PATH replaces
 * them when it answers, which is long before anyone asks a question.
 */
function fixPath(): void {
  const home = os.homedir();
  const extras = [path.join(home, ".local", "bin"), path.join(home, ".bun", "bin"), path.join(home, ".opencode", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const withExtras = (base: string) => {
    const cur = base.split(path.delimiter);
    return [...cur, ...extras.filter((d) => !cur.includes(d))].join(path.delimiter);
  };
  process.env["PATH"] = withExtras(process.env["PATH"] ?? "");
  const sh = process.env["SHELL"] ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  execFile(sh, ["-ilc", 'printf "__APP__%s__APP__" "$PATH"'], { encoding: "utf8", timeout: 5000 }, (error, stdout) => {
    if (error) return;
    const m = /__APP__(.*)__APP__/s.exec(stdout);
    if (m?.[1]) process.env["PATH"] = withExtras(m[1]);
  });
}

function pdfArgs(argv: string[]): string[] {
  return argv.slice(process.defaultApp ? 2 : 1).filter((a) => /\.pdf$/i.test(a) && fs.existsSync(a)).map((a) => path.resolve(a));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  fixPath();
  await app.whenReady();

  const dataDir = app.getPath("userData");
  fs.mkdirSync(path.join(dataDir, "books"), { recursive: true });
  const dbPath = path.join(dataDir, "apprentice.db");
  const db = openDb(dbPath);
  let settings = loadSettings(db);

  let win: BrowserWindow | null = null;
  const ctx: Ctx = {
    db,
    dataDir,
    dbPath,
    emit<E extends keyof Events>(event: E, payload: Events[E]) {
      if (win && !win.isDestroyed()) win.webContents.send("event", event, payload);
    },
    settings: () => settings,
  };

  const srs = new Scheduler(ctx);
  const knowledge = new Knowledge(ctx, srs);
  const ai = new Ai(ctx, srs, knowledge);
  const library = new Library(ctx, path.join(here, "ingest-worker.mjs"), (bookId, unitId) => void ai.onUnitRead(bookId, unitId));
  const sketches = new Sketches(ctx);
  const pages = new PageRenderer(path.join(here, "render-worker.mjs"));

  // ── apprentice:// ────────────────────────────────────────────────────
  const types: Record<string, string> = { ".jpg": "image/jpeg", ".png": "image/png" };
  const immutable = { "cache-control": "public, max-age=31536000, immutable" };
  protocol.handle("apprentice", async (request) => {
    try {
      const url = new URL(request.url);
      const [id, kind, name] = url.pathname.replace(/^\/+/, "").split("/");
      if (url.host !== "book" || !id || !/^[a-z0-9]+$/.test(id)) return new Response(null, { status: 404 });
      const dir = bookDir(ctx, id);
      if (kind === "cover.jpg" || (kind === "assets" && name && /^\d+\.(png|jpg)$/.test(name))) {
        const file = kind === "assets" ? path.join(dir, "assets", name!) : path.join(dir, "cover.jpg");
        const data = await fs.promises.readFile(file);
        return new Response(data, { headers: { "content-type": types[path.extname(file)]!, ...immutable } });
      }
      if (kind === "page" && name && /^\d+$/.test(name)) {
        const width = Math.max(200, Math.min(3200, Math.round(Number(url.searchParams.get("w") || 1000) / 100) * 100));
        const data = await pages.page(path.join(dir, "source.pdf"), path.join(dir, "pages"), Number(name), width);
        return new Response(data, { headers: { "content-type": "image/jpeg", ...immutable } });
      }
      return new Response(null, { status: 404 });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  const webRoot = path.join(here, "..", "dist-web");
  const webTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json",
    ".wasm": "application/wasm",
  };
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(webRoot, rel);
    if (url.host !== "apprentice" || !file.startsWith(webRoot + path.sep)) return new Response(null, { status: 404 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { "content-type": webTypes[path.extname(file)] ?? "application/octet-stream" } });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  // ── the API ──────────────────────────────────────────────────────────
  type Handlers = {
    [K in keyof Api]: {
      [M in keyof Api[K]]: Api[K][M] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : never;
    };
  };
  const unlock = (unitId: number) => srs.unlockUnit(unitId);
  const handlers: Handlers = {
    books: {
      list: () => library.list(),
      import: async (paths) => {
        let files = paths ?? [];
        if (!files.length) {
          const r = await dialog.showOpenDialog(win!, {
            title: "Add textbooks",
            properties: ["openFile", "multiSelections"],
            filters: [{ name: "PDF", extensions: ["pdf"] }],
          });
          if (r.canceled) return [];
          files = r.filePaths;
        }
        return library.importFiles(files);
      },
      open: (id) => library.open(id),
      remove: (id) => library.remove(id),
      rename: (id, title) => library.rename(id, title),
      reveal: (id) => shell.showItemInFolder(library.sourcePath(id)),
      retry: (id) => library.retry(id),
    },
    reader: {
      unit: (bookId, unitId) => library.unit(bookId, unitId),
      savePosition: (bookId, position) => library.savePosition(bookId, position),
      markRead: (bookId, unitId, reads) => library.markRead(bookId, unitId, reads, unlock),
      markUnit: (bookId, unitId, read) => library.markUnit(bookId, unitId, read, unlock),
      addTime: (bookId, ms) => library.addTime(bookId, ms),
      search: (query, bookId) => library.search(query, bookId),
      locate: (blockId) => library.locate(blockId),
      pageSizes: (bookId) => pages.pageSizes(library.sourcePath(bookId)),
    },
    blocks: {
      edit: (blockId, text, source) => library.editBlock(blockId, text, source),
    },
    highlights: {
      add: (input) => library.addHighlight(input),
      update: (id, patch) => library.updateHighlight(id, patch),
      remove: (id) => library.removeHighlight(id),
      list: (bookId) => library.highlights(bookId),
    },
    sketches: {
      list: (bookId) => sketches.list(bookId),
      get: (id) => sketches.get(id),
      save: (input) => sketches.save(input),
      remove: (id) => sketches.remove(id),
    },
    cards: {
      queue: (bookId, limit) => srs.queue(bookId, limit),
      review: (cardId, rating, durationMs) => srs.review(cardId, rating, durationMs),
      undo: (cardId) => srs.undo(cardId),
      create: (input) => srs.create(input),
      update: (id, patch) => srs.update(id, patch),
      remove: (id) => srs.remove(id),
      list: (bookId, unitId) => srs.list(bookId, unitId),
      stats: (bookId) => srs.stats(bookId),
    },
    knowledge: {
      graph: (bookId) => knowledge.graph(bookId),
      concept: (id) => knowledge.concept(id),
      unit: (unitId) => knowledge.unit(unitId),
    },
    ai: {
      status: (refresh) => ai.status(refresh),
      ask: (input) => ai.ask(input),
      rewrite: (input) => ai.rewrite(input),
      cancel: (streamId) => ai.cancel(streamId),
      generateCards: (bookId, unitId) => ai.generateCards(bookId, unitId),
      mapConcepts: (bookId, unitId) => ai.mapConcepts(bookId, unitId),
      suggestCard: (input) => ai.suggestCard(input),
    },
    chats: {
      list: (bookId) => ai.threads(bookId),
      messages: (threadId) => ai.messages(threadId),
      remove: (threadId) => ai.removeThread(threadId),
    },
    settings: {
      get: () => settings,
      set: (patch: Partial<Settings>) => {
        saveSettings(db, patch);
        settings = loadSettings(db);
        if (patch.theme) nativeTheme.themeSource = patch.theme === "system" ? "system" : patch.theme === "dark" ? "dark" : "light";
        return settings;
      },
    },
    jobs: {
      list: () => ai.listJobs(),
    },
  };

  ipcMain.handle("rpc", async (event, method: string, args: unknown[]) => {
    if (event.senderFrame && !isOurs(event.senderFrame.url)) throw new Error("Refused: not apprentice's window.");
    const [ns, fn] = method.split(".") as [keyof Handlers, string];
    const group = handlers[ns] as Record<string, (...a: unknown[]) => unknown> | undefined;
    const f = group?.[fn];
    if (typeof f !== "function") throw new Error(`No such call: ${method}`);
    return f(...(args ?? []));
  });

  function isOurs(url: string): boolean {
    return devUrl ? url.startsWith(devUrl) : url.startsWith("app://apprentice/");
  }

  // ── the window ───────────────────────────────────────────────────────
  nativeTheme.themeSource = settings.theme === "system" ? "system" : settings.theme === "dark" ? "dark" : "light";
  const background = () => {
    const t = settings.theme === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : settings.theme;
    return t === "dark" ? "#16161a" : t === "sepia" ? "#f4ecd8" : "#fbfaf7";
  };

  // The window comes back where it was left.
  const boundsFile = path.join(dataDir, "window.json");
  const saved = (() => {
    try {
      const b = JSON.parse(fs.readFileSync(boundsFile, "utf8")) as { x?: number; y?: number; width: number; height: number; maximized?: boolean };
      return b.width > 400 && b.height > 300 ? b : null;
    } catch {
      return null;
    }
  })();

  const createWindow = () => {
    win = new BrowserWindow({
      width: saved?.width ?? 1440,
      height: saved?.height ?? 940,
      ...(saved?.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
      minWidth: 880,
      minHeight: 560,
      show: false,
      title: "apprentice",
      backgroundColor: background(),
      autoHideMenuBar: true,
      ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 18 } } : {}),
      webPreferences: {
        preload: path.join(here, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    win.once("ready-to-show", () => {
      if (saved?.maximized) win?.maximize();
      win?.show();
    });
    const remember = () => {
      if (!win || win.isDestroyed()) return;
      const b = win.getNormalBounds();
      fs.writeFile(boundsFile, JSON.stringify({ ...b, maximized: win.isMaximized() }), () => {});
    };
    let boundsTimer: ReturnType<typeof setTimeout> | null = null;
    const later = () => {
      if (boundsTimer) clearTimeout(boundsTimer);
      boundsTimer = setTimeout(remember, 500);
    };
    win.on("resize", later);
    win.on("move", later);
    win.on("close", remember);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
      if (!isOurs(url)) {
        e.preventDefault();
        if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      }
    });
    if (devUrl) void win.loadURL(devUrl);
    else void win.loadURL(APP_URL);
    win.on("closed", () => {
      win = null;
    });
  };

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );

  createWindow();
  library.resume();
  void ai.status();

  const openPdfs = (files: string[]) => {
    if (!files.length) return;
    const ids = library.importFiles(files);
    if (ids[0]) ctx.emit("app.open", { bookId: ids[0] });
  };
  win!.webContents.once("did-finish-load", () => openPdfs(pdfArgs(process.argv)));
  app.on("second-instance", (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    openPdfs(pdfArgs(argv));
  });
  app.on("open-file", (e, file) => {
    e.preventDefault();
    openPdfs([file]);
  });
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("will-quit", () => {
    pages.stop();
    try {
      db.close();
    } catch {
      // already closed
    }
  });
}
