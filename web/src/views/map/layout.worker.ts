/// <reference lib="webworker" />
/**
 * The knowledge map's force layout, off the main thread. Node objects (and so
 * their positions and velocities) survive graph updates, so adding concepts
 * nudges the map instead of reshuffling it. Positions go back as a
 * transferable Float32Array of x,y pairs ~30 times a second until it cools.
 */
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

export type ToWorker =
  | {
      type: "graph";
      /** Echoed on every frame, so the main thread can drop frames in an older node order. */
      version: number;
      ids: Float64Array;
      /** World-space radius per node; also the collision radius. */
      radius: Float32Array;
      importance: Float32Array;
      /** Node index pairs. */
      links: Uint32Array;
      /** Per link, 0..1. */
      weights: Float32Array;
      /** Known x,y per node (NaN when unknown), e.g. from a previous visit. */
      seed: Float32Array;
      /** Starting alpha; null lets the worker judge it from how many nodes it had to place. */
      heat: number | null;
    }
  | { type: "drag"; id: number; x: number; y: number }
  | { type: "release"; id: number };

export interface FromWorker {
  type: "tick";
  version: number;
  positions: Float32Array;
  /** The simulation's heat after this frame, so a remount can resume rather than restart. */
  alpha: number;
  /** The layout has cooled and this is the last frame until something changes. */
  settled: boolean;
}

interface Node extends SimulationNodeDatum {
  id: number;
  r: number;
  imp: number;
}

interface Link extends SimulationLinkDatum<Node> {
  d: number;
  s: number;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Below this the map is visually still: stop ticking and posting. */
const ALPHA_STOP = 0.01;
/** Heat held while a node is dragged, so its neighbourhood follows. */
const DRAG_HEAT = 0.2;
const POST_MS = 33;
/** Up to ~150 ticks a second: a cold start settles in about a second on a fast machine, still visibly animated. */
const TICKS_PER_POST = 5;
/** On a slow machine, tick for most of each post interval but leave a gap to take drag messages. */
const TICK_BUDGET_MS = 28;
const TAU = Math.PI * 2;

let version = 0;
let nodes: Node[] = [];
let byId = new Map<number, Node>();
let timer: ReturnType<typeof setTimeout> | null = null;

const links = forceLink<Node, Link>([])
  .distance((l) => l.d)
  .strength((l) => l.s);

// Starts cold: each graph message sets the heat, and a fresh simulation's default alpha of 1 would override it.
const sim = forceSimulation<Node, Link>([])
  .stop()
  .alpha(0)
  // A little faster than d3's 0.0228: ~150 ticks from cold to ALPHA_STOP instead of ~200.
  .alphaDecay(0.03)
  .velocityDecay(0.4)
  .force("link", links)
  // Central concepts push harder, which buys room for their labels.
  .force(
    "charge",
    forceManyBody<Node>()
      .strength((n) => -(30 + 170 * n.imp))
      // Coarser Barnes-Hut than d3's 0.9: charge is the dominant cost per tick, and the map doesn't need precision.
      .theta(1.2)
      .distanceMax(800),
  )
  .force(
    "collide",
    forceCollide<Node>((n) => n.r + 3)
      .strength(0.8)
      .iterations(1),
  )
  // Weak gravity keeps disconnected islands from drifting off.
  .force("x", forceX<Node>(0).strength(0.04))
  .force("y", forceY<Node>(0).strength(0.04));

function settled(): boolean {
  return sim.alphaTarget() === 0 && sim.alpha() < ALPHA_STOP;
}

function post(done: boolean): void {
  const positions = new Float32Array(nodes.length * 2);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    positions[2 * i] = n.x ?? NaN;
    positions[2 * i + 1] = n.y ?? NaN;
  }
  const msg: FromWorker = { type: "tick", version, positions, alpha: sim.alpha(), settled: done };
  ctx.postMessage(msg, [positions.buffer]);
}

function step(): void {
  timer = null;
  const t0 = performance.now();
  for (let i = 0; i < TICKS_PER_POST && performance.now() - t0 < TICK_BUDGET_MS; i++) sim.tick();
  const done = settled();
  post(done);
  if (!done) timer = setTimeout(step, Math.max(0, POST_MS - (performance.now() - t0)));
}

function run(): void {
  if (timer === null) timer = setTimeout(step, 0);
}

/**
 * Put nodes nobody has a position for next to a neighbour that does, a few
 * sweeps deep so chains of new concepts hang off the existing map. Nodes with
 * no placed neighbour go on the rim, where they disturb the least; on a cold
 * start nothing is placed and d3's phyllotaxis spiral takes over.
 */
