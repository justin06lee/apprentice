/**
 * Bundle everything that runs outside the renderer into dist-electron/.
 *
 *   main.mjs            the Electron main process: window, database, IPC,
 *                       yagami, scheduling
 *   preload.cjs         the bridge the renderer talks through (a sandboxed
 *                       preload has to be CommonJS)
 *   ingest-worker.mjs   PDF → blocks, run once per import on its own thread
 *   render-worker.mjs   original-page rendering, kept warm for the page view
 *
 * Bundling means the packaged app ships no node_modules. The one file that
 * cannot be bundled is MuPDF's WebAssembly, which its loader looks for
 * beside whichever module imported it — so it is copied in beside the
 * workers.
 *
 *   bun scripts/build-main.ts           build once
 *   bun scripts/build-main.ts --watch   rebuild on change (used by `dev`)
 */
import { context, build, type BuildOptions } from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(import.meta.dirname, "..");
const out = path.join(root, "dist-electron");
const watch = process.argv.includes("--watch");

const esm: BuildOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  external: ["electron"],
  logLevel: "info",
  // Bundled CommonJS dependencies still call `require`, which ESM lacks.
  banner: {
    js: 'import { createRequire as __apprenticeRequire } from "node:module"; const require = __apprenticeRequire(import.meta.url);',
  },
};

const targets: BuildOptions[] = [
  { ...esm, entryPoints: [path.join(root, "desktop", "main.ts")], outfile: path.join(out, "main.mjs") },
  {
    ...esm,
    entryPoints: [path.join(root, "desktop", "ingest", "worker.ts")],
    outfile: path.join(out, "ingest-worker.mjs"),
  },
  {
    ...esm,
    entryPoints: [path.join(root, "desktop", "render-worker.ts")],
    outfile: path.join(out, "render-worker.mjs"),
  },
  {
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    logLevel: "info",
    entryPoints: [path.join(root, "desktop", "preload.ts")],
    outfile: path.join(out, "preload.cjs"),
  },
];

fs.mkdirSync(out, { recursive: true });
const wasm = path.join(root, "node_modules", "mupdf", "dist", "mupdf-wasm.wasm");
fs.copyFileSync(wasm, path.join(out, "mupdf-wasm.wasm"));

if (watch) {
  for (const options of targets) await (await context(options)).watch();
  console.log("watching desktop/ and shared/");
} else {
  await Promise.all(targets.map((options) => build(options)));
}
