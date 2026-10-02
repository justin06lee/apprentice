/**
 * Development: Vite for the window (with hot reload), esbuild watching the
 * main process and workers, and Electron pointed at Vite. Restart the app
 * (Ctrl+C, `bun run dev`) after changing desktop/ code; the window reloads
 * itself.
 *
 *   bun run dev                       your real library
 *   bun run dev -- --data-dir=/tmp/x  a scratch one
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(import.meta.dirname, "..");
const url = "http://localhost:5280";
const children: ChildProcess[] = [];
const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  const child = spawn(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  children.push(child);
  return child;
};
const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

run("bun", ["scripts/build-main.ts", "--watch"]);
run("bunx", ["vite"]);

// Wait for both: the main bundle on disk, and Vite answering.
const main = path.join(root, "dist-electron", "main.mjs");
for (let i = 0; i < 300; i++) {
  const ready = fs.existsSync(main) && (await fetch(url).then(() => true, () => false));
  if (ready) break;
  await new Promise((r) => setTimeout(r, 200));
}

// Ubuntu 23.10+ gives Chromium's sandbox its namespaces only by AppArmor
// profile, which `make install` writes for the installed app — not for the
// development binary in node_modules.
const restricted = (() => {
  try {
    return fs.readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1";
  } catch {
    return false;
  }
})();
const electron = path.join(root, "node_modules", "electron", "dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron");
const app = run(electron, [".", ...(restricted ? ["--no-sandbox"] : []), ...process.argv.slice(2)], { APPRENTICE_DEV_URL: url });
app.on("exit", stop);
