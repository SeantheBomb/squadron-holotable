// Planar tabletop geometry. Units are millimetres. Heading `r` is radians, forward = (cos r, sin r),
// left = (-sin r, cos r). The play area is [0, PLAY_AREA] on both axes.

export interface Vec { x: number; y: number }
export interface Pose { x: number; y: number; r: number }
export type Poly = Vec[]; // convex, counter-clockwise

export const PLAY_AREA = 914.4; // 3 ft
export const RANGE_BAND = 100;
export const TEMPLATE_WIDTH = 20;
export const BASE_SIZE = { small: 40, medium: 60, large: 80 } as const;
export type ShipSize = keyof typeof BASE_SIZE;

// Template centreline dimensions (community-measured values).
export const STRAIGHT_LEN = 40; // per speed
export const BANK_RADIUS = [0, 80, 130, 180];
export const TURN_RADIUS = [0, 35, 62.5, 90];
// Half-angle of the printed front/rear arc; side arcs take the remainder.
export const ARC_HALF_ANGLE = (40.5 * Math.PI) / 180;
export const BULLSEYE_WIDTH = 14;

const EPS = 1e-6;

export const v = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const fwd = (r: number): Vec => ({ x: Math.cos(r), y: Math.sin(r) });
export const left = (r: number): Vec => ({ x: -Math.sin(r), y: Math.cos(r) });
export const normAngle = (r: number): number => {
  let a = r % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
};

export function basePoly(p: Pose, size: ShipSize = 'small'): Poly {
  const h = BASE_SIZE[size] / 2;
  const f = fwd(p.r), l = left(p.r);
  const c = v(p.x, p.y);
  return [
    add(c, add(mul(f, h), mul(l, h))),   // front-left
    add(c, add(mul(f, -h), mul(l, h))),  // rear-left
    add(c, add(mul(f, -h), mul(l, -h))), // rear-right
    add(c, add(mul(f, h), mul(l, -h))),  // front-right
  ];
}

// ---------- convex polygon tests ----------

function axesOf(p: Poly): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < p.length; i++) {
    const e = sub(p[(i + 1) % p.length], p[i]);
    const n = len(e);
    if (n > EPS) out.push(v(-e.y / n, e.x / n));
  }
  return out;
}

/** True when the interiors overlap (touching edges do not count). */
export function polysOverlap(a: Poly, b: Poly, slack = 1e-4): boolean {
  for (const ax of [...axesOf(a), ...axesOf(b)]) {
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (const p of a) { const d = dot(p, ax); amin = Math.min(amin, d); amax = Math.max(amax, d); }
    for (const p of b) { const d = dot(p, ax); bmin = Math.min(bmin, d); bmax = Math.max(bmax, d); }
    if (amax <= bmin + slack || bmax <= amin + slack) return false;
  }
  return true;
}

function segPointClosest(a: Vec, b: Vec, p: Vec): Vec {
  const ab = sub(b, a);
  const d = dot(ab, ab);
  const t = d < EPS ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / d));
  return add(a, mul(ab, t));
}

