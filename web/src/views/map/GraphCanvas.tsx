/**
 * The knowledge map: concepts as a force-directed graph on one canvas. Size is
 * importance, colour is how well a concept is known, hollow means not met yet;
 * edges carry relation strength, with arrows for directed AI relations.
 *
 * React owns only the props. Everything that changes per frame (positions,
 * view, hover, drags) lives in a `MapEngine` outside React, which paints in
 * requestAnimationFrame and only when something changed. The force layout
 * runs in layout.worker.ts and streams positions ~30 times a second; the
 * engine interpolates between those frames so motion still runs at 60.
 */
import { useEffect, useImperativeHandle, useRef, type JSX, type Ref } from "react";
import type { Concept, ConceptEdge, ConceptState, KnowledgeGraph } from "../../../../shared/types";
import type { FromWorker, ToWorker } from "./layout.worker";
import "../../styles/graph.css";

export interface GraphCanvasHandle {
  /** Smoothly bring a concept to the centre, zooming in if far out. Waits for the layout if needed. */
  focus(id: number): void;
  /** Smoothly fit the whole map, and keep it fitted while the layout moves until the user takes over. */
  fit(): void;
}

export interface GraphCanvasProps {
  /** Up to ~1500 nodes / ~6000 edges. Pass a new object to update; positions carry over by id. */
  graph: KnowledgeGraph;
  selectedId: number | null;
  /** A concept was clicked (its id), or empty space (null). */
  onSelect(id: number | null): void;
  /** When set, concepts not in it are dimmed (search or filter matches). Pass a new Set to change it. */
  highlight?: Set<number> | null;
  colorBy?: "state" | "mastery";
  ref?: Ref<GraphCanvasHandle>;
}

type ColorBy = NonNullable<GraphCanvasProps["colorBy"]>;
/** The world point at the canvas centre, and the zoom: screen = (world - c) * k + size / 2. */
type View = { k: number; cx: number; cy: number };
type Vec3 = [number, number, number];

interface Gesture {
  pointerId: number;
  /** Node pressed on, or -1 for empty space (a pan). */
  node: number;
  x0: number;
  y0: number;
  lastX: number;
  lastY: number;
  /** Grab point relative to the node centre, so it doesn't jump under the cursor. */
  offX: number;
  offY: number;
  moved: boolean;
}

interface Theme {
  /** By STATE_INDEX. */
  state: string[];
  /** MASTERY_STEPS + 1 stops from --m-unseen through --m-learning to --m-known. */
  mastery: string[];
  paper: string;
  lineStrong: string;
  ink: string;
  ink3: string;
  ink4: string;
  accent: string;
  font: string;
}

const STATES: readonly ConceptState[] = ["unseen", "seen", "learning", "known", "fading"];
const STATE_INDEX: Record<ConceptState, number> = { unseen: 0, seen: 1, learning: 2, known: 3, fading: 4 };
/** Mastery is quantised so nodes still batch into a handful of fill calls. */
const MASTERY_STEPS = 20;
/** Relations that read one way; their edges get an arrowhead at the target. */
const DIRECTED = new Set(["prerequisite", "part-of", "example-of", "generalizes"]);
const TAU = Math.PI * 2;
/** Alpha of whatever is not in focus. */
const DIM = 0.15;
const K_MIN = 0.04;
const K_MAX = 8;
/** Smallest on-screen node radius, so zoomed-out nodes stay visible and clickable. */
const MIN_R = 1.5;
/** Screen px around a node that still count as hitting it. */
const HIT_SLOP = 3;
/** Pointer travel before a press becomes a drag rather than a click. */
const DRAG_SLOP = 3;
/** The worker's post interval: each interpolation lands as the next frame arrives. */
const INTERP_MS = 34;
/** Time constant of the camera easing toward a moving target (fit, followed node). */
const FOLLOW_MS = 110;
const LABEL_H = 15;
/** Labels allowed at low zoom; grows with the square of zoom (screen area per world area). */
const LABEL_BUDGET = 40;
const LABEL_MAX_CHARS = 36;
/** Occupancy grid cell for label overlap, in screen px. */
const OCC = 8;
/**
 * Width and alpha per edge style: weight tiers 0–2 for co-occurrence, 3–5 for labelled AI relations.
 * Background edges are capped at one device pixel (see paint), so past that weight shows as alpha.
 */
const EDGE_W = [0.6, 0.85, 1.2, 0.9, 1.15, 1.5];
const EDGE_A = [0.45, 0.65, 0.85, 0.7, 0.85, 1];

/** Positions and view outlive the component, so returning to the map doesn't relayout it. */
const positionCache = new Map<number, { x: number; y: number }>();
/** The view and layout heat at unmount, and the topology they belong to. */
let saved: { view: View; topo: string; alpha: number } | null = null;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => (Number.isFinite(v) ? clamp(v, 0, 1) : 0);
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/** World radius in concept units, ∝ sqrt(importance): 3..14 px at zoom 1. */
const nodeRadius = (importance: number) => 3 + 11 * Math.sqrt(clamp01(importance));
/** Screen px per world unit of radius. Below zoom 1 nodes shrink slower than the map so they stay legible. */
const radiusScale = (k: number) => (k >= 1 ? k : k ** 0.65);
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 1 if the relation runs a→b, 2 if b→a (a trailing "←"), 0 if undirected. */
function edgeDirection(e: ConceptEdge): 0 | 1 | 2 {
  if (e.kind !== "ai" || !e.label) return 0;
  let s = e.label.trim();
  const back = s.endsWith("←");
  if (back) s = s.slice(0, -1).trim();
  if (!DIRECTED.has(s.toLowerCase().replace(/[\s_]+/g, "-"))) return 0;
  return back ? 2 : 1;
}

let probe: OffscreenCanvasRenderingContext2D | null = null;
/** Any CSS colour as rgb, by painting a pixel: works for hex, rgb(), oklch(), whatever the theme uses. */
function rgbOf(css: string): Vec3 {
  probe ??= new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
  if (!probe) return [128, 128, 128];
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#808080";
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return [d[0] ?? 128, d[1] ?? 128, d[2] ?? 128];
}

function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const state = STATES.map((s) => v(`--m-${s}`, "#999999"));
  const [u, l, k] = [state[0]!, state[2]!, state[3]!].map(rgbOf) as [Vec3, Vec3, Vec3];
  const mastery: string[] = [];
  for (let i = 0; i <= MASTERY_STEPS; i++) {
    const t = i / MASTERY_STEPS;
    const [a, b, f] = t < 0.5 ? [u, l, t * 2] : [l, k, t * 2 - 1];
    const c = (j: number) => Math.round(a[j]! + (b[j]! - a[j]!) * f);
    mastery.push(`rgb(${c(0)}, ${c(1)}, ${c(2)})`);
  }
  const lineStrong = v("--line-strong", "#d6d1c5");
  return {
    state,
    mastery,
    paper: v("--paper", "#faf9f6"),
    lineStrong,
    ink: v("--ink", "#1d1c1a"),
    ink3: v("--ink-3", "#8b867c"),
    ink4: v("--ink-4", lineStrong),
    accent: v("--accent", "#3d55d6"),
    font: `500 12px ${v("--font-ui", "system-ui, sans-serif")}`,
  };
}

