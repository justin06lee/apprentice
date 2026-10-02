/**
 * apprentice's icon: a wizard's hat, drawn by hand — or as near as a script
 * gets. Every line is a pressure stroke from perfect-freehand (the same
 * engine as the sketch pad) along a path nudged by seeded, low-frequency
 * wobble, so it reads as drawn, not plotted, and comes out the same every
 * run. The plate is a macOS-style squircle with its shadow in the margin.
 * No paper grain: it vanishes at icon sizes and doubles every PNG.
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

function shift(points: P[], dx: number, dy: number): P[] {
  return points.map(([x, y]) => [x + dx, y + dy]);
}

/** A four-pointed sparkle with pinched sides, slightly irregular. */
function sparkle(cx: number, cy: number, r: number): string {
  const pts: P[] = [];
  const tilt = (rand() - 0.5) * 0.25;
  for (let k = 0; k < 4; k++) {
    const a = tilt + (k * Math.PI) / 2 - Math.PI / 2;
    const reach = r * (0.88 + rand() * 0.24);
    const tip: P = [cx + Math.cos(a) * reach, cy + Math.sin(a) * reach];
    const mid = a + Math.PI / 4;
    const waist: P = [cx + Math.cos(mid) * r * 0.2, cy + Math.sin(mid) * r * 0.2];
    pts.push(tip, waist);
  }
  let d = `M${n1(pts[0]![0])} ${n1(pts[0]![1])}`;
  for (let i = 1; i <= pts.length; i++) {
    const p = pts[i % pts.length]!;
    // Pull every edge toward the center: the pinched sides of a sparkle.
    const prev = pts[i - 1]!;
    const c: P = [(prev[0] + p[0]) / 2 * 0.82 + cx * 0.18, (prev[1] + p[1]) / 2 * 0.82 + cy * 0.18];
    d += ` Q${n1(c[0])} ${n1(c[1])} ${n1(p[0])} ${n1(p[1])}`;
  }
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

const INK = "#f7f2e8"; // chalk on a night-blue plate
const GOLD = "#f4c95d";

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

const brimFill = ellipse(512, 668, 322, 94, -0.05, 0, Math.PI * 2, 160);
// Drawn round once and a little further, the way a hand closes an ellipse.
const brimLine = wobble(ellipse(514, 666, 320, 92, -0.05, Math.PI * 0.6, Math.PI * 2.1, 200), 7);
// A second, lighter pass: the pencil going round again, not quite on the line.
const brimRetrace = wobble(ellipse(511, 671, 326, 95, -0.06, Math.PI * 0.9, Math.PI * 1.15, 140), 9);

const band = curve([300, 602], [[[430, 646], [600, 646], [730, 600]]], 60);

// Shading on the side away from the light: short parallel strokes.
const hatching: P[][] = [];
for (let i = 0; i < 6; i++) {
  const y = 412 + i * 30;
  const x = 590 + i * 6 + (rand() - 0.5) * 8;
  hatching.push(wobble([[x, y], [x + 34, y - 24]], 2));
}
// Light on the near side of the felt: one broad, soft stroke.
const sheen = curve([392, 560], [[[408, 470], [440, 390], [505, 318]]], 40);
const leftRetrace = curve([336, 640], [[[356, 520], [394, 410], [458, 330]]], 40);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#323c86"/>
      <stop offset="1" stop-color="#161a3c"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.42" r="0.5">
      <stop offset="0" stop-color="#5f6fd8" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#5f6fd8" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="felt" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6a5fd0"/>
      <stop offset="1" stop-color="#3f3994"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feGaussianBlur stdDeviation="14"/>
    </filter>
    <clipPath id="plate-clip"><path d="${squircle(512, 512, 412)}"/></clipPath>
    <clipPath id="cone-clip"><path d="${blob(cone)}"/></clipPath>
  </defs>

  <path d="${squircle(512, 524, 404)}" fill="#000" opacity="0.38" filter="url(#shadow)"/>
  <g clip-path="url(#plate-clip)">
    <rect width="1024" height="1024" fill="url(#plate)"/>
    <rect width="1024" height="1024" fill="url(#glow)"/>

    <!-- color laid in first, a little off the lines, as a hand colors;
         the brim's line goes down before the cone, which hides its back edge -->
    <path d="${blob(shift(brimFill, 7, 8))}" fill="#2f2b79"/>
    <path d="${outline(brimLine, 25, { thinning: 0.6, taperStart: 90, taperEnd: 60 })}" fill="${INK}"/>
    <path d="${outline(brimRetrace, 7, { taperStart: 60, taperEnd: 60 })}" fill="${INK}" opacity="0.45"/>
    <path d="${blob(shift(cone, 8, 6))}" fill="url(#felt)"/>
    <g clip-path="url(#cone-clip)">
      <path d="${outline(wobble(sheen, 6), 54, { thinning: 0.5, taperStart: 120, taperEnd: 160 })}" fill="#fff" opacity="0.13"/>
      <path d="${outline(wobble(band, 4), 46, { thinning: 0.15, taperStart: 0, taperEnd: 0 })}" fill="${GOLD}"/>
      ${hatching.map((h) => `<path d="${outline(h, 8, { taperStart: 14, taperEnd: 14 })}" fill="${INK}" opacity="0.3"/>`).join("\n      ")}
    </g>

    <!-- the lines -->
    <path d="${outline(wobble(left, 5), 29, { thinning: 0.6, taperStart: 30 })}" fill="${INK}"/>
    <path d="${outline(wobble(leftRetrace, 8), 7, { taperStart: 70, taperEnd: 90 })}" fill="${INK}" opacity="0.4"/>
    <path d="${outline(wobble([...tip, ...under.slice(1)], 3), 27, { thinning: 0.6, taperStart: 6, taperEnd: 24 })}" fill="${INK}"/>
    <path d="${outline(wobble(right, 4), 27, { thinning: 0.6, taperStart: 34, taperEnd: 22 })}" fill="${INK}"/>

    <!-- sparkles -->
    <path d="${sparkle(800, 200, 62)}" fill="${GOLD}"/>
    <path d="${sparkle(246, 332, 36)}" fill="${GOLD}"/>
    <path d="${sparkle(838, 462, 22)}" fill="${GOLD}" opacity="0.9"/>
    <circle cx="318" cy="216" r="9" fill="${INK}" opacity="0.75"/>
    <circle cx="742" cy="118" r="6" fill="${INK}" opacity="0.6"/>
    <circle cx="190" cy="486" r="6" fill="${INK}" opacity="0.5"/>
  </g>
</svg>
`;

const out = path.join(import.meta.dirname, "..", "assets", "apprentice.svg");
fs.writeFileSync(out, svg);
console.log(`wrote ${path.relative(process.cwd(), out)} (${(svg.length / 1024).toFixed(1)} KB)`);