export function segmentsIntersect(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const d1 = cross(sub(b, a), sub(c, a)), d2 = cross(sub(b, a), sub(d, a));
  const d3 = cross(sub(d, c), sub(a, c)), d4 = cross(sub(d, c), sub(b, c));
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function pointInPoly(p: Vec, poly: Poly): boolean {
  for (let i = 0; i < poly.length; i++) {
    if (cross(sub(poly[(i + 1) % poly.length], poly[i]), sub(p, poly[i])) < -EPS) return false;
  }
  return true;
}

export interface ClosestPair { dist: number; a: Vec; b: Vec }

/** Closest points between two convex polygons (dist 0 when they touch or overlap). */
export function closestPoints(A: Poly, B: Poly): ClosestPair {
  if (A.length === 0 || B.length === 0) return { dist: Infinity, a: v(0, 0), b: v(0, 0) };
  if (polysOverlap(A, B, 0)) {
    const c = A.find(p => pointInPoly(p, B)) ?? B.find(p => pointInPoly(p, A)) ?? A[0];
    return { dist: 0, a: c, b: c };
  }
  let best: ClosestPair = { dist: Infinity, a: A[0], b: B[0] };
  const scan = (P: Poly, Q: Poly, flip: boolean) => {
    for (const p of P) {
      for (let j = 0; j < Q.length; j++) {
        const q = segPointClosest(Q[j], Q[(j + 1) % Q.length], p);
        const d = len(sub(p, q));
        if (d < best.dist - 1e-9) best = flip ? { dist: d, a: q, b: p } : { dist: d, a: p, b: q };
      }
    }
  };
  scan(A, B, false);
  scan(B, A, true);
  return best;
}

/** Sutherland–Hodgman clip of a convex polygon to the half-plane left of the ray origin→dir. */
function clipHalfPlane(poly: Poly, origin: Vec, dir: Vec): Poly {
  const out: Poly = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = cross(dir, sub(a, origin)), db = cross(dir, sub(b, origin));
    if (da >= -EPS) out.push(a);
    if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) {
      out.push(add(a, mul(sub(b, a), da / (da - db))));
    }
  }
  return out;
}

// ---------- range ----------

export function rangeBand(dist: number): number {
  if (dist <= 0.05) return 0;
  if (dist <= RANGE_BAND) return 1;
  if (dist <= RANGE_BAND * 2) return 2;
  if (dist <= RANGE_BAND * 3) return 3;
  return 4 + Math.floor((dist - RANGE_BAND * 3 - 1e-9) / RANGE_BAND); // "beyond 3"
}

export function rangeBetween(a: Poly, b: Poly): number {
  return rangeBand(closestPoints(a, b).dist);
}

// ---------- arcs ----------

export type ArcName = 'front' | 'rear' | 'left' | 'right' | 'bullseye' | 'full';

function wedge(poly: Poly, origin: Vec, centre: number, half: number): Poly {
  // Keep the part of poly between headings centre-half and centre+half (half < 90°).
  let p = clipHalfPlane(poly, origin, fwd(centre - half));          // left of the right-hand boundary
  p = clipHalfPlane(p, origin, mul(fwd(centre + half), -1));        // right of the left-hand boundary
  return p;
}

/** Portion of `target` polygon inside the named arc of a ship at `pose`. Empty when not in arc. */
export function clipToArc(pose: Pose, size: ShipSize, arc: ArcName, target: Poly): Poly {
  const o = v(pose.x, pose.y);
  switch (arc) {
    case 'full': return target;
    case 'front': return wedge(target, o, pose.r, ARC_HALF_ANGLE);
    case 'rear': return wedge(target, o, pose.r + Math.PI, ARC_HALF_ANGLE);
    case 'left': return wedge(target, o, pose.r + Math.PI / 2, Math.PI / 2 - ARC_HALF_ANGLE);
    case 'right': return wedge(target, o, pose.r - Math.PI / 2, Math.PI / 2 - ARC_HALF_ANGLE);
    case 'bullseye': {
      const f = fwd(pose.r), l = left(pose.r), w = BULLSEYE_WIDTH / 2;
      let p = clipHalfPlane(target, add(o, mul(l, -w)), f);            // left of right edge
      p = clipHalfPlane(p, add(o, mul(l, w)), mul(f, -1));             // right of left edge
      p = clipHalfPlane(p, o, mul(l, -1));                             // ahead of the ship
      return p;
    }
  }
}

export interface ArcCheck { inArc: boolean; range: number; dist: number; from: Vec; to: Vec }

/** Attack-range measurement: closest point of the target that lies inside the arc. */
export function measureArc(att: Pose, attSize: ShipSize, arc: ArcName, tgt: Poly): ArcCheck {
  const clipped = clipToArc(att, attSize, arc, tgt);
  if (clipped.length < 2) return { inArc: false, range: 99, dist: Infinity, from: v(att.x, att.y), to: v(att.x, att.y) };
  const cp = closestPoints(basePoly(att, attSize), clipped);
  return { inArc: true, range: rangeBand(cp.dist), dist: cp.dist, from: cp.a, to: cp.b };
}