/**
 * Van Wijk & Nuij's smooth zoom (as d3.interpolateZoom): between two views
 * given as centre and visible width, it zooms out just enough that the pan
 * never loses sight of where it's going.
 */
function zoomPath(p0: Vec3, p1: Vec3): { at(t: number): Vec3; ms: number } {
  const [ux0, uy0, w0] = p0;
  const [ux1, uy1, w1] = p1;
  const dx = ux1 - ux0;
  const dy = uy1 - uy0;
  const d2 = dx * dx + dy * dy;
  const rho = Math.SQRT2;
  if (d2 < 1e-12) {
    const S = Math.log(w1 / w0) / rho;
    return { ms: Math.abs(S) * 1000, at: (t) => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(rho * t * S)] };
  }
  const d1 = Math.sqrt(d2);
  const b0 = (w1 * w1 - w0 * w0 + 4 * d2) / (4 * w0 * d1);
  const b1 = (w1 * w1 - w0 * w0 - 4 * d2) / (4 * w1 * d1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const S = (r1 - r0) / rho;
  return {
    ms: S * 1000,
    at: (t) => {
      const s = t * S;
      const u = (w0 / (2 * d1)) * (Math.cosh(r0) * Math.tanh(rho * s + r0) - Math.sinh(r0));
      return [ux0 + u * dx, uy0 + u * dy, (w0 * Math.cosh(r0)) / Math.cosh(rho * s + r0)];
    },
  };
}

/** FNV-1a over the parts of the graph that shape the layout, to skip relayout on attribute-only updates. */
function topologyKey(ids: number[], radius: Float32Array, ea: Uint32Array, eb: Uint32Array, w: Float32Array): string {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    h = Math.imul(h ^ (v | 0), 0x01000193);
  };
  for (let i = 0; i < ids.length; i++) {
    mix(ids[i]!);
    mix(ids[i]! / 4294967296);
    mix(radius[i]! * 100);
  }
  for (let e = 0; e < ea.length; e++) {
    mix(ea[e]!);
    mix(eb[e]!);
    mix(w[e]! * 100);
  }
  return `${ids.length}:${ea.length}:${h >>> 0}`;
}

class MapEngine {
  onSelect: (id: number | null) => void = () => {};

  private readonly ctx: CanvasRenderingContext2D;
  private readonly worker: Worker;
  private readonly ro: ResizeObserver;
  private readonly mo: MutationObserver;
  private theme: Theme;

  // Graph, rebuilt by setGraph. Nodes are addressed by index into these arrays.
  private graph: KnowledgeGraph | null = null;
  private nodes: Concept[] = [];
  private n = 0;
  private ids: number[] = [];
  private indexOf = new Map<number, number>();
  private names: string[] = [];
  private radius = new Float32Array(0);
  private hollow = new Uint8Array(0);
  private colorIdx = new Uint8Array(0);
  /** Most important first: label priority. Painted in reverse, so hubs sit on top. */
  private byImportance = new Uint32Array(0);
  /** Neighbours as CSR: adj[adjStart[i] .. adjStart[i + 1]]. */
  private adjStart = new Uint32Array(1);
  private adj = new Uint32Array(0);
  private m = 0;
  private ea = new Uint32Array(0);
  private eb = new Uint32Array(0);
  private eStyle = new Uint8Array(0);
  /** Arrowhead target node, or -1 for undirected. */
  private eTarget = new Int32Array(0);
  private maxR = 0;
  private topo = "";
  private version = 0;

  // Positions as x,y pairs: what's on screen, and the two worker frames it moves between.
  private disp = new Float32Array(0);
  private prev = new Float32Array(0);
  private next: Float32Array = new Float32Array(0);
  private hasPos = false;
  /** Layout heat as of the last worker frame. */
  private alpha = 0;
  private interpolating = false;
  private tRecv = 0;

  private view: View = { k: 1, cx: 0, cy: 0 };
  private W = 0;
  private H = 0;
  private dpr = 1;
  private anim: { at(t: number): Vec3; t0: number; ms: number; S: number } | null = null;
  /** Keep the map fitted as the layout moves, until the user takes the camera. */
  private followFit = true;
  /** Keep this concept centred as the layout moves, until the user takes the camera. */
  private followId: number | null = null;
  /** The first fit jumps rather than eases in from an arbitrary view. */
  private snapFit = true;
  private pendingFocus: number | null = null;
  private raf = 0;
  private lastFrame = 0;

  private colorBy: ColorBy = "state";
  private selId: number | null = null;
  private sel = -1;
  private hover = -1;
  private highlight: Set<number> | null = null;
  private hl = new Uint8Array(0);
  private dim = new Uint8Array(0);
  private dimAny = false;
  private dimDirty = true;
  private gesture: Gesture | null = null;
  private dragIdx = -1;
  private dragX = 0;
  private dragY = 0;

  // Uniform grid over world positions for hit testing, rebuilt lazily when positions moved.
  private gridDirty = true;
  private gx0 = 0;
  private gy0 = 0;
  private gCell = 1;
  private gCols = 0;
  private gRows = 0;
  private gStart = new Int32Array(1);
  private gItems = new Int32Array(0);
  private gCellOf = new Int32Array(0);

  // Labels: measured widths (-1 = not yet), screen occupancy, and this frame's placements.
  private textW = new Float32Array(0);
  private occ = new Uint8Array(0);
  private occCols = 0;
  private occRows = 0;
  private stamp = 0;
  private lStamp = new Uint32Array(0);
  private lIdx = new Int32Array(0);
  private lX = new Float32Array(0);
  private lY = new Float32Array(0);
  private lA = new Float32Array(0);
  private lCount = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("GraphCanvas: no 2D canvas context");
    this.ctx = ctx;
    this.theme = readTheme();