function seedNew(list: Node[], placed: Uint8Array, start: Uint32Array, adj: Uint32Array): void {
  const n = list.length;
  let pending = 0;
  for (let i = 0; i < n; i++) if (!placed[i]) pending++;
  if (pending === 0 || pending === n) return;

  for (let sweep = 0; sweep < 4 && pending > 0; sweep++) {
    let progress = 0;
    for (let i = 0; i < n; i++) {
      if (placed[i]) continue;
      let sx = 0;
      let sy = 0;
      let c = 0;
      for (let j = start[i]!; j < start[i + 1]!; j++) {
        const nb = adj[j]!;
        if (!placed[nb]) continue;
        const o = list[nb]!;
        sx += o.x!;
        sy += o.y!;
        c++;
      }
      if (!c) continue;
      const node = list[i]!;
      const a = Math.random() * TAU;
      const d = node.r + 12 + Math.random() * 18;
      node.x = sx / c + Math.cos(a) * d;
      node.y = sy / c + Math.sin(a) * d;
      node.vx = node.vy = 0;
      placed[i] = 1;
      progress++;
      pending--;
    }
    if (!progress) break;
  }
  if (!pending) return;

  let cx = 0;
  let cy = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    if (!placed[i]) continue;
    cx += list[i]!.x!;
    cy += list[i]!.y!;
    c++;
  }
  cx /= c;
  cy /= c;
  let rim = 0;
  for (let i = 0; i < n; i++) {
    if (placed[i]) rim = Math.max(rim, Math.hypot(list[i]!.x! - cx, list[i]!.y! - cy));
  }
  for (let i = 0; i < n; i++) {
    if (placed[i]) continue;
    const node = list[i]!;
    const a = Math.random() * TAU;
    const d = rim * (0.85 + Math.random() * 0.25) + 20;
    node.x = cx + Math.cos(a) * d;
    node.y = cy + Math.sin(a) * d;
    node.vx = node.vy = 0;
  }
}

function setGraph(m: Extract<ToWorker, { type: "graph" }>): void {
  version = m.version;
  const n = m.ids.length;
  const list = new Array<Node>(n);
  const nextById = new Map<number, Node>();
  const placed = new Uint8Array(n);
  let kept = 0;
  let seeded = 0;
  for (let i = 0; i < n; i++) {
    const id = m.ids[i]!;
    let node = byId.get(id);
    if (node) {
      kept++;
      placed[i] = 1;
    } else {
      node = { id, r: 0, imp: 0 };
      const sx = m.seed[2 * i]!;
      const sy = m.seed[2 * i + 1]!;
      if (Number.isFinite(sx) && Number.isFinite(sy)) {
        node.x = sx;
        node.y = sy;
        placed[i] = 1;
        seeded++;
      }
    }
    node.r = m.radius[i]!;
    node.imp = m.importance[i]!;
    list[i] = node;
    nextById.set(id, node);
  }
  const removed = nodes.length - kept;

  // Adjacency (CSR) for seeding, and degrees so hubs aren't yanked by every link at once.
  const L = m.weights.length;
  const start = new Uint32Array(n + 1);
  for (let e = 0; e < L; e++) {
    start[m.links[2 * e]! + 1]!++;
    start[m.links[2 * e + 1]! + 1]!++;
  }
  for (let i = 0; i < n; i++) start[i + 1]! += start[i]!;
  const fill = start.slice(0, n);
  const adj = new Uint32Array(2 * L);
  for (let e = 0; e < L; e++) {
    const a = m.links[2 * e]!;
    const b = m.links[2 * e + 1]!;
    adj[fill[a]!++] = b;
    adj[fill[b]!++] = a;
  }
  seedNew(list, placed, start, adj);

  const linkData = new Array<Link>(L);
  for (let e = 0; e < L; e++) {
    const a = m.links[2 * e]!;
    const b = m.links[2 * e + 1]!;
    const w = m.weights[e]!;
    const degA = start[a + 1]! - start[a]!;
    const degB = start[b + 1]! - start[b]!;
    linkData[e] = {
      source: a,
      target: b,
      d: list[a]!.r + list[b]!.r + 18 + 70 * (1 - w),
      s: (0.2 + 0.8 * w) / Math.max(1, Math.min(degA, degB)),
    };
  }

  // Detach the old links first: re-initialising them against the new node list would index stale nodes.
  links.links([]);
  nodes = list;
  byId = nextById;
  sim.nodes(nodes);
  links.links(linkData);

  const had = kept + seeded;
  const heat = had === 0 ? 1 : (m.heat ?? Math.min(0.5, 0.05 + (0.8 * (n - had + removed)) / Math.max(1, n)));
  sim.alpha(Math.max(sim.alpha(), heat));

  const done = n === 0 || settled();
  post(done);
  if (!done) run();
}

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === "graph") {
    setGraph(m);
    return;
  }
  const node = byId.get(m.id);
  if (!node) return;
  if (m.type === "drag") {
    node.fx = m.x;
    node.fy = m.y;
    sim.alphaTarget(DRAG_HEAT);
  } else {
    node.fx = null;
    node.fy = null;
    sim.alphaTarget(0);
  }
  run();
};
