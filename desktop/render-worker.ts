/**
 * Draws original pages for the page view, on its own thread so that a
 * scroll through a scanned plate never stalls the window or an import.
 * Keeps the last few documents open; reopening a 40 MB PDF per page would
 * cost more than drawing it.
 */
import * as fs from "node:fs";
import { parentPort } from "node:worker_threads";
import type * as mupdf from "mupdf";
import { openPdf, renderPage } from "./ingest/pdf.js";

export type RenderRequest =
  | { id: number; kind: "page"; pdf: string; page: number; width: number }
  | { id: number; kind: "sizes"; pdf: string };

export type RenderReply =
  | { id: number; ok: true; data?: Uint8Array; sizes?: Array<[number, number]> }
  | { id: number; ok: false; error: string };

const open = new Map<string, mupdf.Document>();

function doc(pdf: string): mupdf.Document {
  let d = open.get(pdf);
  if (d) {
    open.delete(pdf);
    open.set(pdf, d);
    return d;
  }
  d = openPdf(fs.readFileSync(pdf));
  open.set(pdf, d);
  while (open.size > 3) {
    const [oldest, od] = open.entries().next().value as [string, mupdf.Document];
    od.destroy();
    open.delete(oldest);
  }
  return d;
}

parentPort!.on("message", (m: RenderRequest) => {
  try {
    const d = doc(m.pdf);
    if (m.kind === "sizes") {
      const sizes: Array<[number, number]> = [];
      for (let i = 0; i < d.countPages(); i++) {
        const p = d.loadPage(i);
        const [x0, y0, x1, y1] = p.getBounds();
        sizes.push([Math.round((x1 - x0) * 10) / 10, Math.round((y1 - y0) * 10) / 10]);
        p.destroy();
      }
      parentPort!.postMessage({ id: m.id, ok: true, sizes } satisfies RenderReply);
      return;
    }
    const page = d.loadPage(m.page);
    const [x0, , x1] = page.getBounds();
    const img = renderPage(page, m.width / Math.max(1, x1 - x0));
    page.destroy();
    parentPort!.postMessage({ id: m.id, ok: true, data: img.data } satisfies RenderReply, [img.data.buffer as ArrayBuffer]);
  } catch (error) {
    parentPort!.postMessage({ id: m.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies RenderReply);
  }
});