    this.worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);

    this.ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      this.setSize(r.width, r.height);
      // Resizing cleared the backing store; repaint before this frame is shown.
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.frame();
    });
    this.ro.observe(root);

    this.mo = new MutationObserver(this.onTheme);
    this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    document.fonts.addEventListener("loadingdone", this.onFonts);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("dblclick", this.onDblClick);
  }

  destroy(): void {
    this.saveCache();
    if (this.hasPos) saved = { view: this.view, topo: this.topo, alpha: this.alpha };
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.worker.terminate();
    this.ro.disconnect();
    this.mo.disconnect();
    document.fonts.removeEventListener("loadingdone", this.onFonts);
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointercancel", this.onPointerUp);
    c.removeEventListener("pointerleave", this.onPointerLeave);
    c.removeEventListener("wheel", this.onWheel);
    c.removeEventListener("dblclick", this.onDblClick);
  }

  // ── props ────────────────────────────────────────────────────────────────

  setGraph(graph: KnowledgeGraph): void {
    if (graph === this.graph) return;
    const first = this.graph === null;
    const oldIds = this.ids;
    const oldIndex = this.indexOf;
    const oldDisp = this.disp;
    const hadPos = this.hasPos;
    this.graph = graph;

    const nodes = graph.nodes;
    const n = nodes.length;
    const ids = new Array<number>(n);
    const indexOf = new Map<number, number>();
    const names = new Array<string>(n);
    const radius = new Float32Array(n);
    const importance = new Float32Array(n);
    const hollow = new Uint8Array(n);
    let maxR = 0;
    for (let i = 0; i < n; i++) {
      const c = nodes[i]!;
      ids[i] = c.id;
      indexOf.set(c.id, i);
      names[i] = c.name.length > LABEL_MAX_CHARS ? `${c.name.slice(0, LABEL_MAX_CHARS - 1).trimEnd()}…` : c.name;
      importance[i] = clamp01(c.importance);
      radius[i] = nodeRadius(c.importance);
      hollow[i] = c.state === "unseen" ? 1 : 0;
      if (radius[i]! > maxR) maxR = radius[i]!;
    }

    // One line per pair: the strongest weight wins, and a labelled AI relation wins over co-occurrence.
    const pair = new Map<number, number>();
    const ea: number[] = [];
    const eb: number[] = [];
    const ew: number[] = [];
    const strong: boolean[] = [];
    const target: number[] = [];
    for (const e of graph.edges) {
      const a = indexOf.get(e.a);
      const b = indexOf.get(e.b);
      if (a === undefined || b === undefined || a === b) continue;
      const w = clamp01(e.weight);
      const isStrong = e.kind === "ai" && !!e.label;
      const dir = edgeDirection(e);
      const t = dir === 1 ? b : dir === 2 ? a : -1;
      const key = a < b ? a * n + b : b * n + a;
      const j = pair.get(key);
      if (j === undefined) {
        pair.set(key, ea.length);
        ea.push(a);
        eb.push(b);
        ew.push(w);
        strong.push(isStrong);
        target.push(t);
      } else {
        ew[j] = Math.max(ew[j]!, w);
        if (isStrong && !strong[j]) {
          strong[j] = true;
          target[j] = t;
        }
      }
    }
    const m = ea.length;
    const eaArr = Uint32Array.from(ea);
    const ebArr = Uint32Array.from(eb);
    const ewArr = Float32Array.from(ew);
    const eStyle = new Uint8Array(m);
    const adjStart = new Uint32Array(n + 1);
    for (let e = 0; e < m; e++) {
      const w = ew[e]!;
      eStyle[e] = (w < 0.34 ? 0 : w < 0.67 ? 1 : 2) + (strong[e] ? 3 : 0);
      adjStart[ea[e]! + 1]!++;
      adjStart[eb[e]! + 1]!++;
    }
    for (let i = 0; i < n; i++) adjStart[i + 1]! += adjStart[i]!;
    const fill = adjStart.slice(0, n);
    const adj = new Uint32Array(2 * m);
    for (let e = 0; e < m; e++) {
      adj[fill[ea[e]!]!++] = eb[e]!;
      adj[fill[eb[e]!]!++] = ea[e]!;
    }
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((x, y) => importance[y]! - importance[x]! || nodes[y]!.mentions - nodes[x]!.mentions);

    this.nodes = nodes;
    this.n = n;
    this.ids = ids;
    this.indexOf = indexOf;
    this.names = names;
    this.radius = radius;
    this.hollow = hollow;
    this.maxR = maxR;
    this.byImportance = Uint32Array.from(order);
    this.adjStart = adjStart;
    this.adj = adj;
    this.m = m;
    this.ea = eaArr;
    this.eb = ebArr;
    this.eStyle = eStyle;
    this.eTarget = Int32Array.from(target);
    this.colorIdx = new Uint8Array(n);
    this.recolor();
    this.textW = new Float32Array(n).fill(-1);
    this.dim = new Uint8Array(n);
    this.hl = new Uint8Array(n);
    this.lStamp = new Uint32Array(n);
    this.lIdx = new Int32Array(n);
    this.lX = new Float32Array(n);
    this.lY = new Float32Array(n);
    this.lA = new Float32Array(n);
    this.applyHighlight();

    const remap = (i: number) => {
      const id = i >= 0 ? oldIds[i] : undefined;
      return id === undefined ? -1 : (indexOf.get(id) ?? -1);
    };
    this.hover = remap(this.hover);
    this.dragIdx = remap(this.dragIdx);
    if (this.gesture) this.gesture.node = remap(this.gesture.node);
    this.sel = this.selId === null ? -1 : (indexOf.get(this.selId) ?? -1);

    const topo = topologyKey(ids, radius, eaArr, ebArr, ewArr);
    if (topo !== this.topo) {
      this.topo = topo;
      // Carry what's on screen over by id, falling back to a previous visit's layout.
      const disp = new Float32Array(2 * n).fill(NaN);
      let known = 0;
      for (let i = 0; i < n; i++) {
        const o = hadPos ? oldIndex.get(ids[i]!) : undefined;
        const ox = o === undefined ? NaN : oldDisp[2 * o]!;
        if (Number.isFinite(ox)) {
          disp[2 * i] = ox;
          disp[2 * i + 1] = oldDisp[2 * o! + 1]!;
          known++;
          continue;
        }
        const c = positionCache.get(ids[i]!);
        if (c) {
          disp[2 * i] = c.x;
          disp[2 * i + 1] = c.y;
          known++;
        }
      }
      this.disp = disp;
      this.prev = disp.slice();
      this.next = disp.slice();
      this.interpolating = false;
      this.hasPos = known > 0;
      if (this.hasPos && !hadPos) this.snapFit = true;

      // Back on the same map: resume the layout and view exactly where they were left.
      let heat: number | null = null;
      if (first && saved && saved.topo === topo) {
        heat = saved.alpha;
        this.view = { ...saved.view };
        this.followFit = false;
      }
      this.version++;
      const msg: ToWorker = {
        type: "graph",
        version: this.version,
        ids: Float64Array.from(ids),
        radius: radius.slice(),
        importance,
        links: new Uint32Array(2 * m),
        weights: new Float32Array(m),
        seed: disp.slice(),
        heat,
      };
      for (let e = 0; e < m; e++) {
        msg.links[2 * e] = ea[e]!;
        msg.links[2 * e + 1] = eb[e]!;
        // Labelled AI relations are deliberate; let them pull a little harder than co-occurrence.
        msg.weights[e] = Math.min(1, ew[e]! + (strong[e] ? 0.15 : 0));
      }
      this.worker.postMessage(msg, [
        msg.ids.buffer,
        msg.radius.buffer,
        msg.importance.buffer,
        msg.links.buffer,
        msg.weights.buffer,
        msg.seed.buffer,
      ]);
    }

    this.gridDirty = true;
    this.dimDirty = true;
    this.requestDraw();
  }

  setSelected(id: number | null): void {
    this.selId = id;
    this.sel = id === null ? -1 : (this.indexOf.get(id) ?? -1);
    this.dimDirty = true;
    this.requestDraw();
  }

  setHighlight(set: Set<number> | null): void {
    if (set === this.highlight) return;
    this.highlight = set;
    this.applyHighlight();
    this.dimDirty = true;
    this.requestDraw();
  }

  setColorBy(mode: ColorBy): void {
    if (mode === this.colorBy) return;
    this.colorBy = mode;
    this.recolor();
    this.requestDraw();
  }

  focus(id: number): void {
    const i = this.indexOf.get(id);
    if (i === undefined) return;
    this.followFit = false;
    this.snapFit = false;
    if (!this.hasPos || !Number.isFinite(this.next[2 * i]!)) {
      this.pendingFocus = id;
      return;
    }
    this.focusIndex(i);
  }

  fit(): void {
    this.dropHover();
    this.anim = null;
    this.followId = null;
    this.pendingFocus = null;
    this.followFit = true;
    this.snapFit = reducedMotion();
    this.requestDraw();
  }

  private recolor(): void {
    const byState = this.colorBy === "state";
    for (let i = 0; i < this.n; i++) {
      const c = this.nodes[i]!;
      this.colorIdx[i] = byState ? (STATE_INDEX[c.state] ?? 0) : Math.round(clamp01(c.mastery) * MASTERY_STEPS);
    }
  }

  private applyHighlight(): void {
    const set = this.highlight;
    for (let i = 0; i < this.n; i++) this.hl[i] = set?.has(this.ids[i]!) ? 1 : 0;
  }

  /** Which nodes are out of focus: everything but the hovered neighbourhood, else everything not highlighted. */
  private updateDim(): void {
    const { n, dim, hover: h } = this;
    if (h >= 0) {
      dim.fill(1);
      dim[h] = 0;
      for (let j = this.adjStart[h]!; j < this.adjStart[h + 1]!; j++) dim[this.adj[j]!] = 0;
      this.dimAny = true;
    } else if (this.highlight) {
      for (let i = 0; i < n; i++) dim[i] = this.hl[i] ? 0 : 1;
      this.dimAny = true;
    } else {
      dim.fill(0);
      this.dimAny = false;
    }
    // The selection is the anchor of whatever the student is doing; never fade it.
    if (this.sel >= 0) dim[this.sel] = 0;
    this.dimDirty = false;
  }

  // ── worker ───────────────────────────────────────────────────────────────

  private receive(msg: FromWorker): void {
    const B = msg.positions;
    if (msg.version !== this.version || B.length !== 2 * this.n) return;
    if (this.dragIdx >= 0) {
      B[2 * this.dragIdx] = this.dragX;
      B[2 * this.dragIdx + 1] = this.dragY;
    }
    if (!this.hasPos) {
      this.disp.set(B);
      this.prev.set(B);
      this.hasPos = true;
      this.snapFit = true;
    } else {
      this.prev.set(this.disp);
      // Nodes new to the screen appear where the worker put them rather than flying in from NaN.
      for (let i = 0; i < B.length; i++) if (Number.isNaN(this.prev[i]!)) this.prev[i] = B[i]!;
    }
    this.next = B;
    this.alpha = msg.alpha;
    this.tRecv = performance.now();
    this.interpolating = true;
    if (msg.settled) this.saveCache();
    if (this.pendingFocus !== null) {
      const id = this.pendingFocus;
      this.pendingFocus = null;
      this.focus(id);
    }
    this.requestDraw();
  }

  private saveCache(): void {
    const P = this.next;
    if (P.length !== 2 * this.n) return;
    for (let i = 0; i < this.n; i++) {
      const x = P[2 * i]!;
      const y = P[2 * i + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const c = positionCache.get(this.ids[i]!);
      if (c) {
        c.x = x;
        c.y = y;
      } else positionCache.set(this.ids[i]!, { x, y });
    }
  }

  // ── view ─────────────────────────────────────────────────────────────────

  private setSize(w: number, h: number): void {
    this.W = w;
    this.H = h;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    this.occCols = Math.ceil(w / OCC) + 1;
    this.occRows = Math.ceil(h / OCC) + 1;
    this.occ = new Uint8Array(this.occCols * this.occRows);
  }

  private toWorld(sx: number, sy: number): [number, number] {
    const { k, cx, cy } = this.view;
    return [cx + (sx - this.W / 2) / k, cy + (sy - this.H / 2) / k];
  }

  /** Stop any camera motion the user didn't ask for, because they just took the camera. */
  private takeCamera(): void {
    this.anim = null;
    this.followFit = false;
    this.followId = null;
    this.snapFit = false;
    this.pendingFocus = null;
  }

  private zoomed(sx: number, sy: number, factor: number): View {
    const v = this.view;
    const k = clamp(v.k * factor, K_MIN, K_MAX);
    const ox = sx - this.W / 2;
    const oy = sy - this.H / 2;
    return { k, cx: v.cx + ox / v.k - ox / k, cy: v.cy + oy / v.k - oy / k };
  }

  private animateTo(to: View): void {
    this.dropHover();
    if (reducedMotion() || this.W <= 0) {
      this.view = to;
      this.anim = null;
      this.requestDraw();
      return;
    }
    const S = Math.max(this.W, this.H);
    const from = this.view;
    const path = zoomPath([from.cx, from.cy, S / from.k], [to.cx, to.cy, S / to.k]);
    this.anim = { at: path.at, t0: performance.now(), ms: clamp(path.ms, 300, 900), S };
    this.requestDraw();
  }

  private focusIndex(i: number): void {
    const x = this.next[2 * i]!;
    const y = this.next[2 * i + 1]!;
    this.followFit = false;
    this.followId = this.ids[i]!;
    this.animateTo({ k: clamp(this.view.k, 1.4, 4), cx: x, cy: y });
  }

  /** The view that shows every node, leaving room for the legend at the bottom. */
  private fitView(): View | null {
    const { W, H, n, disp: P, radius: R } = this;
    if (W <= 0 || H <= 0) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = P[2 * i]!;
      const y = P[2 * i + 1]!;
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      const r = R[i]!;
      if (x - r < x0) x0 = x - r;
      if (x + r > x1) x1 = x + r;
      if (y - r < y0) y0 = y - r;
      if (y + r > y1) y1 = y + r;
    }
    if (x0 > x1) return null;
    const padX = 40;
    const padTop = 32;
    const padBottom = 64;
    const aw = Math.max(40, W - 2 * padX);
    const ah = Math.max(40, H - padTop - padBottom);
    const k = clamp(Math.min(aw / Math.max(1, x1 - x0), ah / Math.max(1, y1 - y0)), K_MIN, 1.5);
    // Centre the bounds in the padded area, which sits a little above the canvas centre.
    const shiftY = (padTop + ah / 2 - H / 2) / k;
    return { k, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 - shiftY };
  }

  // ── input ────────────────────────────────────────────────────────────────

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.gesture) return;
    this.takeCamera();
    const i = this.hitTest(e.offsetX, e.offsetY);
    let offX = 0;
    let offY = 0;
    if (i >= 0) {
      const [wx, wy] = this.toWorld(e.offsetX, e.offsetY);
      offX = this.disp[2 * i]! - wx;
      offY = this.disp[2 * i + 1]! - wy;
    }
    this.canvas.setPointerCapture(e.pointerId);
    this.gesture = {
      pointerId: e.pointerId,
      node: i,
      x0: e.offsetX,
      y0: e.offsetY,
      lastX: e.offsetX,
      lastY: e.offsetY,
      offX,
      offY,
      moved: false,
    };
  };

  private onPointerMove = (e: PointerEvent): void => {
    const g = this.gesture;
    const sx = e.offsetX;
    const sy = e.offsetY;
    if (!g) {
      this.setHover(this.hitTest(sx, sy));
      return;
    }
    if (e.pointerId !== g.pointerId) return;
    if (!g.moved) {
      if (Math.hypot(sx - g.x0, sy - g.y0) < DRAG_SLOP) return;
      g.moved = true;
      this.canvas.style.cursor = "grabbing";
      if (g.node >= 0) {
        this.dragIdx = g.node;
        this.setHover(g.node);
      }
    }
    if (g.node >= 0) {
      const [wx, wy] = this.toWorld(sx, sy);
      this.dragX = wx + g.offX;
      this.dragY = wy + g.offY;
      const i = g.node;
      this.next[2 * i] = this.disp[2 * i] = this.dragX;
      this.next[2 * i + 1] = this.disp[2 * i + 1] = this.dragY;
      this.gridDirty = true;
      const msg: ToWorker = { type: "drag", id: this.ids[i]!, x: this.dragX, y: this.dragY };
      this.worker.postMessage(msg);
    } else {
      this.view = { ...this.view, cx: this.view.cx - (sx - g.lastX) / this.view.k, cy: this.view.cy - (sy - g.lastY) / this.view.k };
    }
    g.lastX = sx;
    g.lastY = sy;
    this.requestDraw();
  };

  private onPointerUp = (e: PointerEvent): void => {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.gesture = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (this.dragIdx >= 0) {
      const msg: ToWorker = { type: "release", id: this.ids[this.dragIdx]! };
      this.worker.postMessage(msg);
      this.dragIdx = -1;
    }
    const cancelled = e.type === "pointercancel";
    if (!g.moved && !cancelled) this.onSelect(g.node >= 0 ? this.ids[g.node]! : null);
    this.setHover(cancelled ? -1 : this.hitTest(e.offsetX, e.offsetY));
    this.canvas.style.cursor = this.hover >= 0 ? "pointer" : "";
  };

  private onPointerLeave = (): void => {
    if (!this.gesture) this.setHover(-1);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.takeCamera();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.H : 1;
    if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // A sideways trackpad swipe pans; everything else zooms.
      this.view = { ...this.view, cx: this.view.cx + (e.deltaX * unit) / this.view.k };
    } else {
      // ctrl+wheel is a trackpad pinch: small deltas, so a steeper curve.
      const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015));
      this.view = this.zoomed(e.offsetX, e.offsetY, factor);
    }
    if (!this.gesture) this.setHover(this.hitTest(e.offsetX, e.offsetY));
    this.requestDraw();
  };

  private onDblClick = (e: MouseEvent): void => {
    const i = this.hitTest(e.offsetX, e.offsetY);
    this.takeCamera();
    if (i >= 0) this.focusIndex(i);
    else this.animateTo(this.zoomed(e.offsetX, e.offsetY, 2));
  };

  private onTheme = (): void => {
    this.theme = readTheme();
    this.textW.fill(-1);
    this.requestDraw();
  };

  /** Labels were measured in a fallback font until the UI font arrived. */
  private onFonts = (): void => {
    this.textW.fill(-1);
    this.requestDraw();
  };

  /** The camera is about to move on its own: whatever was under the cursor won't be. */
  private dropHover(): void {
    if (!this.gesture) this.setHover(-1);
  }

  private setHover(i: number): void {
    if (i === this.hover) return;
    this.hover = i;
    this.dimDirty = true;
    this.canvas.style.cursor = this.gesture?.moved ? "grabbing" : i >= 0 ? "pointer" : "";
    this.requestDraw();
  }

  // ── hit testing ──────────────────────────────────────────────────────────

  /** Counting-sort nodes into a uniform grid: O(n), no allocation once warm. */
  private buildGrid(): void {
    const { n, disp: P } = this;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = P[2 * i]!;
      const y = P[2 * i + 1]!;
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    this.gridDirty = false;
    if (x0 > x1) {
      this.gCols = 0;
      return;
    }
    // At most 256 cells a side, whatever an outlier does to the bounds.
    const cell = Math.max(24, Math.max(x1 - x0, y1 - y0) / 256);
    const cols = Math.floor((x1 - x0) / cell) + 1;
    const rows = Math.floor((y1 - y0) / cell) + 1;
    const cells = cols * rows;
    if (this.gStart.length < cells + 1) this.gStart = new Int32Array(cells + 1);
    if (this.gItems.length < n) this.gItems = new Int32Array(n);
    if (this.gCellOf.length < n) this.gCellOf = new Int32Array(n);
    const start = this.gStart;
    const items = this.gItems;
    const cellOf = this.gCellOf;
    start.fill(0, 0, cells + 1);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const x = P[2 * i]!;
      const y = P[2 * i + 1]!;
      if (Number.isNaN(x) || Number.isNaN(y)) {
        cellOf[i] = -1;
        continue;
      }
      const c = Math.floor((y - y0) / cell) * cols + Math.floor((x - x0) / cell);
      cellOf[i] = c;
      start[c]!++;
      total++;
    }
    // Running ends, then fill backwards so each start[c] lands on its cell's first item.
    for (let c = 1; c < cells; c++) start[c]! += start[c - 1]!;
    start[cells] = total;
    for (let i = n - 1; i >= 0; i--) {
      const c = cellOf[i]!;
      if (c >= 0) items[--start[c]!] = i;
    }
    this.gx0 = x0;
    this.gy0 = y0;
    this.gCell = cell;
    this.gCols = cols;
    this.gRows = rows;
  }

  /** The node under a screen point (preferring the one whose disc contains it), or -1. */
  private hitTest(sx: number, sy: number): number {
    if (!this.hasPos || this.n === 0) return -1;
    if (this.gridDirty) this.buildGrid();
    if (this.gCols === 0) return -1;
    const { k } = this.view;
    const rk = radiusScale(k);
    const [wx, wy] = this.toWorld(sx, sy);
    const reach = (Math.max(MIN_R, this.maxR * rk) + HIT_SLOP) / k;
    const { gx0, gy0, gCell: cell, gCols: cols, gRows: rows, gStart: start, gItems: items, disp: P, radius: R } = this;
    const c0 = Math.max(0, Math.floor((wx - reach - gx0) / cell));
    const c1 = Math.min(cols - 1, Math.floor((wx + reach - gx0) / cell));
    const r0 = Math.max(0, Math.floor((wy - reach - gy0) / cell));
    const r1 = Math.min(rows - 1, Math.floor((wy + reach - gy0) / cell));
    let best = -1;
    let bestScore = Infinity;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cellIdx = r * cols + c;
        for (let j = start[cellIdx]!; j < start[cellIdx + 1]!; j++) {
          const i = items[j]!;
          const rs = Math.max(MIN_R, R[i]! * rk) / k;
          const d = Math.hypot(P[2 * i]! - wx, P[2 * i + 1]! - wy);
          if (d > rs + HIT_SLOP / k) continue;
          // Distance outside the visible disc; negative inside, so the node actually under the cursor wins.
          const score = d - rs;
          if (score < bestScore) {
            bestScore = score;
            best = i;
          }
        }
      }
    }
    return best;
  }

  // ── frame ────────────────────────────────────────────────────────────────

  requestDraw(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    this.raf = 0;
    // performance.now(), not the rAF timestamp: that is the frame's start, which can predate a worker
    // message handled in the same frame, and a negative interpolation step would extrapolate.
    const now = performance.now();
    const dt = this.lastFrame ? Math.min(64, now - this.lastFrame) : 16;
    let more = false;
    if ((window.devicePixelRatio || 1) !== this.dpr && this.W > 0) this.setSize(this.W, this.H);

    if (this.interpolating) {
      // Clamped: `prev` is copied from `disp` on every message, so any overshoot would compound.
      const t = clamp((now - this.tRecv) / INTERP_MS, 0, 1);
      const { disp: P, prev: A, next: B } = this;
      if (t >= 1) {
        P.set(B);
        this.interpolating = false;
      } else {
        for (let i = 0; i < P.length; i++) P[i] = A[i]! + (B[i]! - A[i]!) * t;
        more = true;
      }
      this.gridDirty = true;
    }
    if (this.dragIdx >= 0) {
      this.disp[2 * this.dragIdx] = this.dragX;
      this.disp[2 * this.dragIdx + 1] = this.dragY;
    }

    if (this.anim) {
      const a = this.anim;
      const t = clamp((now - a.t0) / a.ms, 0, 1);
      const [cx, cy, w] = a.at(easeInOutCubic(t));
      this.view = { k: clamp(a.S / w, K_MIN, K_MAX), cx, cy };
      if (t < 1) more = true;
      else this.anim = null;
    } else if (this.hasPos && (this.followFit || this.followId !== null)) {
      more = this.follow(dt) || more;
    }

    this.paint();
    this.lastFrame = more ? now : 0;
    if (more) this.requestDraw();
  };

  /** Ease the camera toward the fitted view or the followed node. Returns whether it's still moving. */
  private follow(dt: number): boolean {
    let target: View | null = null;
    if (this.followFit) target = this.fitView();
    else if (this.followId !== null) {
      const i = this.indexOf.get(this.followId);
      const x = i === undefined ? NaN : this.disp[2 * i]!;
      if (i !== undefined && !Number.isNaN(x)) target = { k: this.view.k, cx: x, cy: this.disp[2 * i + 1]! };
    }
    if (!target) return false;
    if (this.snapFit && this.followFit) {
      this.snapFit = false;
      this.view = target;
      return false;
    }
    const v = this.view;
    const a = 1 - Math.exp(-dt / FOLLOW_MS);
    const k = v.k * (target.k / v.k) ** a;
    const cx = v.cx + (target.cx - v.cx) * a;
    const cy = v.cy + (target.cy - v.cy) * a;
    const still =
      Math.abs(Math.log(target.k / k)) < 1e-3 &&
      Math.abs(target.cx - cx) * k < 0.25 &&
      Math.abs(target.cy - cy) * k < 0.25;
    this.view = still ? target : { k, cx, cy };
    return !still;
  }

  private paint(): void {
    const { ctx, W, H, dpr, theme: T } = this;
    if (W <= 0 || H <= 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = T.paper;
    ctx.fillRect(0, 0, W, H);
    if (!this.hasPos || this.n === 0) return;
    if (this.dimDirty) this.updateDim();

    const { n, disp: P, radius: R, dim, dimAny, hover: h, sel: s } = this;
    const { k, cx, cy } = this.view;
    const tx = W / 2 - cx * k;
    const ty = H / 2 - cy * k;
    const rk = radiusScale(k);

    // ── edges: one path per style, so 6000 lines cost a handful of strokes.
    const normal: (Path2D | undefined)[] = [];
    const active: (Path2D | undefined)[] = [];
    let faded: Path2D | undefined;
    let arrows: Path2D | undefined;
    let arrowsActive: Path2D | undefined;
    const showArrows = k >= 0.55;
    const { ea, eb, eStyle, eTarget } = this;
    for (let e = 0; e < this.m; e++) {
      const a = ea[e]!;
      const b = eb[e]!;
      const x1 = P[2 * a]! * k + tx;
      const x2 = P[2 * b]! * k + tx;
      if (Number.isNaN(x1) || Number.isNaN(x2)) continue;
      const y1 = P[2 * a + 1]! * k + ty;
      const y2 = P[2 * b + 1]! * k + ty;
      if ((x1 < 0 && x2 < 0) || (x1 > W && x2 > W) || (y1 < 0 && y2 < 0) || (y1 > H && y2 > H)) continue;
      const touchesDim = dimAny && (dim[a]! || dim[b]!);
      // The selection's edges stay lit unless a hover elsewhere has faded their far end.
      const isActive = a === h || b === h || ((a === s || b === s) && !touchesDim);
      const isDim = !isActive && touchesDim;
      const st = eStyle[e]!;
      const path = isActive
        ? (active[st % 3] ??= new Path2D())
        : isDim
          ? (faded ??= new Path2D())
          : (normal[st] ??= new Path2D());
      path.moveTo(x1, y1);
      path.lineTo(x2, y2);

      const t = eTarget[e]!;
      if (t < 0 || isDim || !(showArrows || isActive)) continue;
      const toB = t === b;
      const hx = toB ? x2 : x1;
      const hy = toB ? y2 : y1;
      const dx = hx - (toB ? x1 : x2);
      const dy = hy - (toB ? y1 : y2);
      const len = Math.hypot(dx, dy);
      const rt = Math.max(MIN_R, R[t]! * rk);
      const size = isActive ? 6 : 4.5;
      if (len < rt + size + 6) continue;
      const ux = dx / len;
      const uy = dy / len;
      const tipX = hx - ux * (rt + 1.5);
      const tipY = hy - uy * (rt + 1.5);
      const bx = tipX - ux * size;
      const by = tipY - uy * size;
      const half = size * 0.55;
      const ap = isActive ? (arrowsActive ??= new Path2D()) : (arrows ??= new Path2D());
      ap.moveTo(tipX, tipY);
      ap.lineTo(bx - uy * half, by + ux * half);
      ap.lineTo(bx + uy * half, by - ux * half);
      ap.closePath();
    }
    // Zoomed out, thousands of lines turn to fog; fade them so the nodes read first.
    const zoomFade = Math.min(1, 0.45 + 0.55 * k);
    // Background edges stay within one device pixel: Skia draws those as hairlines with
    // coverage scaled by width, many times cheaper to rasterise than stroke outlines.
    const hair = 1 / dpr;
    ctx.lineCap = "butt";
    ctx.strokeStyle = T.lineStrong;
    if (faded) {
      ctx.globalAlpha = 0.6 * DIM * zoomFade;
      ctx.lineWidth = Math.min(0.7, hair);
      ctx.stroke(faded);
    }
    for (let st = 0; st < 6; st++) {
      const p = normal[st];
      if (!p) continue;
      ctx.globalAlpha = EDGE_A[st]! * zoomFade;
      ctx.lineWidth = Math.min(EDGE_W[st]!, hair);
      ctx.stroke(p);
    }
    if (arrows) {
      ctx.globalAlpha = 0.85 * zoomFade;
      ctx.fillStyle = T.ink4;
      ctx.fill(arrows);
    }
    ctx.strokeStyle = T.ink3;
    ctx.globalAlpha = 0.9;
    for (let tier = 0; tier < 3; tier++) {
      const p = active[tier];
      if (!p) continue;
      ctx.lineWidth = EDGE_W[tier + 3]! + 0.25;
      ctx.stroke(p);
    }
    if (arrowsActive) {
      ctx.fillStyle = T.ink3;
      ctx.fill(arrowsActive);
    }

    // ── selection halo, under the nodes
    if (s >= 0 && !Number.isNaN(P[2 * s]!)) {
      const rs = Math.max(MIN_R, R[s]! * rk);
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = T.accent;
      ctx.beginPath();
      ctx.arc(P[2 * s]! * k + tx, P[2 * s + 1]! * k + ty, rs + 9, 0, TAU);
      ctx.fill();
    }

    // ── nodes: one path per (colour, hollow, dimmed), least important first so hubs land on top.
    const colors = this.colorBy === "state" ? T.state : T.mastery;
    const paths: (Path2D | undefined)[] = [];
    const order = this.byImportance;
    for (let j = n - 1; j >= 0; j--) {
      const i = order[j]!;
      const x = P[2 * i]!;
      if (Number.isNaN(x)) continue;
      const sx = x * k + tx;
      const sy = P[2 * i + 1]! * k + ty;
      const rs = Math.max(MIN_R, R[i]! * rk);
      if (sx + rs < 0 || sx - rs > W || sy + rs < 0 || sy - rs > H) continue;
      const key = (this.colorIdx[i]! * 2 + this.hollow[i]!) * 2 + (dimAny ? dim[i]! : 0);
      const p = (paths[key] ??= new Path2D());
      p.moveTo(sx + rs, sy);
      p.arc(sx, sy, rs, 0, TAU);
    }
    // A paper keyline separates touching discs; below ~zoom 0.4 it would eat them.
    const keyline = rk > 0.55;
    for (let faint = 1; faint >= 0; faint--) {
      ctx.globalAlpha = faint ? DIM : 1;
      for (let c = 0; c < colors.length; c++) {
        for (let hol = 0; hol < 2; hol++) {
          const p = paths[(c * 2 + hol) * 2 + faint];
          if (!p) continue;
          if (hol) {
            // Not met yet: a ring, filled with paper so edges don't show through.
            ctx.fillStyle = T.paper;
            ctx.fill(p);
            ctx.strokeStyle = colors[c]!;
            ctx.lineWidth = 1.5;
            ctx.stroke(p);
          } else {
            ctx.fillStyle = colors[c]!;
            ctx.fill(p);
            if (keyline) {
              ctx.strokeStyle = T.paper;
              ctx.lineWidth = Math.min(1, hair);
              ctx.stroke(p);
            }
          }
        }
      }
    }

    // ── hover and selection rings
    ctx.globalAlpha = 1;
    if (h >= 0 && h !== s && !Number.isNaN(P[2 * h]!)) {
      ctx.strokeStyle = T.ink3;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(P[2 * h]! * k + tx, P[2 * h + 1]! * k + ty, Math.max(MIN_R, R[h]! * rk) + 2.5, 0, TAU);
      ctx.stroke();
    }
    if (s >= 0 && !Number.isNaN(P[2 * s]!)) {
      ctx.strokeStyle = T.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(P[2 * s]! * k + tx, P[2 * s + 1]! * k + ty, Math.max(MIN_R, R[s]! * rk) + 3.5, 0, TAU);
      ctx.stroke();
    }

    this.paintLabels(k, tx, ty, rk);
  }

  // ── labels ───────────────────────────────────────────────────────────────

  /**
   * Level-of-detail labels, placed greedily on an occupancy grid so none
   * overlap: hovered and selected first (always), then the selection's
   * neighbours (always), the hover's neighbours, highlighted matches, and
   * finally the most important concepts on screen, as many as zoom allows.
   */
  private paintLabels(k: number, tx: number, ty: number, rk: number): void {
    const { ctx, theme: T, dim, dimAny, hover: h, sel: s, adj, adjStart } = this;
    ctx.font = T.font;
    this.occ.fill(0);
    this.lCount = 0;
    this.stamp = (this.stamp + 1) >>> 0 || 1;
    const fade = (i: number) => (dimAny && dim[i] ? 0.35 : 1);

    if (h >= 0) this.label(h, true, 1, k, tx, ty, rk);
    if (s >= 0) {
      this.label(s, true, 1, k, tx, ty, rk);
      for (let j = adjStart[s]!; j < adjStart[s + 1]!; j++) this.label(adj[j]!, true, fade(adj[j]!), k, tx, ty, rk);
    }
    if (h >= 0) {
      for (let j = adjStart[h]!; j < adjStart[h + 1]!; j++) this.label(adj[j]!, false, 1, k, tx, ty, rk);
    }
    // With a highlight (and no hover) the dimmed are skipped, so this walks the matches by importance.
    const order = this.byImportance;
    const budget = Math.round(LABEL_BUDGET * clamp((k / 0.7) ** 2, 1, 40));
    let placed = 0;
    for (let j = 0; j < this.n && placed < budget; j++) {
      const i = order[j]!;
      if (dimAny && dim[i]) continue;
      if (this.label(i, false, 1, k, tx, ty, rk)) placed++;
    }

    const { lIdx, lX, lY, lA, lCount, names } = this;
    if (!lCount) return;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = T.paper;
    // All halos before any text, so one label's halo never cuts into another's letters.
    for (let j = 0; j < lCount; j++) {
      ctx.globalAlpha = lA[j]!;
      ctx.strokeText(names[lIdx[j]!]!, lX[j]!, lY[j]!);
    }
    ctx.fillStyle = T.ink;
    for (let j = 0; j < lCount; j++) {
      ctx.globalAlpha = lA[j]!;
      ctx.fillText(names[lIdx[j]!]!, lX[j]!, lY[j]!);
    }
    ctx.globalAlpha = 1;
  }

  /** Try below, above, right, left of the node; forced labels take "below" even when it overlaps. */
  private label(i: number, forced: boolean, alpha: number, k: number, tx: number, ty: number, rk: number): boolean {
    if (this.lStamp[i] === this.stamp) return false;
    const x = this.disp[2 * i]!;
    if (Number.isNaN(x)) return false;
    const sx = x * k + tx;
    const sy = this.disp[2 * i + 1]! * k + ty;
    if (sx < -80 || sx > this.W + 80 || sy < -30 || sy > this.H + 30) return false;
    const rs = Math.max(MIN_R, this.radius[i]! * rk);
    let w = this.textW[i]!;
    if (w < 0) {
      w = this.ctx.measureText(this.names[i]!).width;
      this.textW[i] = w;
    }
    const hw = w / 2 + 3;
    const hh = LABEL_H / 2;
    for (let c = 0; c < 4; c++) {
      const lx = c < 2 ? sx : c === 2 ? sx + rs + 4 + w / 2 : sx - rs - 4 - w / 2;
      const ly = c === 0 ? sy + rs + 2 + hh : c === 1 ? sy - rs - 2 - hh : sy;
      if (this.occupy(lx, ly, hw, hh, false)) return this.pushLabel(i, lx, ly, alpha);
    }
    if (!forced) return false;
    const ly = sy + rs + 2 + hh;
    this.occupy(sx, ly, hw, hh, true);
    return this.pushLabel(i, sx, ly, alpha);
  }

  /** Claim the grid cells under a box if they're free (or regardless, when forced). */
  private occupy(x: number, y: number, hw: number, hh: number, force: boolean): boolean {
    if (x + hw < 0 || y + hh < 0 || x - hw > this.W || y - hh > this.H) return false;
    const { occ, occCols: cols } = this;
    const c0 = Math.max(0, Math.floor((x - hw) / OCC));
    const c1 = Math.min(cols - 1, Math.floor((x + hw) / OCC));
    const r0 = Math.max(0, Math.floor((y - hh) / OCC));
    const r1 = Math.min(this.occRows - 1, Math.floor((y + hh) / OCC));
    if (!force) {
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (occ[r * cols + c]) return false;
    }
    for (let r = r0; r <= r1; r++) occ.fill(1, r * cols + c0, r * cols + c1 + 1);
    return true;
  }

  private pushLabel(i: number, x: number, y: number, alpha: number): true {
    const j = this.lCount++;
    this.lIdx[j] = i;
    this.lX[j] = x;
    this.lY[j] = y;
    this.lA[j] = alpha;
    this.lStamp[i] = this.stamp;
    return true;
  }
}

