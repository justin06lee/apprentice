/**
 * Rasterize assets/apprentice.svg into every icon size the app needs, with
 * Chromium itself (run under Electron, no window shown), so the PNGs are
 * exactly what a browser draws from the SVG, filters and all.
 *
 *   electron scripts/render-icon.mjs --no-sandbox     (or: bun run icon)
 *
 *   build/icon.png              1024², what electron-builder packages
 *   build/icons/<n>x<n>.png     the Linux icon set
 */
import { execFileSync } from "node:child_process";
import { app, BrowserWindow } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(import.meta.dirname, "..");
const svg = fs.readFileSync(path.join(root, "assets", "apprentice.svg"));
const SIZES = [1024, 512, 256, 128, 64, 48, 32, 24, 16];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200 });
  await win.loadURL("data:text/html,<!doctype html><html><body></body></html>");
  const pngs = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(${JSON.stringify(SIZES)}.map((n) => {
        const c = document.createElement("canvas");
        c.width = c.height = n;
        const g = c.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(img, 0, 0, n, n);
        return c.toDataURL("image/png");
      }));
      img.onerror = reject;
      img.src = "data:image/svg+xml;base64,${svg.toString("base64")}";
    })
  `);
  fs.mkdirSync(path.join(root, "build", "icons"), { recursive: true });
  const files = [];
  SIZES.forEach((n, i) => {
    const data = Buffer.from(pngs[i].split(",")[1], "base64");
    files.push(path.join(root, "build", "icons", `${n}x${n}.png`));
    fs.writeFileSync(files[files.length - 1], data);
    if (n === 1024) {
      files.push(path.join(root, "build", "icon.png"));
      fs.writeFileSync(files[files.length - 1], data);
    }
  });
  // Chromium's encoder favors speed; recompress losslessly when ImageMagick
  // is around (about half the bytes, the same pixels).
  try {
    for (const f of files) execFileSync("convert", [f, "-define", "png:compression-level=9", f]);
  } catch {
    // not installed: the larger files are just as correct
  }
  console.log(`rendered ${SIZES.join(", ")} into build/`);
  app.quit();
});