export function segmentCrossesPoly(a: Vec, b: Vec, poly: Poly): boolean {
  if (pointInPoly(a, poly) || pointInPoly(b, poly)) return true;
  for (let i = 0; i < poly.length; i++) {
    if (segmentsIntersect(a, b, poly[i], poly[(i + 1) % poly.length])) return true;
  }
  return false;
}

// ---------- maneuvers ----------

export type Bearing =
  | 'T' | 'B' | 'F' | 'N' | 'Y'   // turn-left, bank-left, straight, bank-right, turn-right
  | 'K' | 'L' | 'P' | 'E' | 'R'   // koiogran, sloop-left, sloop-right, tallon-left, tallon-right
  | 'O' | 'A' | 'S' | 'D';        // stationary, reverse-bank-left, reverse-straight, reverse-bank-right
export type Difficulty = 'B' | 'W' | 'R';
export interface Maneuver { speed: number; bearing: Bearing; difficulty: Difficulty }

export function parseManeuver(code: string): Maneuver {
  return { speed: Number(code[0]), bearing: code[1] as Bearing, difficulty: code[2] as Difficulty };
}

/** A path is the track the ship's centre follows: lead-in (half base), template, lead-out (half base). */
export interface Path {
  start: Pose;
  h: number;
  templateLen: number;
  /** signed curvature of the template: +1/R turns left, 0 straight */
  k: number;
  total: number;
  /** extra heading applied only when the maneuver is fully executed */
  endRotation: number;
  /** tallon roll side slide (mm along final facing), applied only when fully executed */
  bearing: Bearing;
  reverse: boolean;
}

export function buildPath(start: Pose, m: { speed: number; bearing: Bearing }, size: ShipSize = 'small'): Path {
  const h = BASE_SIZE[size] / 2;
  const b = m.bearing;
  const reverse = b === 'A' || b === 'S' || b === 'D';
  // Reverse maneuvers are flown as the mirrored forward maneuver from the flipped pose.
  const s: Pose = reverse ? { x: start.x, y: start.y, r: start.r + Math.PI } : start;
  let k = 0, templateLen = 0, endRotation = 0;
  const leftish = b === 'T' || b === 'B' || b === 'L' || b === 'E' || b === 'D';
  const sign = leftish ? 1 : -1;
  if (b === 'O') {
    templateLen = 0;
  } else if (b === 'F' || b === 'K' || b === 'S') {
    templateLen = STRAIGHT_LEN * m.speed;
    if (b === 'K') endRotation = Math.PI;
  } else if (b === 'B' || b === 'N' || b === 'L' || b === 'P' || b === 'A' || b === 'D') {
    const R = BANK_RADIUS[m.speed];
    k = sign / R; templateLen = (Math.PI / 4) * R;
    if (b === 'L' || b === 'P') endRotation = Math.PI;
  } else {
    const R = TURN_RADIUS[m.speed];
    k = sign / R; templateLen = (Math.PI / 2) * R;
    if (b === 'E' || b === 'R') endRotation = sign * (Math.PI / 2);
  }
  const total = b === 'O' ? 0 : templateLen + 2 * h;
  return { start: s, h, templateLen, k, total, endRotation, bearing: b, reverse };
}

/** Pose of the ship centre after travelling `s` mm along the path (no end rotation applied). */
export function poseAlong(path: Path, s: number): Pose {
  const { start, h, templateLen, k } = path;
  let p: Pose = { ...start };
  const f0 = fwd(start.r);
  const seg1 = Math.min(s, h);
  p.x += f0.x * seg1; p.y += f0.y * seg1;
  let rem = s - seg1;
  if (rem > 0) {
    const t = Math.min(rem, templateLen);
    if (Math.abs(k) < EPS) {
      p.x += f0.x * t; p.y += f0.y * t;
    } else {
      const R = 1 / k, th = t * k; // signed
      const l0 = left(start.r);
      p.x += R * (Math.sin(th) * f0.x + (1 - Math.cos(th)) * l0.x);
      p.y += R * (Math.sin(th) * f0.y + (1 - Math.cos(th)) * l0.y);
      p.r = start.r + th;
    }
    rem -= t;
  }
  if (rem > 0) {
    const f1 = fwd(p.r);
    p.x += f1.x * rem; p.y += f1.y * rem;
  }
  if (path.reverse) p = { x: p.x, y: p.y, r: p.r - Math.PI };
  return p;
}

