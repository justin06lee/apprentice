# apprentice — App shell

One layer of apprentice's stack, owning `web/index.html, web/src/App.tsx, web/src/main.tsx, web/src/api.ts, web/src/store.ts, web/src/components/, web/src/lib/, web/src/styles/, web/src/views/CommandPalette.tsx, web/src/views/library/, web/src/views/settings/, vite.config.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer app-shell` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer app-shell add|set|drop <section> …`. Where it and the code disagree, the code is right.

The app shell mounts the React app, selects the current view, and owns navigation, library, settings, overlays, and app-wide state. Zustand holds routes, books, settings, jobs, and toasts; view-specific state stays in the views. Shared UI and CSS tokens give the screens a consistent interface.

## Where to change what

- **Navigation and view switching:** web/src/App.tsx, web/src/store.ts
- **Library and book imports:** web/src/views/library/Library.tsx, web/src/store.ts, web/src/styles/library.css
- **Settings and themes:** web/src/views/settings/Settings.tsx, web/src/App.tsx, web/src/styles/settings.css, web/src/styles/base.css
- **Command palette and search:** web/src/views/CommandPalette.tsx, web/src/App.tsx
- **Shared dialogs, popovers, and toasts:** web/src/components/ui.tsx, web/src/store.ts
- **Renderer API access:** web/src/api.ts, web/src/store.ts
- **Shell layout and screen styling:** web/src/styles/app.css, web/src/styles/base.css
- **PDF page layout helpers:** web/src/lib/pages.ts

## How it works

- **Navigation:** A rail or palette action calls the store's navigation method. → The store updates the route and history. → App renders the selected view.
- **App state updates:** A view calls a store action. → The action uses the renderer API where needed. → Zustand updates shared state and subscribed UI renders.

## Key files

- web/src/App.tsx — shell layout, route rendering, theme application, and overlays
- web/src/store.ts — app-wide Zustand state and navigation
- web/src/api.ts — renderer API access and error helpers
- web/src/views/library/Library.tsx — book shelf, progress, and import controls
- web/src/views/settings/Settings.tsx — reading, AI, and review settings
- web/src/views/CommandPalette.tsx — actions, navigation, and passage search
- web/src/components/ui.tsx — shared popovers, modals, toasts, rings, and switches
- web/src/styles/base.css — theme tokens and base design system
- web/src/styles/app.css — rail, view, and overlay layout
- web/src/main.tsx — React entry point

## Rules and traps

- Keep app-wide state in web/src/store.ts; per-view state belongs in its view.
- Shared components draw their colors and measurements from the tokens in web/src/styles/base.css.
- Draggable window regions need interactive controls marked as no-drag.
- Route changes must account for the store's history used by back navigation.

## What it talks to

- Reader — App renders the reader route; the palette uses reader state and search presentation; page layout helpers support PDF reading.
- Study tools — App renders review; shared styles cover panels and review screens.
- Visual canvases — App renders the knowledge map; shared styles cover map and sketch screens.
- IPC contract — store and API access use shared book, settings, job, and status types.
- Desktop bridge — renderer API calls reach desktop services through the exposed bridge.
