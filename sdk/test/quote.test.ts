/**
 * `swapInBin` against the program's own unit tests.
 *
 * These are the cases in `programs/taper-amm/src/math/swap.rs`, ported
 * verbatim. Porting the assertions rather than writing new ones is the point:
 * the TypeScript is a mirror, and a mirror is only useful if it is checked
 * against the thing it reflects with the same numbers.
 */
import { describe, expect, test } from "bun:test";
import { ONE_Q64 } from "../src/constants";
import { swapInBin } from "../src/quote";

const NO_FEE = 0n;
const THIRTY_BPS = 3_000_000n; // 0.3% against FEE_PRECISION
/** Price 2.0: one X is worth two Y. */
const P2 = 2n * ONE_Q64;

const isNoop = (r: { amountIn: bigint; amountOut: bigint }) => r.amountIn === 0n && r.amountOut === 0n;

describe("swapInBin", () => {
  test("an empty bin is a noop", () => {
    expect(isNoop(swapInBin(0n, 0n, P2, 1_000n, true, THIRTY_BPS, false))).toBe(true);
    // No Y to give when swapping for Y.
    expect(isNoop(swapInBin(100n, 0n, P2, 1_000n, true, THIRTY_BPS, false))).toBe(true);
  });

  test("zero input is a noop", () => {
    expect(isNoop(swapInBin(1_000n, 1_000n, P2, 0n, true, NO_FEE, false))).toBe(true);
  });

  test("a partial fill prices at the bin", () => {
    // 100 X in at P=2 yields 200 Y, no fee.
    const r = swapInBin(0n, 10_000n, P2, 100n, true, NO_FEE, false);
    expect(r.amountIn).toBe(100n);
    expect(r.amountOut).toBe(200n);
    expect(r.fee).toBe(0n);
    expect(r.binIn).toBe(100n);
    expect(r.binOut).toBe(200n);
  });

  test("an exact fill drains the bin and no more", () => {
    // Bin holds 200 Y; draining it needs exactly 100 X.
    const r = swapInBin(0n, 200n, P2, 10_000n, true, NO_FEE, false);
    expect(r.amountOut).toBe(200n);
    expect(r.amountIn).toBe(100n);
    expect(r.binOut).toBe(200n);
  });

  test("the other direction inverts the price", () => {
    // 200 Y in at P=2 yields 100 X.
    const r = swapInBin(10_000n, 0n, P2, 200n, false, NO_FEE, false);
    expect(r.amountOut).toBe(100n);
    expect(r.amountIn).toBe(200n);
  });

  test("an input-side fee is added on top when the bin is drained", () => {
    const r = swapInBin(0n, 200n, P2, 1_000_000n, true, THIRTY_BPS, false);
    // 100 X must reach the bin, so the trader pays 100 plus the fee.
    expect(r.binIn).toBe(100n);
    expect(r.amountIn).toBe(100n + r.fee);
    expect(r.amountOut).toBe(200n);
    expect(r.fee >= 1n).toBe(true);
  });

  test("an input-side fee is carved out when the bin is not drained", () => {
    const r = swapInBin(0n, 10_000_000n, P2, 1_000n, true, THIRTY_BPS, false);
    expect(r.amountIn).toBe(1_000n);
    expect(r.binIn + r.fee).toBe(1_000n);
    expect(r.amountOut).toBe(r.binIn * 2n);
  });

  test("an output-side fee leaves the input whole", () => {
    const r = swapInBin(0n, 10_000_000n, P2, 1_000n, true, THIRTY_BPS, true);
    expect(r.amountIn).toBe(1_000n);
    expect(r.binIn).toBe(1_000n); // all input enters the bin
    expect(r.binOut).toBe(2_000n); // priced on the full input
    expect(r.amountOut + r.fee).toBe(r.binOut); // fee taken from the output
    expect(r.fee >= 1n).toBe(true);
  });

  test("an output-side fee still respects the bin's inventory", () => {
    const r = swapInBin(0n, 200n, P2, 1_000_000n, true, THIRTY_BPS, true);
    expect(r.binOut).toBe(200n);
    expect(r.amountOut + r.fee).toBe(200n);
    expect(r.amountIn).toBe(100n);
  });

  test("dust that buys nothing consumes nothing", () => {
    // At P=2 swapping Y for X, 1 Y buys 0 X. The trader must keep it.
    expect(isNoop(swapInBin(10_000n, 0n, P2, 1n, false, NO_FEE, false))).toBe(true);
    // Same on the fee-on-output path.
    const tiny = ONE_Q64 / 1_000_000n;
    expect(isNoop(swapInBin(0n, 10_000n, tiny, 1n, true, THIRTY_BPS, true))).toBe(true);
  });

  test("the bin never pays out more than it holds", () => {
    const cases: [bigint, bigint, bigint, bigint, boolean][] = [
      [0n, 1n, ONE_Q64 / 3n, (1n << 64n) - 1n, true],
      [1n, 0n, ONE_Q64 * 3n, (1n << 64n) - 1n, false],
      [0n, (1n << 64n) - 1n, ONE_Q64, (1n << 64n) - 1n, true]
    ];
    for (const [x, y, price, amt, forY] of cases) {
      const r = swapInBin(x, y, price, amt, forY, THIRTY_BPS, false);
      const held = forY ? y : x;
      expect(r.binOut <= held).toBe(true);
      expect(r.amountOut <= r.binOut).toBe(true);
    }
  });

  test("rounding never favours the trader", () => {
    // The value received must never exceed the value paid, at the bin's price.
    for (const num of [1n, 3n, 7n, 999n]) {
      for (const den of [1n, 3n, 7n, 1_000n]) {
        const price = (ONE_Q64 * num) / den;
        if (price === 0n) continue;
        for (const amt of [1n, 2n, 13n, 1_000n, 999_983n]) {
          const big = (1n << 64n) / 4n;
          const r = swapInBin(big, big, price, amt, true, NO_FEE, false);
          if (isNoop(r)) continue;
          const paidValue = (r.binIn * price) / ONE_Q64;
          expect(r.binOut <= paidValue).toBe(true);
        }
      }
    }
  });

  test("a drained bin costs at least the fair input", () => {
    // Ceil on the required input means a bin can never be drained for less
    // than its contents are worth.
    for (const num of [1n, 3n, 7n, 999n]) {
      for (const den of [1n, 3n, 7n, 1_000n]) {
        const price = (ONE_Q64 * num) / den;
        if (price === 0n) continue;
        const y = 12_345n;
        const r = swapInBin(0n, y, price, (1n << 64n) - 1n, true, NO_FEE, false);
        expect(r.binOut).toBe(y);
        const valueIn = (r.binIn * price) / ONE_Q64;
        expect(valueIn >= y).toBe(true);
      }
    }
  });
});
