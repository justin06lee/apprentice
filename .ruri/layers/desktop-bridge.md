# apprentice — Desktop bridge

One layer of apprentice's stack, owning `desktop/main.ts, desktop/preload.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer desktop-bridge` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer desktop-bridge add|set|drop <section> …`. Where it and the code disagree, the code is right.

The Electron main process owns the window, database, workers, desktop services, and a single IPC door for the renderer. The preload exposes only an RPC call, an event stream, dropped-file paths, and the platform. Keep that boundary in mind when changing what the window can access.

## Where to change what

- **Window and desktop startup:** desktop/main.ts
- **Renderer API and events:** desktop/main.ts, desktop/preload.ts
- **Dropped-file paths:** desktop/preload.ts
- **App and asset protocols:** desktop/main.ts

## How it works

- **Renderer RPC:** The window calls the API exposed by desktop/preload.ts → The preload invokes the rpc IPC channel → desktop/main.ts handles the call through its IPC door
- **Main-process events:** desktop/main.ts sends an event → desktop/preload.ts receives it on the event IPC channel → The preload calls the registered listener and provides a way to remove it

## Key files

- desktop/main.ts — creates the window and connects IPC to the database, workers, and desktop services
- desktop/preload.ts — exposes the window's limited main-process API

## Rules and traps

- Register the apprentice:// and app:// protocols before Electron is ready.
- The app:// window origin allows Chromium to start the map's module worker; file:// has an opaque origin.
- Remove an event listener through the cleanup function returned by onEvent.

## What it talks to

- IPC contract — desktop/main.ts imports the shared Api and Events types
- App shell — desktop/preload.ts exposes the API used by the window
- Library and storage — desktop/main.ts opens the database and connects library and sketch services
- PDF import and rendering — desktop/main.ts connects the page renderer
- Learning and AI services — desktop/main.ts connects scheduling, knowledge, and AI services
