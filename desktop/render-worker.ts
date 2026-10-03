/**
 * Everything the page view needs from the PDF itself, on its own thread so
 * that drawing a scanned plate never stalls the window or an import: page
 * pictures, page sizes, each page's text layer, and cut-out regions for a
 * model to look at. Keeps the last few documents open; reopening a 40 MB
 * PDF per page would cost more than drawing it.
 */
import * as fs from "node:fs";
import { parentPort } from "node:worker_threads";
import type * as mupdf from "mupdf";
import type { PageText, Rect, Trim } from "../shared/pages.js";
import { Extractor } from "./ingest/extract.js";
import { bookTrim, pageText } from "./ingest/pagetext.js";
import { openPdf, renderPage, renderRegion } from "./ingest/pdf.js";

export type RenderRequest =
  | { id: number; kind: "page"; pdf: string; page: number; width: number }
  | { id: number; kind: "sizes"; pdf: string }
  | { id: number; kind: "text"; pdf: string; page: number }
  | { id: number; kind: "trim"; pdf: string }
  | { id: number; kind: "region"; pdf: string; page: number; rect: Rect; width: number };

export type RenderReply =
  | { id: number; ok: true; data?: Uint8Array; sizes?: Array<[number, number]>; text?: PageText; trim?: Trim | null }
  | { id: number; ok: false; error: string };

interface Open {
  doc: mupdf.Document;
  /** One per document: it learns the document's fonts as it goes. */
  ex: Extractor;
}

const open = new Map<string, Open>();

function doc(pdf: string): Open {
  let d = open.get(pdf);
  if (d) {
    open.delete(pdf);
    open.set(pdf, d);
    return d;
  }
  const opened = openPdf(fs.readFileSync(pdf));
  d = { doc: opened, ex: new Extractor(opened, true) };
  open.set(pdf, d);
  while (open.size > 3) {
    const [oldest, od] = open.entries().next().value as [string, Open];
    od.doc.destroy();
    open.delete(oldest);
  }
  return d;
}

parentPort!.on("message", (m: RenderRequest) => {
  try {
    const { doc: d, ex } = doc(m.pdf);
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
    if (m.kind === "trim") {
      parentPort!.postMessage({ id: m.id, ok: true, trim: bookTrim(ex, d.countPages()) } satisfies RenderReply);
      return;
    }
    if (m.kind === "text") {
      parentPort!.postMessage({ id: m.id, ok: true, text: pageText(ex, m.page) } satisfies RenderReply);
      return;
    }
    const page = d.loadPage(m.page);
    const [x0, y0, x1] = page.getBounds();
    let img: { data: Uint8Array };
    if (m.kind === "region") {
      // The rectangle is page-relative; the page may not start at the origin.
      const [a, b, c, e] = m.rect;
      const scale = Math.min(4, m.width / Math.max(1, c - a));
      img = renderRegion(page, [a + x0, b + y0, c + x0, e + y0], scale, "png");
    } else img = renderPage(page, m.width / Math.max(1, x1 - x0));
    page.destroy();
    parentPort!.postMessage({ id: m.id, ok: true, data: img.data } satisfies RenderReply, [img.data.buffer as ArrayBuffer]);
  } catch (error) {
    parentPort!.postMessage({ id: m.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies RenderReply);
  }
});
