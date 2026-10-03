/**
 * The MuPDF calls shared by import and the page view: opening a document,
 * reading its outline, and rendering a page or a region of one.
 */
import * as mupdf from "mupdf";
import type { OutlineEntry } from "./analyze.js";
import type { Rect } from "./extract.js";

mupdf.setLog({
  // MuPDF narrates every font substitution and broken xref it recovers
  // from. Those are its business; failures surface as exceptions.
  warning() {},
  error() {},
});

export function openPdf(data: Uint8Array): mupdf.Document {
  const doc = mupdf.Document.openDocument(data, "application/pdf");
  if (doc.needsPassword()) throw new Error("This PDF is password-protected.");
  return doc;
}

export function readOutline(doc: mupdf.Document): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  let items: ReturnType<mupdf.Document["loadOutline"]> = null;
  try {
    items = doc.loadOutline();
  } catch {
    return out;
  }
  const walk = (list: NonNullable<typeof items>, level: number) => {
    for (const item of list) {
      let page = item.page;
      if ((page === undefined || page < 0) && item.uri) {
        try {
          page = doc.resolveLink(item.uri);
        } catch {
          page = undefined;
        }
      }
      const title = (item.title ?? "").replace(/\s+/g, " ").trim();
      if (title && page !== undefined && page >= 0) out.push({ title, level, page });
      if (item.down) walk(item.down, level + 1);
    }
  };
  if (items) walk(items, 1);
  return out;
}

export function meta(doc: mupdf.Document): { title: string | null; author: string | null } {
  const get = (key: string) => {
    try {
      const v = doc.getMetaData(key)?.trim();
      return v && !/^(untitled|microsoft word|unknown)/i.test(v) ? v : null;
    } catch {
      return null;
    }
  };
  return { title: get("info:Title"), author: get("info:Author") };
}

/**
 * Render a rectangle of a page — a figure or an equation for a model to
 * look at. Only that rectangle is rasterized, so a small region costs a
 * small pixmap no matter how big the page is.
 */
export function renderRegion(page: mupdf.Page, bbox: Rect, scale: number, format: "png" | "jpeg"): { data: Uint8Array; width: number; height: number } {
  const box: Rect = [Math.floor(bbox[0] * scale), Math.floor(bbox[1] * scale), Math.ceil(bbox[2] * scale), Math.ceil(bbox[3] * scale)];
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, box, false);
  // clear() with a value paints it opaque; with none, fully transparent.
  pixmap.clear(255);
  const device = new mupdf.DrawDevice(mupdf.Matrix.scale(scale, scale), pixmap);
  page.run(device, mupdf.Matrix.identity);
  device.close();
  device.destroy();
  const data = format === "png" ? pixmap.asPNG() : pixmap.asJPEG(86);
  const out = { data: new Uint8Array(data), width: pixmap.getWidth(), height: pixmap.getHeight() };
  pixmap.destroy();
  return out;
}

/** A whole page, as the page view shows it. Text is most of what is on it, so the JPEG is kept fine. */
export function renderPage(page: mupdf.Page, scale: number): { data: Uint8Array; width: number; height: number } {
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  const data = pixmap.asJPEG(90);
  const out = { data: new Uint8Array(data), width: pixmap.getWidth(), height: pixmap.getHeight() };
  pixmap.destroy();
  return out;
}
