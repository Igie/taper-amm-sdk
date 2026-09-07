/**
 * The usable band, and the ways it can fail to exist.
 *
 * `initialize_config` *verifies* the band the client hands it rather than
 * searching for one, so a wrong answer here is not a rounding difference — it
 * is a config the program rejects outright. The case that matters is a wide
 * anchor: widths grow going down under a taper and cap at 400 bps, so a
 * ladder can have no valid bin below its anchor at all.
 */
import { describe, expect, test } from "bun:test";
import { ONE_Q64 } from "../src/constants";
import {
  Ladder,
  buildConfig,
  taperForHalfLife,
  usableRange,
  widthForBps
} from "../src/ladder";

/** Mirrors `Ladder::validate_range`: what the program will accept. */
function programWouldAccept(bps: number, halfLife: number, min: number, max: number) {
  const ladder = new Ladder(widthForBps(bps), taperForHalfLife(halfLife));
  if (min >= max) return false;
  const low = ladder.price(min);
  const high = ladder.price(max);
  if (!(low < high) || !Number.isFinite(high)) return false;
  if (!(ladder.price(min + 1) > low)) return false;
  if (!(high > ladder.price(max - 1))) return false;
  // Widest bin at the bottom, narrowest at the top: [0.01 bps, 400 bps].
  return ladder.stepBpX100(min) <= 40_000 && ladder.stepBpX100(max) >= 1;
}

describe("usableRange", () => {
  test("never reports a band the program would reject", () => {
    const cases: [number, number][] = [
      [25, Infinity],
      [10, 20_000],
      [100, 4_000],
      [200, 1_500],
      [1, Infinity],
      [50, 2_000]
    ];
    for (const [bps, halfLife] of cases) {
      const [min, max] = usableRange(widthForBps(bps), taperForHalfLife(halfLife));
      expect(programWouldAccept(bps, halfLife, min, max)).toBe(true);
    }
  });

  test("a wide anchor leaves nothing below it", () => {
    // At 400 bps the anchor sits exactly on the cap, so bin -1 — which is
    // wider still — is not expressible. The band must not claim it.
    const [min] = usableRange(widthForBps(400), taperForHalfLife(800));
    expect(min).toBeGreaterThanOrEqual(0);
  });

  test("buildConfig refuses a band that does not exist rather than emitting one", () => {
    // 3000 bps is far past the 400 bps cap: no bin at all is valid.
    expect(() => buildConfig(0, 3_000, 500)).toThrow(/no usable band/);
  });

  test("a uniform ladder is symmetric about the anchor", () => {
    const [min, max] = usableRange(widthForBps(25), taperForHalfLife(Infinity));
    expect(min).toBeLessThan(0);
    expect(max).toBeGreaterThan(0);
  });
});

describe("Ladder", () => {
  test("tau = 1 is exactly a uniform ladder", () => {
    const ladder = new Ladder(widthForBps(25), ONE_Q64);
    expect(ladder.tau).toBe(1);
    // v(i) = w0 * i, so P(i) = (1 + 25bps)^i.
    for (const id of [1, 10, 100, -50]) {
      expect(ladder.price(id)).toBeCloseTo(1.0025 ** id, 9);
    }
    expect(ladder.priceCeiling()).toBe(Infinity);
  });

  test("a taper tightens bins going up and widens them going down", () => {
    const ladder = new Ladder(widthForBps(100), taperForHalfLife(4_000));
    expect(ladder.width(1_000)).toBeLessThan(ladder.width(0));
    expect(ladder.width(-1_000)).toBeGreaterThan(ladder.width(0));
  });

  test("the price ceiling is the asymptote the widths converge to", () => {
    const ladder = new Ladder(widthForBps(100), taperForHalfLife(4_000));
    const ceiling = ladder.priceCeiling();
    expect(Number.isFinite(ceiling)).toBe(true);
    // Prices approach it from below and never reach it.
    expect(ladder.price(1_000_000)).toBeLessThanOrEqual(ceiling);
    expect(ladder.price(100_000) / ceiling).toBeGreaterThan(0.99);
  });
});