const LEGEND: ReadonlyArray<[ConceptState, string]> = [
  ["unseen", "Not met yet"],
  ["seen", "Read"],
  ["learning", "Learning"],
  ["known", "Known"],
  ["fading", "Fading"],
];

function Legend({ colorBy }: { colorBy: ColorBy }) {
  return (
    <div className="gc-legend">
      <div className="gc-legend-keys">
        {colorBy === "state" ? (
          LEGEND.map(([state, label]) => (
            <span key={state} className="gc-key">
              <i className={`gc-dot gc-dot-${state}`} />
              {label}
            </span>
          ))
        ) : (
          <>
            <span className="gc-key">
              <i className="gc-dot gc-dot-unseen" />
              Not met yet
            </span>
            <span className="gc-key">
              New
              <i className="gc-ramp" />
              Mastered
            </span>
          </>
        )}
      </div>
      <div className="gc-hint">scroll to zoom · drag to pan</div>
    </div>
  );
}

export function GraphCanvas({
  graph,
  selectedId,
  onSelect,
  highlight = null,
  colorBy = "state",
  ref,
}: GraphCanvasProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<MapEngine | null>(null);

  // Created first; the prop effects below run after it in the same commit and feed it.
  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const engine = new MapEngine(root, canvas);
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (engineRef.current) engineRef.current.onSelect = onSelect;
  }, [onSelect]);
  useEffect(() => {
    engineRef.current?.setColorBy(colorBy);
  }, [colorBy]);
  useEffect(() => {
    engineRef.current?.setGraph(graph);
  }, [graph]);
  useEffect(() => {
    engineRef.current?.setSelected(selectedId);
  }, [selectedId]);
  useEffect(() => {
    engineRef.current?.setHighlight(highlight);
  }, [highlight]);

  useImperativeHandle(
    ref,
    () => ({
      focus: (id: number) => engineRef.current?.focus(id),
      fit: () => engineRef.current?.fit(),
    }),
    [],
  );

  return (
    <div ref={rootRef} className="gc-root">
      <canvas ref={canvasRef} className="gc-canvas" role="img" aria-label="Map of concepts and how they relate" />
      <Legend colorBy={colorBy} />
    </div>
  );
}
