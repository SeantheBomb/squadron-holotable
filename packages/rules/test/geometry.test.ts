import { describe, expect, it } from 'vitest';
import { basePoly, buildPath, finalPose, measureArc, parseManeuver, rangeBetween, barrelRollPose, poseAlong } from '../src';

const P = { x: 400, y: 400, r: Math.PI / 2 }; // facing +y
describe('maneuver geometry', () => {
  it('straight moves template length plus one base', () => {
    const e = finalPose(buildPath(P, parseManeuver('3FW')));
    expect(e.x).toBeCloseTo(400); expect(e.y).toBeCloseTo(400 + 120 + 40); expect(e.r).toBeCloseTo(Math.PI / 2);
  });
  it('left turn ends rotated 90° to the left', () => {
    const e = finalPose(buildPath(P, parseManeuver('1TW')));
    expect(e.r).toBeCloseTo(Math.PI);
    expect(e.x).toBeCloseTo(400 - 35 - 20); expect(e.y).toBeCloseTo(400 + 20 + 35);
  });
  it('right bank ends rotated 45° right', () => {
    const e = finalPose(buildPath(P, parseManeuver('2NB')));
    expect(e.r).toBeCloseTo(Math.PI / 4); expect(e.x).toBeGreaterThan(400);
  });
  it('k-turn reverses heading at the straight position', () => {
    const e = finalPose(buildPath(P, parseManeuver('4KR')));
    expect(e.y).toBeCloseTo(400 + 160 + 40); expect(Math.abs(e.r)).toBeCloseTo(Math.PI / 2); expect(e.r).toBeLessThan(0);
  });
  it('tallon roll faces backwards with three slide positions', () => {
    const path = buildPath(P, parseManeuver('3ER'));
    const mid = finalPose(path, 'small', 0), f = finalPose(path, 'small', 1);
    expect(mid.r).toBeCloseTo(-Math.PI / 2);
    expect(Math.hypot(f.x - mid.x, f.y - mid.y)).toBeCloseTo(10);
  });
  it('path is continuous from the start pose', () => {
    const path = buildPath(P, parseManeuver('2TW'));
    const a = poseAlong(path, 0); expect(a.x).toBeCloseTo(400); expect(a.y).toBeCloseTo(400);
  });
  it('barrel roll shifts one template plus one base sideways', () => {
    const e = barrelRollPose(P, 1, 0); expect(e.x).toBeCloseTo(400 - 80); expect(e.y).toBeCloseTo(400);
  });
});
describe('range and arcs', () => {
  it('measures range bands between bases', () => {
    expect(rangeBetween(basePoly(P), basePoly({ x: 400, y: 540, r: 0 }))).toBe(1);
    expect(rangeBetween(basePoly(P), basePoly({ x: 400, y: 541, r: 0 }))).toBe(2);
    expect(rangeBetween(basePoly(P), basePoly({ x: 400, y: 440, r: Math.PI / 2 }))).toBe(0);
  });
  it('front arc includes targets ahead and excludes targets behind', () => {
    expect(measureArc(P, 'small', 'front', basePoly({ x: 400, y: 600, r: 0 })).inArc).toBe(true);
    expect(measureArc(P, 'small', 'front', basePoly({ x: 400, y: 200, r: 0 })).inArc).toBe(false);
    expect(measureArc(P, 'small', 'rear', basePoly({ x: 400, y: 200, r: 0 })).inArc).toBe(true);
    expect(measureArc(P, 'small', 'left', basePoly({ x: 200, y: 400, r: 0 })).inArc).toBe(true);
    expect(measureArc(P, 'small', 'right', basePoly({ x: 200, y: 400, r: 0 })).inArc).toBe(false);
    expect(measureArc(P, 'small', 'bullseye', basePoly({ x: 405, y: 700, r: 0 })).inArc).toBe(true);
    expect(measureArc(P, 'small', 'bullseye', basePoly({ x: 440, y: 700, r: 0 })).inArc).toBe(false);
  });
});
