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
import {
  SPOT_BLEND_MAX,
  compositionXShare,
  distribute,
  weightsFor,
  type Shape
} from "../src/shapes";

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

/**
 * Curve and bid-ask.
 *
 * They are one linear ramp and its reflection, which is the whole of what
 * "the opposite shape" means. A Gaussian stood at curve and could not satisfy
 * it: it had no edge where bid-ask has its peak, so the two were not opposites
 * and the pair did not span spot.
 */
describe("curve and bid-ask", () => {
  test("curve is bid-ask, reflected", () => {
    // Taken on the weights rather than the bps table, and with the active bin
    // left whole, because the two shapes split that one bin differently: curve
    // peaks there and bid-ask is zero there. The reflection maps a distance to
    // `reach - distance`, so the peak of one lands on the zero of the other.
    const curve = weightsFor(0, 10, 0, "curve", 0, 1);
    const bidask = weightsFor(0, 10, 0, "bidask", 0, 1);
    for (let d = 0; d <= 10; d += 1) {
      expect(curve[d].weightX).toBeCloseTo(bidask[10 - d].weightX, 12);
    }
  });

  test("the two together are flat", () => {
    // The consequence worth having: mixing them in any proportion sweeps the
    // space between the edges and the middle, and the halfway mix is spot.
    const curve = weightsFor(0, 20, 0, "curve", 0, 1);
    const bidask = weightsFor(0, 20, 0, "bidask", 0, 1);
    const sums = curve.map((w, i) => w.weightX + bidask[i].weightX);
    for (const sum of sums) expect(sum).toBeCloseTo(sums[0], 12);
  });

  test("a range clear of the price still gets the whole ramp", () => {
    // The ramp runs between the range's own ends, not from the active bin. A
    // reshape of the far edge of a band is the case that made it matter:
    // measuring from the price left bid-ask's zero outside the range, so the
    // shape arrived as a shallow tilt — the further out, the closer to spot.
    const far = distribute(10, 20, 0, "bidask");
    expect(far[0].binId).toBe(11);
    expect(far[0].distributionX).toBe(182);
    expect(far[far.length - 1].distributionX).toBe(1818);

    // Bin 10 is the range's own inner edge, and bid-ask puts nothing there —
    // the same way it puts nothing at the active bin when the range reaches it.
    expect(far.some((b) => b.binId === 10)).toBe(false);
  });

  test("curve does not care where the price sits outside the range", () => {
    // It never did: the offset a distant range carries is an affine rescale,
    // and normalising divides it straight back out. Pinned because it is the
    // half of the pair that must *not* move.
    const near = weightsFor(0, 10, 0, "curve", 0, 1).map((w) => w.weightX);
    const far = weightsFor(10, 20, 0, "curve", 0, 1).map((w) => w.weightX);
    for (let i = 0; i <= 10; i += 1) expect(far[i]).toBeCloseTo(near[i], 12);
  });

  test("they are still one ramp and its reflection off the price", () => {
    const curve = weightsFor(30, 40, 0, "curve", 0, 1);
    const bidask = weightsFor(30, 40, 0, "bidask", 0, 1);
    for (let d = 0; d <= 10; d += 1) {
      expect(curve[d].weightX).toBeCloseTo(bidask[10 - d].weightX, 12);
    }
    const sums = curve.map((w, i) => w.weightX + bidask[i].weightX);
    for (const sum of sums) expect(sum).toBeCloseTo(sums[0], 12);
  });

  test("a side of one bin takes the whole of it, whatever the shape", () => {
    // There is no ramp to sit on, and a shape that answered zero would drop
    // the only bin the side has.
    for (const shape of ["spot", "curve", "bidask"] as const) {
      const only = distribute(5, 5, 0, shape);
      expect(only).toHaveLength(1);
      expect(only[0].distributionX).toBe(10_000);
    }
  });

  test("curve falls away from the active bin, monotonically", () => {
    const dist = distribute(-10, 10, 0, "curve");
    for (let d = 2; d <= 10; d += 1) {
      const here = dist.find((b) => b.binId === d)?.distributionX ?? 0;
      const inner = dist.find((b) => b.binId === d - 1)?.distributionX ?? 0;
      expect(here).toBeLessThan(inner);
    }
  });
});

