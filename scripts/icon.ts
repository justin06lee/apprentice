/**
 * apprentice's icon: a wizard's hat, drawn by hand — or as near as a script
 * gets. Every line is a pressure stroke from perfect-freehand (the same
 * engine as the sketch pad) along a path nudged by seeded, low-frequency
 * wobble, so it reads as drawn, not plotted, and comes out the same every
 * run. Black and white, nothing else: chalk lines on a black macOS-style
 * squircle, its shadow in the margin.
 *
 *   bun scripts/icon.ts      → assets/apprentice.svg
 *   bun run icon             → that, then every PNG size (scripts/render-icon.mjs)
 */
import { getStroke } from "perfect-freehand";
import * as fs from "node:fs";
import * as path from "node:path";

type P = [number, number];

// ── a seeded hand ─────────────────────────────────────────────────────────

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261002);

const n1 = (v: number) => Math.round(v * 10) / 10;

function cubic(p0: P, p1: P, p2: P, p3: P, steps: number): P[] {
  const out: P[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

/** A path through several cubic pieces, each [c1, c2, end]. */
function curve(start: P, pieces: Array<[P, P, P]>, steps = 40): P[] {
  const out: P[] = [];
  let from = start;
  for (const [c1, c2, end] of pieces) {
    const seg = cubic(from, c1, c2, end, steps);
    out.push(...(out.length ? seg.slice(1) : seg));
    from = end;
  }
  return out;
}

function ellipse(cx: number, cy: number, rx: number, ry: number, rot: number, from: number, sweep: number, steps = 120): P[] {
  const out: P[] = [];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let i = 0; i <= steps; i++) {
    const a = from + (sweep * i) / steps;
    const x = rx * Math.cos(a);
    const y = ry * Math.sin(a);
    out.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return out;
}

/** Push points off their line a little, smoothly — a hand, not a ruler. */
function wobble(points: P[], amount: number): P[] {
  const f1 = 2 + rand() * 2;
  const f2 = 5 + rand() * 3;
  const p1 = rand() * Math.PI * 2;
  const p2 = rand() * Math.PI * 2;
  return points.map((p, i) => {
    const t = i / Math.max(1, points.length - 1);
    const a = points[Math.max(0, i - 1)]!;
    const b = points[Math.min(points.length - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const off = amount * (0.65 * Math.sin(t * Math.PI * f1 + p1) + 0.35 * Math.sin(t * Math.PI * f2 + p2));
    return [p[0] - (dy / len) * off, p[1] + (dx / len) * off];
  });
}

/** Perfect-freehand's outline → SVG path data (quadratic through midpoints). */
function outline(points: P[], size: number, opts: { taperStart?: number; taperEnd?: number; thinning?: number } = {}): string {
  const phase = rand() * Math.PI * 2;
  const input = points.map((p, i) => [p[0], p[1], 0.5 + 0.22 * Math.sin((i / points.length) * Math.PI * 3 + phase)]);
  const stroke = getStroke(input, {
    size,
    thinning: opts.thinning ?? 0.45,
    smoothing: 0.6,
    streamline: 0.35,
    simulatePressure: false,
    start: { taper: opts.taperStart ?? size * 1.6, cap: true },
    end: { taper: opts.taperEnd ?? size * 1.6, cap: true },
  });
  if (stroke.length < 3) return "";
  const [first, ...rest] = stroke;
  let d = `M${n1(first![0])} ${n1(first![1])} Q`;
  for (let i = 0; i < stroke.length; i++) {
    const a = stroke[i]!;
    const b = stroke[(i + 1) % stroke.length]!;
    d += `${n1(a[0])} ${n1(a[1])} ${n1((a[0] + b[0]) / 2)} ${n1((a[1] + b[1]) / 2)} `;
  }
  void rest;
  return `${d}Z`;
}

/** A closed shape's points as a smooth filled path. */
function blob(points: P[]): string {
  let d = `M${n1(points[0]![0])} ${n1(points[0]![1])}`;
  for (let i = 1; i < points.length; i++) d += ` L${n1(points[i]![0])} ${n1(points[i]![1])}`;
  return `${d}Z`;
}

// ── the plate: Apple's squircle, a superellipse ───────────────────────────

function squircle(cx: number, cy: number, half: number, n = 5): string {
  const pts: P[] = [];
  const steps = 240;
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push([cx + half * Math.sign(c) * Math.abs(c) ** (2 / n), cy + half * Math.sign(s) * Math.abs(s) ** (2 / n)]);
  }
  return blob(pts);
}

// ── the hat ───────────────────────────────────────────────────────────────

const INK = "#f4f3ef"; // white chalk on a black plate

// Cone, from the brim on the left, over the top, out to the drooping tip,
// back under it, and down the right side to the brim.
const left = curve([326, 676], [
  [[350, 540], [392, 404], [462, 318]],
  [[512, 258], [584, 226], [652, 238]],
]);
const tip = curve([652, 238], [[[708, 248], [748, 288], [760, 346]]]);
const under = curve([760, 346], [[[732, 322], [700, 309], [666, 306]]]);
const right = curve([666, 306], [[[660, 430], [674, 574], [706, 676]]]);
// The base of the cone follows the brim's curve.
const base = curve([706, 676], [[[600, 716], [430, 716], [326, 676]]]);
const cone = [...left, ...tip.slice(1), ...under.slice(1), ...right.slice(1), ...base.slice(1)];

// Drawn round once and a little further, the way a hand closes an ellipse.
const brimLine = wobble(ellipse(514, 666, 320, 92, -0.05, Math.PI * 0.6, Math.PI * 2.1, 200), 7);
// A second, lighter pass: the pencil going round again, not quite on the line.
const brimRetrace = wobble(ellipse(511, 671, 326, 95, -0.06, Math.PI * 0.9, Math.PI * 1.15, 140), 9);

const leftRetrace = curve([336, 640], [[[356, 520], [394, 410], [458, 330]]], 40);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <!-- In page space, so the cone filled with it is indistinguishable from the plate. -->
    <linearGradient id="plate" gradientUnits="userSpaceOnUse" x1="0" y1="100" x2="0" y2="924">
      <stop offset="0" stop-color="#1c1c1e"/>
      <stop offset="1" stop-color="#0c0c0d"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feGaussianBlur stdDeviation="14"/>
    </filter>
    <clipPath id="plate-clip"><path d="${squircle(512, 512, 412)}"/></clipPath>
  </defs>

  <path d="${squircle(512, 524, 404)}" fill="#000" opacity="0.38" filter="url(#shadow)"/>
  <g clip-path="url(#plate-clip)">
    <rect width="1024" height="1024" fill="url(#plate)"/>

    <!-- the brim, then the cone over it in the plate's own black, which
         hides the brim's back edge the way the hat would -->
    <path d="${outline(brimLine, 25, { thinning: 0.6, taperStart: 90, taperEnd: 60 })}" fill="${INK}"/>
    <path d="${outline(brimRetrace, 7, { taperStart: 60, taperEnd: 60 })}" fill="${INK}" opacity="0.35"/>
    <path d="${blob(cone)}" fill="url(#plate)"/>

    <!-- up the left side, over the top and round the drooping tip in one movement -->
    <path d="${outline(wobble([...left, ...tip.slice(1), ...under.slice(1)], 4), 28, { thinning: 0.6, taperStart: 30, taperEnd: 24 })}" fill="${INK}"/>
    <path d="${outline(wobble(leftRetrace, 8), 7, { taperStart: 70, taperEnd: 90 })}" fill="${INK}" opacity="0.32"/>
    <path d="${outline(wobble(right, 4), 27, { thinning: 0.6, taperStart: 34, taperEnd: 22 })}" fill="${INK}"/>
  </g>
</svg>
`;

const out = path.join(import.meta.dirname, "..", "assets", "apprentice.svg");
fs.writeFileSync(out, svg);
console.log(`wrote ${path.relative(process.cwd(), out)} (${(svg.length / 1024).toFixed(1)} KB)`);
