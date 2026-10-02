/**
 * The main process's side of the page renderer: requests out, images back,
 * and a disk cache so a page is drawn once per width it is viewed at.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { RenderReply, RenderRequest } from "./render-worker.js";

type Pending = { resolve: (r: RenderReply) => void };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class PageRenderer {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private sizes = new Map<string, Promise<Array<[number, number]>>>();

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
