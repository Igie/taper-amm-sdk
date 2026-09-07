/**
 * The spot blend.
 *
 * `distribute` is the only thing standing between a user's choice of shape and
 * an explicit bps table the program will accept, and the program's own guards
 * are weak here: it caps each side's sum at 10_000 but does not require it, so
 * a blend that quietly loses bps to rounding is a deposit that silently leaves
 * tokens in the wallet rather than a transaction that fails. Every case below
 * asserts the totals as well as the shape.
 */
import { describe, expect, test } from "bun:test";
import { SPOT_BLEND_MAX, distribute, type Shape } from "../src/shapes";

const SHAPE_IDS: Shape[] = ["spot", "curve", "bidask"];

const sumX = (dist: { distributionX: number }[]) =>
  dist.reduce((a, d) => a + d.distributionX, 0);
const sumY = (dist: { distributionY: number }[]) =>
  dist.reduce((a, d) => a + d.distributionY, 0);

describe("spot blend", () => {
  test("a full blend is exactly spot, whatever the shape", () => {
    const spot = distribute(-10, 10, 0, "spot");
    for (const shape of SHAPE_IDS) {
      const blended = distribute(-10, 10, 0, shape, SPOT_BLEND_MAX);
      expect(blended).toEqual(spot);
    }
  });

  test("no blend leaves the shape untouched", () => {
    for (const shape of SHAPE_IDS) {
      expect(distribute(-10, 10, 0, shape, 0)).toEqual(distribute(-10, 10, 0, shape));
    }
  });

  test("spot is unmoved by any blend", () => {
    const spot = distribute(-10, 10, 0, "spot");
    for (const bps of [0, 1, 2_500, 7_777, SPOT_BLEND_MAX]) {
      expect(distribute(-10, 10, 0, "spot", bps)).toEqual(spot);
    }
  });

  test("each side still spends exactly 10_000 bps at every blend", () => {
    for (const shape of SHAPE_IDS) {
      for (const bps of [0, 1, 3_300, 5_000, 9_999, SPOT_BLEND_MAX]) {
        // Asymmetric on purpose: 12 bins of X against 4 of Y, so a blend that
        // normalised across both sides at once would show up here.
        const dist = distribute(-3, 11, 0, shape, bps);
        expect(sumX(dist)).toBe(10_000);
        expect(sumY(dist)).toBe(10_000);
      }
    }
  });

  test("blending walks a bid-ask towards flat, monotonically", () => {
    const at = (bps: number) => {
      const dist = distribute(0, 10, 0, "bidask", bps);
      const edge = dist.find((d) => d.binId === 10)!.distributionX;
      const middle = dist.find((d) => d.binId === 5)?.distributionX ?? 0;
      return edge - middle;
    };
    // The edge-to-middle gap only ever narrows as the blend rises.
    const gaps = [0, 2_500, 5_000, 7_500, SPOT_BLEND_MAX].map(at);
    for (let i = 1; i < gaps.length; i += 1) expect(gaps[i]).toBeLessThan(gaps[i - 1]);
    expect(gaps[gaps.length - 1]).toBe(0);
  });

  test("blending fills in the centre a bid-ask leaves empty", () => {
    // Weight is distance/reach, so a pure bid-ask puts nothing at the active
    // bin on either leg, and the bin drops out of the table entirely.
    const pure = distribute(-10, 10, 0, "bidask", 0);
    expect(pure.some((d) => d.binId === 0)).toBe(false);

    const softened = distribute(-10, 10, 0, "bidask", 3_000);
    const active = softened.find((d) => d.binId === 0)!;
    expect(active.distributionX).toBeGreaterThan(0);
    expect(active.distributionY).toBeGreaterThan(0);
  });

  test("half a blend puts half the deposit flat", () => {
    // Ten bins, so spot is 1_000 bps each. At a 5_000 blend every bin carries
    // 500 bps of flat plus half its share of the shape.
    const pure = distribute(1, 10, 0, "curve", 0);
    const half = distribute(1, 10, 0, "curve", 5_000);
    for (const d of half) {
      const shaped = pure.find((p) => p.binId === d.binId)?.distributionX ?? 0;
      // Within a bp of the rounding, ignoring the bin that takes the remainder.
      expect(Math.abs(d.distributionX - (shaped / 2 + 500))).toBeLessThanOrEqual(2);
    }
  });

  test("out-of-range blends clamp rather than distort", () => {
    expect(distribute(-5, 5, 0, "curve", -1)).toEqual(distribute(-5, 5, 0, "curve", 0));
    expect(distribute(-5, 5, 0, "curve", 99_999)).toEqual(
      distribute(-5, 5, 0, "curve", SPOT_BLEND_MAX)
    );
  });

  test("a one-bin side survives every blend", () => {
    for (const shape of SHAPE_IDS) {
      for (const bps of [0, 5_000, SPOT_BLEND_MAX]) {
        const dist = distribute(0, 0, 0, shape, bps);
        expect(dist).toHaveLength(1);
        expect(dist[0].distributionX).toBe(10_000);
        expect(dist[0].distributionY).toBe(10_000);
      }
    }
  });
});
