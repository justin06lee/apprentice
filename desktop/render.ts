/**
 * The main process's side of the page renderer: requests out, images and
 * text back, and a disk cache so a page is drawn once per width it is
 * viewed at and read once ever.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { PageText, Rect, Trim } from "../shared/pages.js";
import type { RenderReply, RenderRequest } from "./render-worker.js";

/** Bump when the text layer's shape or extraction changes; old caches are then ignored. */
const TEXT_VERSION = 2;

type Pending = { resolve: (r: RenderReply) => void };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class PageRenderer {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private sizes = new Map<string, Promise<Array<[number, number]>>>();
  /** Recently used text layers, most recent last. */
  private texts = new Map<string, Promise<PageText>>();

  constructor(private readonly workerPath: string) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.workerPath);
    w.on("message", (r: RenderReply) => {
      this.pending.get(r.id)?.resolve(r);
      this.pending.delete(r.id);
    });
    const fail = (error: string) => {
      for (const p of this.pending.values()) p.resolve({ id: -1, ok: false, error });
      this.pending.clear();
      this.worker = null;
    };
    w.on("error", (e: Error) => fail(e.message));
    w.on("exit", () => fail("The page renderer stopped."));
    // Let the app quit without waiting on an idle renderer.
    w.unref();
    this.worker = w;
    return w;
  }

  private request(req: DistributiveOmit<RenderRequest, "id">): Promise<RenderReply> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.ensure().postMessage({ ...req, id } as RenderRequest);
    });
  }

  async page(pdf: string, cacheDir: string, page: number, width: number): Promise<Uint8Array> {
    const file = path.join(cacheDir, `${page}-${width}.jpg`);
    try {
      return await fs.promises.readFile(file);
    } catch {
      // not drawn at this width yet
    }
    const r = await this.request({ kind: "page", pdf, page, width });
    if (!r.ok || !r.data) throw new Error(r.ok ? "No image." : r.error);
    await fs.promises.mkdir(cacheDir, { recursive: true });
    void fs.promises.writeFile(file, r.data).catch(() => {});
    return r.data;
  }

  /** A page's text layer, from memory, the disk, or the PDF, in that order. */
  text(pdf: string, cacheDir: string, page: number): Promise<PageText> {
    const key = `${pdf}#${page}`;
    let p = this.texts.get(key);
    if (p) {
      this.texts.delete(key);
      this.texts.set(key, p);
      return p;
    }
    const file = path.join(cacheDir, `v${TEXT_VERSION}-${page}.json`);
    p = fs.promises
      .readFile(file, "utf8")
      .then((raw) => JSON.parse(raw) as PageText)
      .catch(async () => {
        const r = await this.request({ kind: "text", pdf, page });
        if (!r.ok || !r.text) throw new Error(r.ok ? "No text." : r.error);
        await fs.promises.mkdir(cacheDir, { recursive: true });
        void fs.promises.writeFile(file, JSON.stringify(r.text)).catch(() => {});
        return r.text;
      });
    p.catch(() => this.texts.delete(key));
    this.texts.set(key, p);
    while (this.texts.size > 240) this.texts.delete(this.texts.keys().next().value!);
    return p;
  }

  /** The book's printed area, measured once and kept beside it. */
  async trim(pdf: string, file: string): Promise<Trim | null> {
    try {
      return JSON.parse(await fs.promises.readFile(file, "utf8")) as Trim | null;
    } catch {
      // not measured yet
    }
    const r = await this.request({ kind: "trim", pdf });
    if (!r.ok) throw new Error(r.error);
    void fs.promises.writeFile(file, JSON.stringify(r.trim ?? null)).catch(() => {});
    return r.trim ?? null;
  }

  /** A rectangle of a page as a PNG about `width` pixels wide, for a model to look at. */
  async region(pdf: string, page: number, rect: Rect, width: number): Promise<Uint8Array> {
    const r = await this.request({ kind: "region", pdf, page, rect, width });
    if (!r.ok || !r.data) throw new Error(r.ok ? "No image." : r.error);
    return r.data;
  }

  pageSizes(pdf: string): Promise<Array<[number, number]>> {
    let p = this.sizes.get(pdf);
    if (!p) {
      p = this.request({ kind: "sizes", pdf }).then((r) => {
        if (!r.ok) {
          this.sizes.delete(pdf);
          throw new Error(r.error);
        }
        return r.sizes ?? [];
      });
      this.sizes.set(pdf, p);
    }
    return p;
  }

  stop(): void {
    void this.worker?.terminate();
    this.worker = null;
  }
}
