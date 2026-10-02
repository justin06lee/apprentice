import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  base: "./",
  plugins: [react()],
  server: {
    port: 5280,
    strictPort: true,
  },
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
    target: "chrome140",
    // KaTeX's fonts are many small files; inlining them would bloat the
    // first paint for something only an answer with math ever needs.
    assetsInlineLimit: 0,
  },
});
