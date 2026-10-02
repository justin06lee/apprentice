# apprentice — Build and tooling

One layer of apprentice's stack, owning `scripts/, Makefile, package.json, bun.lock, tsconfig.json, desktop/test/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer build-tooling` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer build-tooling add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer runs development, bundles Electron code and workers, generates icons, and provides tools for inspecting PDF imports and supporting Linux installs. Bun drives the scripts; esbuild builds code outside the renderer while Vite serves the development window. A newcomer should know that renderer reloads automatically in development, but changes to desktop code require an app restart.

## Where to change what

- **Electron bundle and workers:** scripts/build-main.ts
- **Development startup:** scripts/dev.ts, scripts/build-main.ts
- **PDF parser inspection:** scripts/parse.ts
- **App icon:** scripts/icon.ts, scripts/render-icon.mjs
- **Linux sandbox setup:** scripts/apparmor.sh

## How it works

- **Development startup:** scripts/dev.ts starts the esbuild watcher → It starts Vite → It waits for the main bundle and Vite → It starts Electron pointed at Vite
- **Icon generation:** scripts/icon.ts writes the SVG → scripts/render-icon.mjs rasterizes it with Electron → The PNGs supply the packaged icon and Linux icon sizes

## Key files

- scripts/build-main.ts — bundles Electron main, preload, and workers into dist-electron and copies MuPDF WASM beside the workers
- scripts/dev.ts — starts the development watchers and Electron
- scripts/parse.ts — runs the PDF parser on a file and prints results without changing the library
- scripts/icon.ts — generates the app icon SVG
- scripts/render-icon.mjs — renders the SVG into packaged PNG icon sizes
- scripts/apparmor.sh — installs a Linux AppArmor profile that permits the Electron sandbox to start

## Rules and traps

- The sandboxed preload must be CommonJS.
- MuPDF WASM must sit beside the workers because its loader looks beside the importing module.
- Restart the development app after desktop code changes; window changes reload automatically.
- Keep the Electron sandbox enabled when addressing Linux startup failures.

## What it talks to

- App shell — Vite serves the renderer during development.
- Desktop bridge — esbuild bundles main and preload.
- PDF import and rendering — esbuild bundles workers, and the parser inspection script calls ingestion code.
- Desktop runtime — Electron runs the development app and rasterizes icons.
