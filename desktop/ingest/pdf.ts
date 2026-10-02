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
 * Render a rectangle of a page. Only that rectangle is rasterized, so a
 * small equation costs a small pixmap no matter how big the page is.
 * `transparent` leaves the background clear, which lets the reader recolor
 * math for a dark theme.
 */
/**
 * A device that draws everything except a filled shape behind the whole
 * region — the tint of the theorem box a formula sits in. Cut out with its
 * box, a formula carries a slab of color that no longer frames anything
 * (and turns to mud when inverted for a dark theme).
 */
function withoutBackdrop(draw: mupdf.Device, region: Rect): mupdf.Device {
  const area = (region[2] - region[0]) * (region[3] - region[1]);
  const stroke = new mupdf.StrokeState({ lineCap: "Butt", lineJoin: "Miter", lineWidth: 0, miterLimit: 10 });
  const pass = (name: keyof mupdf.Device) => (...args: unknown[]) => (draw[name] as unknown as (...a: unknown[]) => unknown).apply(draw, args);
  const fns: Record<string, unknown> = {
    fillPath(path: mupdf.Path, evenOdd: boolean, ctm: mupdf.Matrix, colorspace: mupdf.ColorSpace, color: number[], alpha: number) {
      const [x0, y0, x1, y1] = path.getBounds(stroke, ctm);
      const ix = Math.max(0, Math.min(x1, region[2]) - Math.max(x0, region[0]));
      const iy = Math.max(0, Math.min(y1, region[3]) - Math.max(y0, region[1]));
      if (ix * iy >= area * 0.85) return;
      draw.fillPath(path, evenOdd, ctm, colorspace, color as mupdf.Color, alpha);
    },
  };
  for (const name of [
    "strokePath", "clipPath", "clipStrokePath", "fillText", "strokeText", "clipText", "clipStrokeText", "ignoreText",
    "fillShade", "fillImage", "fillImageMask", "clipImageMask", "popClip", "beginMask", "endMask", "beginGroup", "endGroup",
    "beginTile", "endTile", "beginLayer", "endLayer",
  ] as const)
    fns[name] = pass(name);
  return new mupdf.Device(fns as never);
}

export function renderRegion(
  page: mupdf.Page,
  bbox: Rect,
  scale: number,
  format: "png" | "jpeg",
  transparent = false,
): { data: Uint8Array; width: number; height: number } {
  const matrix = mupdf.Matrix.scale(scale, scale);
  const box: Rect = [
    Math.floor(bbox[0] * scale),
    Math.floor(bbox[1] * scale),
    Math.ceil(bbox[2] * scale),
    Math.ceil(bbox[3] * scale),
  ];
  const alpha = transparent && format === "png";
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, box, alpha);
  // clear() with a value paints it opaque; with none, fully transparent.
  if (alpha) pixmap.clear();
  else pixmap.clear(255);
  // Filtered, the page is run at the render scale so the filter sees shapes
  // in pixels, and the draw device under it adds no scale of its own.
  const device = new mupdf.DrawDevice(transparent ? mupdf.Matrix.identity : matrix, pixmap);
  if (transparent) {
    const filter = withoutBackdrop(device, box);
    page.run(filter, matrix);
    filter.close();
  } else page.run(device, mupdf.Matrix.identity);
  device.close();
  device.destroy();
  const data = format === "png" ? pixmap.asPNG() : pixmap.asJPEG(86);
  const out = { data: new Uint8Array(data), width: pixmap.getWidth(), height: pixmap.getHeight() };
  pixmap.destroy();
  return out;
}

export function renderPage(page: mupdf.Page, scale: number): { data: Uint8Array; width: number; height: number } {
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  const data = pixmap.asJPEG(88);
  const out = { data: new Uint8Array(data), width: pixmap.getWidth(), height: pixmap.getHeight() };
  pixmap.destroy();
  return out;
}