/**
 * The active bin.
 *
 * The one bin that may hold both tokens, and so the one bin that appears on
 * both legs of a two-sided deposit. A full weight on each would put two bins'
 * worth of liquidity into it, in whatever mix the caller's two amounts happen
 * to be in — and the program charges a swap's fee for shifting that mix.
 */
describe("the active bin", () => {
  const bin = (x: bigint, y: bigint, price = 1) => ({
    amountX: x,
    amountY: y,
    priceQ64: BigInt(Math.round(price * 2 ** 64))
  });
  const at = (dist: ReturnType<typeof distribute>, binId: number) =>
    dist.find((d) => d.binId === binId);

  test("a bin with no ratio to match splits evenly", () => {
    expect(compositionXShare()).toBe(0.5);
    expect(compositionXShare(bin(0n, 0n))).toBe(0.5);
    // Unpriced is the same case: the program derives a price lazily, so a bin
    // without one has never held anything.
    expect(compositionXShare({ amountX: 5n, amountY: 5n, priceQ64: 0n })).toBe(0.5);
  });

  test("the share is of value, not of tokens", () => {
    // 100 X at a price of 3 is 300 of value against 100 of Y.
    expect(compositionXShare(bin(100n, 100n, 3))).toBeCloseTo(0.75, 4);
    expect(compositionXShare(bin(100n, 100n))).toBe(0.5);
    expect(compositionXShare(bin(1n, 0n, 3))).toBe(1);
    expect(compositionXShare(bin(0n, 1n, 3))).toBe(0);
  });

  test("it takes one bin's worth of liquidity, not two", () => {
    // Ten bins of X above it and ten of Y below, all of equal weight. At an
    // even split it takes half a neighbour's X and half a neighbour's Y, which
    // is one bin between them.
    const dist = distribute(-10, 10, 0, "spot");
    const active = at(dist, 0)!;
    expect(active.distributionX / at(dist, 1)!.distributionX).toBeCloseTo(0.5, 2);
    expect(active.distributionY / at(dist, -1)!.distributionY).toBeCloseTo(0.5, 2);
  });

  test("the split follows what the bin already holds", () => {
    // Three quarters of the bin's value is X, so three quarters of the bin's
    // weight goes to the X leg and a quarter to the Y leg.
    const dist = distribute(-10, 10, 0, "spot", 0, 0.75);
    expect(at(dist, 0)!.distributionX / at(dist, 1)!.distributionX).toBeCloseTo(0.75, 2);
    expect(at(dist, 0)!.distributionY / at(dist, -1)!.distributionY).toBeCloseTo(0.25, 2);
  });

  test("a bin holding one token takes only that token", () => {
    // Nothing to deposit in ratio, so nothing is deposited out of ratio: the
    // whole point is not to pay a swap's fee for a mix nobody asked to change.
    const dist = distribute(-10, 10, 0, "spot", 0, 0);
    expect(at(dist, 0)?.distributionX ?? 0).toBe(0);
    expect(at(dist, 0)!.distributionY).toBeGreaterThan(0);
  });

  test("a side with nowhere else to go keeps the active bin", () => {
    // The band stops at the active bin, so X has exactly one candidate and it
    // holds no X at all. Scaling it to nothing would leave the whole X deposit
    // in the wallet rather than in the pool, which is the worse answer: it goes
    // in and pays the composition fee.
    const dist = distribute(-10, 0, 0, "spot", 0, 0);
    expect(at(dist, 0)!.distributionX).toBe(10_000);
  });

  test("a full spot blend splits it too", () => {
    // The split is applied after the blend, deliberately. Folded in before, the
    // blend towards uniform would wash it out — and the double deposit would be
    // back at the one setting a user reaches for to keep things simple.
    for (const shape of SHAPE_IDS) {
      const dist = distribute(-10, 10, 0, shape, SPOT_BLEND_MAX);
      expect(at(dist, 0)!.distributionX / at(dist, 1)!.distributionX).toBeCloseTo(0.5, 2);
    }
  });

  test("each side still spends exactly 10_000 bps at any split", () => {
    for (const share of [0, 0.25, 0.5, 0.75, 1]) {
      for (const shape of SHAPE_IDS) {
        const dist = distribute(-3, 11, 0, shape, 0, share);
        expect(dist.reduce((a, d) => a + d.distributionX, 0)).toBe(10_000);
        expect(dist.reduce((a, d) => a + d.distributionY, 0)).toBe(10_000);
      }
    }
  });
});