/** Final pose for a full execution. `slide` is -1/0/1 for Tallon roll placement. */
export function finalPose(path: Path, size: ShipSize = 'small', slide = 0): Pose {
  const p = poseAlong(path, path.total);
  if (path.bearing === 'E' || path.bearing === 'R') {
    // Side of the base sits against the template end; the ship may slide along its new facing.
    const r = p.r + path.endRotation;
    const f = fwd(r);
    const off = slide * (TEMPLATE_WIDTH / 2);
    return { x: p.x + f.x * off, y: p.y + f.y * off, r: normAngle(r) };
  }
  return { x: p.x, y: p.y, r: normAngle(p.r + path.endRotation) };
}

/** Thin quads covering the template itself, for "moved through" tests. */
export function templateSlices(path: Path, step = 4): Poly[] {
  const out: Poly[] = [];
  const w = TEMPLATE_WIDTH / 2;
  const s0 = path.h, s1 = path.h + path.templateLen;
  for (let s = s0; s < s1 - EPS; s += step) {
    const a = poseAlong(path, s), b = poseAlong(path, Math.min(s + step, s1));
    const la = left(a.r), lb = left(b.r);
    const quad: Poly = [
      v(a.x + la.x * w, a.y + la.y * w), v(a.x - la.x * w, a.y - la.y * w),
      v(b.x - lb.x * w, b.y - lb.y * w), v(b.x + lb.x * w, b.y + lb.y * w),
    ];
    // ensure CCW
    if (cross(sub(quad[1], quad[0]), sub(quad[2], quad[1])) < 0) quad.reverse();
    out.push(quad);
  }
  return out;
}

export function outsidePlayArea(poly: Poly): boolean {
  return poly.some(p => p.x < -1e-6 || p.y < -1e-6 || p.x > PLAY_AREA + 1e-6 || p.y > PLAY_AREA + 1e-6);
}

// ---------- repositions ----------

/** Barrel roll: side = +1 left / -1 right, pos = +1 forward / 0 / -1 back. */
export function barrelRollPose(p: Pose, side: 1 | -1, pos: -1 | 0 | 1, size: ShipSize = 'small'): Pose {
  const d = STRAIGHT_LEN + BASE_SIZE[size];
  const l = left(p.r), f = fwd(p.r);
  const off = pos * (TEMPLATE_WIDTH / 2);
  return { x: p.x + l.x * d * side + f.x * off, y: p.y + l.y * d * side + f.y * off, r: p.r };
}

/** Polygon swept by a barrel roll's template (between the two base positions). */
export function barrelRollTemplate(p: Pose, side: 1 | -1, size: ShipSize = 'small'): Poly {
  const h = BASE_SIZE[size] / 2, w = TEMPLATE_WIDTH / 2;
  const l = mul(left(p.r), side), f = fwd(p.r);
  const a = add(v(p.x, p.y), mul(l, h)), b = add(a, mul(l, STRAIGHT_LEN));
  const poly = [add(a, mul(f, w)), add(a, mul(f, -w)), add(b, mul(f, -w)), add(b, mul(f, w))];
  if (cross(sub(poly[1], poly[0]), sub(poly[2], poly[1])) < 0) poly.reverse();
  return poly;
}

export function polyCentroid(p: Poly): Vec {
  let x = 0, y = 0;
  for (const q of p) { x += q.x; y += q.y; }
  return v(x / p.length, y / p.length);
}
