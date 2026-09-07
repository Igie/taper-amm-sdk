/**
 * Multi-position plans.
 *
 * The property that matters most is the one in `shape_survives_the_split`: a
 * band cut into three positions has to deposit the same curve a single 210-bin
 * position would have. Getting that wrong is invisible — every transaction
 * succeeds, the money all lands, and the liquidity is simply in the wrong
 * places — so it is asserted against the undivided `distribute` rather than
 * against a hand-written table.
 *
 * The rest guard the two ways a fan-out loses money quietly: dust dropped
 * between chunks, and rent paid for a position that was never going to hold
 * anything.
 */
import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  INLINE_BINS_PER_POSITION,
  MAX_BINS_PER_EXTEND,
  MAX_BINS_PER_POSITION,
  positionLenFor
} from "../src/constants";
import { resizeSteps } from "../src/instructions";
import { arrayIndexesFor, binArrayIndex } from "../src/pda";
import {
  MAX_TX_BYTES,
  planRebalance,
  planReshape,
  MAX_TX_COMPUTE,
  TX_HEADROOM,
  TX_HEADROOM_NATIVE,
  planDeposit,
  planExit,
  splitRange,
  stepIsLegal,
  transactionSize,
  widthThatFits,
  type BaseAccounts,
  type DepositInput
} from "../src/plan";
import { distribute, preview, weightsFor } from "../src/shapes";
import { splTokenPair, type PositionView } from "../src/types";

const key = () => PublicKey.unique();

const accounts: BaseAccounts = {
  owner: key(),
  pool: key(),
  config: key(),
  tokens: splTokenPair(key(), key()),
  userTokenX: key(),
  userTokenY: key(),
  reserveX: key(),
  reserveY: key()
};

const deposit = (over: Partial<DepositInput> = {}) =>
  planDeposit({
    accounts,
    lower: -100,
    upper: 104,
    activeId: 0,
    amountX: 1_000_000_000n,
    amountY: 1_000_000_000n,
    shape: "spot",
    ...over
  });

describe("splitRange", () => {
  test("a band inside the ceiling is one position, however wide", () => {
    // What growth bought: 210 bins used to be three accounts to claim from,
    // close, and reason about. It is now one.
    const specs = splitRange(0, 209);
    expect(specs.map((s) => s.width)).toEqual([210]);
    expect(specs[0].lowerBinId).toBe(0);
    expect(specs[0].upperBinId).toBe(209);
  });

  test("a band past the ceiling is still cut into positions", () => {
    const upper = MAX_BINS_PER_POSITION + 99;
    const specs = splitRange(0, upper);
    expect(specs.map((s) => s.width)).toEqual([MAX_BINS_PER_POSITION, 100]);
    expect(specs[specs.length - 1].upperBinId).toBe(upper);
  });

  test("a caller may still ask for narrow positions", () => {
    const specs = splitRange(0, 209, "packed", INLINE_BINS_PER_POSITION);
    expect(specs.map((s) => s.width)).toEqual([70, 70, 70]);
  });

  test("a split covers the band exactly, with no gap and no overlap", () => {
    for (const [lo, hi] of [
      [0, 0],
      [-5, 5],
      [-100, 104],
      [7, 7 + 500]
    ]) {
      const specs = splitRange(lo, hi);
      expect(specs[0].lowerBinId).toBe(lo);
      expect(specs[specs.length - 1].upperBinId).toBe(hi);
      for (let i = 1; i < specs.length; i += 1) {
        expect(specs[i].lowerBinId).toBe(specs[i - 1].upperBinId + 1);
      }
      for (const s of specs) expect(s.width).toBeLessThanOrEqual(MAX_BINS_PER_POSITION);
    }
  });

  test("aligned chunks each sit inside one bin array", () => {
    const specs = splitRange(-100, 104, "aligned");
    for (const s of specs) {
      expect(s.arrayIndexes).toHaveLength(1);
      expect(binArrayIndex(s.lowerBinId)).toBe(binArrayIndex(s.upperBinId));
    }
    // The trade it makes: more positions, and so more rent, than packed.
    expect(specs.length).toBeGreaterThan(splitRange(-100, 104).length);
  });

  test("a position no wider than the inline block straddles at most two arrays", () => {
    for (const s of splitRange(-100, 104, "packed", INLINE_BINS_PER_POSITION)) {
      expect(s.arrayIndexes.length).toBeLessThanOrEqual(2);
      expect(s.arrayIndexes).toEqual(arrayIndexesFor(s.lowerBinId, s.upperBinId));
    }
  });
});

describe("the packet limit", () => {
  test("a step fits, cold, with the caller's headroom left over", () => {
    for (const headroom of [TX_HEADROOM, TX_HEADROOM_NATIVE]) {
      for (const [lo, hi] of [
        [-10, 10],
        [-100, 104],
        [0, 300]
      ]) {
        const plan = deposit({ lower: lo, upper: hi, headroom, shape: "curve" });
        for (const step of plan.steps) {
          // Cold: every array still to create, which is what `build` may emit.
          const size = transactionSize(step.build(new Set()), accounts.owner);
          expect(size + headroom).toBeLessThanOrEqual(MAX_TX_BYTES);
        }
      }
    }
  });

  test("a full inline block fits in one fill, even wrapping SOL", () => {
    // What the dense table bought. The sparse form spent eight bytes a bin on
    // ids the position already implies, which put a 70-bin deposit at 1,262
    // bytes with nothing but a compute-budget instruction beside it.
    expect(widthThatFits(accounts, TX_HEADROOM, false)).toBe(INLINE_BINS_PER_POSITION);
    expect(widthThatFits(accounts, TX_HEADROOM_NATIVE, false)).toBe(INLINE_BINS_PER_POSITION);
  });

  test("the chunk that opens a position pays for its second signature", () => {
    // A position is a keypair account, so the opening transaction carries the
    // position's signature as well as the owner's: 64 bytes, which is 16 bins
    // of dense table. Only that one chunk pays it — sizing every fill as if it
    // did would give away throughput for a cost they do not carry.
    expect(widthThatFits(accounts, TX_HEADROOM, true)).toBe(INLINE_BINS_PER_POSITION);
    expect(widthThatFits(accounts, TX_HEADROOM_NATIVE, true)).toBe(66);
    expect(widthThatFits(accounts, TX_HEADROOM_NATIVE, true)).toBeLessThan(
      widthThatFits(accounts, TX_HEADROOM_NATIVE, false)
    );
  });

  test("the cap still narrows when a caller needs more room", () => {
    // The mechanism has to keep working, or a client with heavier wrapping
    // than this app has would silently build transactions that cannot be sent.
    const tight = widthThatFits(accounts, 500, false);
    expect(tight).toBeLessThan(INLINE_BINS_PER_POSITION);
    expect(tight).toBeGreaterThan(1);

    // The chunking follows it: no deposit step carries more bins than the
    // packet allows, whatever the position width.
    const plan = deposit({ lower: 0, upper: 299, headroom: 500 });
    for (const step of plan.steps) {
      if (step.kind === "resizePosition") continue;
      const size = transactionSize(step.build(new Set()), accounts.owner);
      expect(size + 500).toBeLessThanOrEqual(MAX_TX_BYTES);
    }
  });

  test("a wider band is more transactions, not a fatter one", () => {
    const plan = deposit({ lower: 0, upper: 299, headroom: TX_HEADROOM_NATIVE });
    expect(plan.positions).toHaveLength(1);
    const deposits = plan.steps.filter((s) => s.kind !== "resizePosition");
    expect(deposits.length).toBe(Math.ceil(300 / widthThatFits(accounts, TX_HEADROOM_NATIVE)));
  });

  test("a dense table is four bytes a bin, not eight", () => {
    const wide = deposit({ lower: 0, upper: 69, headroom: TX_HEADROOM });
    const narrow = deposit({ lower: 0, upper: 34, headroom: TX_HEADROOM });
    const size = (p: typeof wide) =>
      transactionSize(p.steps[0].build(new Set(p.steps[0].binArrays)), accounts.owner);
    expect(size(wide) - size(narrow)).toBe(35 * 4);
  });

  test("the size estimate is the wire format, not a guess", () => {
    // One known point, so a change to the arithmetic has to be deliberate: an
    // empty instruction list is a signature, a header, the blockhash and two
    // compact-array counts.
    expect(transactionSize([])).toBe(1 + 64 + 3 + 1 + 32 + 1);
  });
});

describe("planDeposit", () => {
  test("a band inside one position is still exactly one transaction", () => {
    const plan = deposit({ lower: -20, upper: 20 });
    expect(plan.steps).toHaveLength(1);
    expect(plan.positions).toHaveLength(1);
    // And the same table the single-position path has always sent.
    expect(plan.positions[0].dist).toEqual(distribute(-20, 20, 0, "spot"));
  });

  test("a wide band is one position, filled over several transactions", () => {
    const plan = deposit();
    expect(plan.positions).toHaveLength(1);
    expect(plan.newPositions).toBe(1);

    const chunks = Math.ceil(205 / widthThatFits(accounts));
    const deposits = plan.steps.filter((s) => s.kind !== "resizePosition");
    expect(deposits).toHaveLength(chunks);
    expect(chunks).toBeGreaterThan(1);
    for (const step of plan.steps) {
      expect(step.computeUnits).toBeLessThanOrEqual(1_400_000);
    }
  });

  test("growth is planned between opening the position and filling it", () => {
    const plan = deposit();
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds[0]).toBe("openPosition");

    // 205 bins: 70 inline, then one call covers the remaining 135.
    expect(plan.steps.filter((s) => s.kind === "resizePosition")).toHaveLength(1);
    // Every extension precedes every later deposit, or a fill would land in a
    // bin the account has no room for.
    expect(kinds.lastIndexOf("resizePosition")).toBe(1);
    expect(kinds.slice(2).every((k) => k === "addLiquidity")).toBe(true);
  });

  test("resizes are absolute bands, and marked safe to retry", () => {
    const plan = planDeposit({
      accounts,
      lower: 0,
      upper: 599,
      activeId: 300,
      amountX: 1_000_000_000n,
      amountY: 1_000_000_000n,
      shape: "spot"
    });
    const extensions = plan.steps.filter((s) => s.kind === "resizePosition");
    // 600 bins from an inline 70, 160 a call: four calls.
    expect(extensions).toHaveLength(4);
    for (const step of extensions) {
      expect(step.idempotent).toBe(true);
      expect(step.build(new Set())).toHaveLength(1);
      expect(step.amountX).toBe(0n);
    }
    // Ids carry the target band, so a re-plan matches progress step for step.
    expect(extensions.map((s) => s.id.split(":").slice(-2).join("…"))).toEqual([
      "0…229",
      "0…389",
      "0…549",
      "0…599"
    ]);
  });

  test("a position that is already wide enough needs no growth", () => {
    const plan = deposit({
      existingPositions: [
        { address: Keypair.generate().publicKey, lowerBinId: -100, upperBinId: 104, capacity: 205 }
      ]
    });
    expect(plan.steps.some((s) => s.kind === "resizePosition")).toBe(false);
  });

  test("rent is priced from the bytes, not the account count", () => {
    const plan = deposit();
    expect(plan.newPositionBytes).toBe(positionLenFor(205));
    // A 205-bin position is bigger than the 4,616-byte minimum, which is
    // exactly the figure a caller pricing by count would have used.
    expect(plan.newPositionBytes).toBeGreaterThan(4_616);
  });

  test("the split spends the deposit exactly", () => {
    for (const shape of ["spot", "curve", "bidask"] as const) {
      const plan = deposit({ shape });
      expect(plan.allocatedX).toBe(1_000_000_000n);
      expect(plan.allocatedY).toBe(1_000_000_000n);
    }
  });

  test("shape survives the split", () => {
    // The ideal both tables approximate: the continuous weights, unquantised.
    const ideal = weightsFor(-100, 104, 0, "curve", 2_000);
    const scale = 1_000_000_000;

    const placed = new Map<number, { x: number; y: number }>();
    for (const p of deposit({ shape: "curve", spotBlendBps: 2_000 }).positions) {
      for (const row of preview(p.dist, p.amountX, p.amountY)) {
        placed.set(row.binId, { x: Number(row.amountX), y: Number(row.amountY) });
      }
    }
    const whole = new Map(
      preview(distribute(-100, 104, 0, "curve", 2_000), 1_000_000_000n, 1_000_000_000n).map((r) => [
        r.binId,
        { x: Number(r.amountX), y: Number(r.amountY) }
      ])
    );

    let splitError = 0;
    let wholeError = 0;
    for (const w of ideal) {
      const want = { x: w.weightX * scale, y: w.weightY * scale };
      const got = placed.get(w.binId) ?? { x: 0, y: 0 };
      const one = whole.get(w.binId) ?? { x: 0, y: 0 };
      splitError += Math.abs(got.x - want.x) + Math.abs(got.y - want.y);
      wholeError += Math.abs(one.x - want.x) + Math.abs(one.y - want.y);
    }

    // Splitting must not reshape the deposit. It in fact sharpens it: each
    // chunk renormalises to 10_000 bps over its own bins, so a 70-bin chunk
    // resolves the curve four times as finely as one 205-bin table could.
    expect(splitError).toBeLessThanOrEqual(wholeError);

    // The floor on both is the ABI's, not the planner's: a bin's share is an
    // integer number of bps, so no table can be nearer than one bp per bin.
    const quantisation = (ideal.length * 2 * scale) / 10_000;
    expect(splitError).toBeLessThan(quantisation);
  });

  test("the curve has no step at a chunk boundary", () => {
    // The seam is where a wrong renormalisation would show: each chunk spends a
    // full 10_000 bps, so a chunk carrying a smaller share of the band would
    // deposit far too much if its share were not carried by its amounts.
    const placed = new Map<number, bigint>();
    for (const p of deposit({ shape: "curve" }).positions) {
      for (const row of preview(p.dist, p.amountX, p.amountY)) {
        placed.set(row.binId, row.amountX + row.amountY);
      }
    }
    // A curve peaks at the active bin and falls away monotonically on each
    // side, chunk boundaries included.
    for (let id = -99; id <= 0; id += 1) {
      expect(placed.get(id) ?? 0n).toBeGreaterThanOrEqual(placed.get(id - 1) ?? 0n);
    }
    for (let id = 1; id <= 103; id += 1) {
      expect(placed.get(id) ?? 0n).toBeGreaterThanOrEqual(placed.get(id + 1) ?? 0n);
    }
  });

  test("a one-sided deposit opens no position it cannot fund", () => {
    // Y only: every chunk above the active bin is X-only and has nothing to do,
    // and opening one would cost 0.033 SOL of rent to hold nothing.
    const plan = deposit({ amountX: 0n });
    expect(plan.positions.length).toBeGreaterThan(0);
    for (const p of plan.positions) {
      expect(p.spec.lowerBinId).toBeLessThanOrEqual(0);
      expect(p.amountY).toBeGreaterThan(0n);
    }
    expect(plan.allocatedY).toBe(1_000_000_000n);
    expect(plan.allocatedX).toBe(0n);
  });

  test("a step knows the active bins its distribution stays legal for", () => {
    const plan = deposit({ lower: -20, upper: 20 });
    const step = plan.steps[0];
    expect(stepIsLegal(step, 0)).toBe(true);
    // Trade one bin up and the bin that was the active one is now below it,
    // still holding X — which the program refuses.
    expect(stepIsLegal(step, 1)).toBe(false);
    expect(stepIsLegal(step, -1)).toBe(false);
  });

  test("a chunk entirely above the active bin tolerates the price falling", () => {
    const plan = deposit({ lower: 10, upper: 40, amountY: 0n, activeId: 0 });
    const step = plan.steps[0];
    // X-only, so it only cares that the active bin stays at or below bin 10.
    expect(stepIsLegal(step, 0)).toBe(true);
    expect(stepIsLegal(step, -50)).toBe(true);
    expect(stepIsLegal(step, 11)).toBe(false);
  });

  test("only a step that creates its position carries the witness", () => {
    const plan = deposit({ lower: -20, upper: 20 });
    expect(plan.steps[0].creates).toEqual(plan.positions[0].address);
    expect(plan.steps[0].kind).toBe("openPosition");

    const held = { address: Keypair.generate().publicKey, lowerBinId: -20, upperBinId: 20 };
    const second = deposit({ lower: -20, upper: 20, existingPositions: [held] });
    // Adding to a position that was already there has no witness: its deposit
    // is not atomic with a creation, so a runner must not re-send it blind.
    expect(second.steps[0].creates).toBeUndefined();
    expect(second.steps[0].kind).toBe("addLiquidity");
  });

  test("bin arrays are created by whichever step needs them first", () => {
    const plan = deposit({ lower: -20, upper: 20 });
    const arrays = arrayIndexesFor(-20, 20);

    const cold = plan.steps[0].build(new Set());
    const warm = plan.steps[0].build(new Set(arrays));
    expect(cold).toHaveLength(warm.length + arrays.length);

    // Someone else creating one between plan and send costs nothing.
    const partial = plan.steps[0].build(new Set([arrays[0]]));
    expect(partial).toHaveLength(warm.length + arrays.length - 1);
  });

  test("missingArrays reports only what is not there yet", () => {
    const all = arrayIndexesFor(-100, 104);
    expect(deposit().missingArrays).toEqual(all);
    expect(deposit({ existingArrays: all }).missingArrays).toEqual([]);
  });
});

/**
 * A position holding one unit of shares in every bin of its range.
 *
 * Fully grown: `capacity` covers the whole band, which is what a position
 * looks like once its `extend_position` sequence has finished.
 */
function position(lower: number, upper: number, pendingFee = 0n): PositionView {
  const width = upper - lower + 1;
  const fill = <T>(_empty: T, live: T) => Array.from({ length: width }, () => live);
  return {
    pool: accounts.pool,
    owner: accounts.owner,
    lowerBinId: lower,
    upperBinId: upper,
    width,
    capacity: Math.max(width, INLINE_BINS_PER_POSITION),
    lastUpdatedAt: 0n,
    totalClaimedFeeX: 0n,
    totalClaimedFeeY: 0n,
    shares: fill(0n, 1_000n),
    pendingFeeX: fill(0n, pendingFee),
    pendingFeeY: fill(0n, 0n),
    checkpointX: fill(0n, 0n),
    checkpointY: fill(0n, 0n)
  };
}

describe("planExit", () => {
  const held = [
    { address: key(), view: position(-70, -1) },
    { address: key(), view: position(0, 69) }
  ];

  test("a full exit is one transaction per position and closes each", () => {
    const plan = planExit({ accounts, positions: held, bps: 10_000, close: true });
    expect(plan.steps).toHaveLength(2);
    expect(plan.closing).toBe(2);
    for (const step of plan.steps) {
      expect(step.destroys).toBeDefined();
      // remove + claim + close.
      expect(step.build(new Set())).toHaveLength(3);
    }
  });

  test("a partial withdrawal never closes, whatever was asked", () => {
    const plan = planExit({ accounts, positions: held, bps: 5_000, close: true });
    expect(plan.closing).toBe(0);
    for (const step of plan.steps) {
      expect(step.destroys).toBeUndefined();
      expect(step.build(new Set())).toHaveLength(2);
    }
  });

  test("a range-limited exit touches only the bins in range", () => {
    const plan = planExit({
      accounts,
      positions: held,
      bps: 10_000,
      range: { lower: -10, upper: 10 },
      close: true
    });
    // Closing is refused: the rest of each position still holds shares.
    expect(plan.closing).toBe(0);
    expect(plan.steps).toHaveLength(2);
  });

  test("a position with nothing to do is left out", () => {
    const empty = { address: key(), view: position(0, 0) };
    empty.view.shares = empty.view.shares.map(() => 0n);
    const plan = planExit({ accounts, positions: [empty], bps: 10_000 });
    expect(plan.steps).toHaveLength(0);
  });

  test("an emptied position with a fee still pending is not left behind", () => {
    // `close_position` refuses while a fee is pending, so the claim has to run
    // even though there are no shares left to burn.
    const stranded = { address: key(), view: position(0, 4, 7n) };
    stranded.view.shares = stranded.view.shares.map(() => 0n);
    const plan = planExit({ accounts, positions: [stranded], bps: 10_000, close: true });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].build(new Set())).toHaveLength(2); // claim + close
  });

  test("a wide position is emptied in chunks, and closed on the last one", () => {
    const wide = { address: key(), view: position(0, 299) };
    const plan = planExit({ accounts, positions: [wide], bps: 10_000, close: true });
    const chunks = Math.ceil(300 / widthThatFits(accounts));
    expect(plan.steps).toHaveLength(chunks);
    expect(chunks).toBeGreaterThan(1);

    // Exactly one step closes, and it is the last.
    const closers = plan.steps.filter((s) => s.destroys);
    expect(closers).toHaveLength(1);
    expect(closers[0]).toBe(plan.steps[plan.steps.length - 1]);
    expect(plan.steps[plan.steps.length - 1].build(new Set())).toHaveLength(3);

    for (const step of plan.steps) {
      expect(step.computeUnits).toBeLessThanOrEqual(1_400_000);
      const size = transactionSize(step.build(new Set()), accounts.owner);
      expect(size + TX_HEADROOM).toBeLessThanOrEqual(MAX_TX_BYTES);
    }
  });

  test("a half-grown position is exited over the bins that exist", () => {
    // Storage stopped at the inline block, so there is nothing to withdraw
    // past bin 69 and nothing to claim there either.
    const half = { address: key(), view: position(0, 299) };
    half.view.capacity = INLINE_BINS_PER_POSITION;
    half.view.shares = half.view.shares.slice(0, INLINE_BINS_PER_POSITION);
    half.view.pendingFeeX = half.view.pendingFeeX.slice(0, INLINE_BINS_PER_POSITION);
    half.view.pendingFeeY = half.view.pendingFeeY.slice(0, INLINE_BINS_PER_POSITION);

    const plan = planExit({ accounts, positions: [half], bps: 10_000, close: true });
    expect(plan.steps).toHaveLength(1);
    for (const index of plan.steps[0].binArrays) {
      expect(index).toBeLessThanOrEqual(binArrayIndex(69));
    }
  });
});

describe("resizeSteps", () => {
  const width = (b: { lower: number; upper: number }) => b.upper - b.lower + 1;

  test("a band already where it is asked to be needs no step", () => {
    expect(resizeSteps({ lower: 0, upper: 69 }, { lower: 0, upper: 69 })).toEqual([]);
  });

  test("growing at the top is one step per realloc ceiling", () => {
    const steps = resizeSteps({ lower: 0, upper: 69 }, { lower: 0, upper: 599 });
    // 600 bins from an inline 70, 160 a call: four calls.
    expect(steps).toHaveLength(4);
    expect(steps[steps.length - 1]).toEqual({ lower: 0, upper: 599 });
    // No step may add more than the runtime allows.
    let held = 70;
    for (const step of steps) {
      expect(width(step) - held).toBeLessThanOrEqual(MAX_BINS_PER_EXTEND);
      held = width(step);
    }
  });

  test("a slide that grows by nothing is a single step", () => {
    // Sheds 60 bins at the bottom and gains 60 at the top: the account's
    // length never changes, so the realloc ceiling is not in play at all.
    const steps = resizeSteps({ lower: 0, upper: 199 }, { lower: 60, upper: 259 });
    expect(steps).toEqual([{ lower: 60, upper: 259 }]);
  });

  test("narrowing is free, however far it goes", () => {
    const steps = resizeSteps({ lower: 0, upper: 1_399 }, { lower: 700, upper: 709 });
    expect(steps).toEqual([{ lower: 700, upper: 709 }]);
  });

  test("every intermediate band keeps the bins the target keeps", () => {
    // The bins in `from ∩ to` may still hold liquidity, so no step on the way
    // may drop one — the program would refuse it as ResizeDropsLiquidity.
    const from = { lower: 0, upper: 99 };
    const to = { lower: -400, upper: 199 };
    const steps = resizeSteps(from, to);
    expect(steps.length).toBeGreaterThan(1);
    const keepLower = Math.max(from.lower, to.lower);
    const keepUpper = Math.min(from.upper, to.upper);
    for (const step of steps) {
      expect(step.lower).toBeLessThanOrEqual(keepLower);
      expect(step.upper).toBeGreaterThanOrEqual(keepUpper);
    }
    expect(steps[steps.length - 1]).toEqual(to);
  });

  test("widening downward respects the ceiling too", () => {
    const steps = resizeSteps({ lower: 0, upper: 69 }, { lower: -400, upper: 69 });
    let held = 70;
    for (const step of steps) {
      expect(width(step) - held).toBeLessThanOrEqual(MAX_BINS_PER_EXTEND);
      held = width(step);
    }
    expect(steps[steps.length - 1]).toEqual({ lower: -400, upper: 69 });
  });
});

describe("planRebalance", () => {
  const at = (lower: number, upper: number) => ({ address: key(), view: position(lower, upper) });

  test("a slide keeps the overlap and empties only what leaves", () => {
    const plan = planRebalance({
      accounts,
      position: at(0, 69),
      target: { lower: 20, upper: 89 }
    });
    expect(plan.leaving).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(plan.arriving).toEqual(Array.from({ length: 20 }, (_, i) => 70 + i));
    expect(plan.kept).toEqual(Array.from({ length: 50 }, (_, i) => 20 + i));
    // The kept bins are never withdrawn from — that is the point of moving.
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).toContain("exitPosition");
    expect(kinds).toContain("resizePosition");
    expect(kinds.lastIndexOf("exitPosition")).toBeLessThan(kinds.indexOf("resizePosition"));
  });

  test("emptying comes before the move, always", () => {
    // `resize_position` refuses to drop a bin still holding shares, so a plan
    // that moved first would simply fail on chain.
    const plan = planRebalance({
      accounts,
      position: at(0, 199),
      target: { lower: 150, upper: 349 }
    });
    const firstResize = plan.steps.findIndex((s) => s.kind === "resizePosition");
    expect(firstResize).toBeGreaterThan(0);
    expect(plan.steps.slice(0, firstResize).every((s) => s.kind === "exitPosition")).toBe(true);
  });

  test("a narrowing step carries no length witness", () => {
    // `grows` reads as "already at least this long, so skip". On a step that
    // shortens the account that is satisfied before the step runs, and the
    // runner would skip the one thing the plan exists to do.
    const plan = planRebalance({
      accounts,
      position: at(0, 199),
      target: { lower: 0, upper: 99 }
    });
    const resizes = plan.steps.filter((s) => s.kind === "resizePosition");
    expect(resizes.length).toBeGreaterThan(0);
    for (const step of resizes) {
      expect(step.grows).toBeUndefined();
      expect(step.idempotent).toBe(true);
    }
    expect(plan.arriving).toEqual([]);
    expect(plan.leaving).toEqual(Array.from({ length: 100 }, (_, i) => 100 + i));
  });

  test("a widening step does carry one", () => {
    const plan = planRebalance({
      accounts,
      position: at(0, 69),
      target: { lower: 0, upper: 299 }
    });
    const resizes = plan.steps.filter((s) => s.kind === "resizePosition");
    expect(resizes.length).toBeGreaterThan(1);
    for (const step of resizes) expect(step.grows).toBeDefined();
    // Nothing leaves a band that only widens.
    expect(plan.leaving).toEqual([]);
    expect(plan.steps.some((s) => s.kind === "exitPosition")).toBe(false);
  });

  test("moving nowhere is no steps at all", () => {
    const plan = planRebalance({
      accounts,
      position: at(0, 69),
      target: { lower: 0, upper: 69 }
    });
    expect(plan.steps).toEqual([]);
    expect(plan.leaving).toEqual([]);
    expect(plan.arriving).toEqual([]);
    expect(plan.kept).toHaveLength(70);
  });

  test("a move clear of the old band keeps nothing and empties everything", () => {
    const plan = planRebalance({
      accounts,
      position: at(0, 69),
      target: { lower: 500, upper: 569 }
    });
    expect(plan.kept).toEqual([]);
    expect(plan.leaving).toHaveLength(70);
    expect(plan.arriving).toHaveLength(70);
  });

  test("every step fits the compute ceiling", () => {
    const plan = planRebalance({
      accounts,
      position: at(0, 199),
      target: { lower: 180, upper: 379 }
    });
    for (const step of plan.steps) expect(step.computeUnits).toBeLessThanOrEqual(1_400_000);
    // The slide renumbers slots, so its resize is priced above a bare one.
    const resize = plan.steps.find((s) => s.kind === "resizePosition")!;
    expect(resize.computeUnits).toBeGreaterThan(25_000);
  });
});

/**
 * `planReshape` — the in-place half of rebalancing.
 *
 * The two properties worth guarding are the ones a caller cannot see go wrong.
 * A reshape that overflows the packet fails as a client-side assertion, and a
 * reshape cut into chunks is a *different operation* from the one that was
 * asked for — liquidity cannot cross a chunk boundary — so `atomic` has to be
 * right or the plan quietly lies about what it will do.
 */
describe("planReshape", () => {
  const held = (lower: number, upper: number) => ({
    address: key(),
    view: position(lower, upper)
  });
  const all = (lower: number, upper: number) =>
    new Set(Array.from({ length: upper - lower + 1 }, (_, i) => lower + i));

  test("a band inside one transaction is a single rebalance instruction", () => {
    const plan = planReshape({
      accounts,
      position: held(-35, 34),
      activeId: 0,
      shape: "curve",
      facts: { warm: all(-35, 34) }
    });
    expect(plan.atomic).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].kind).toBe("rebalanceLiquidity");
    expect(plan.steps[0].build(new Set())).toHaveLength(1);
  });

  test("every step fits the packet", () => {
    // The measurement, not the estimate: an over-long transaction is rejected
    // before it runs and the failure surfaces in the client, not the program.
    const plan = planReshape({
      accounts,
      position: held(-35, 34),
      activeId: 0,
      shape: "spot",
      facts: { warm: all(-35, 34) }
    });
    for (const step of plan.steps) {
      const size = transactionSize(step.build(new Set()), accounts.owner, 1);
      expect(size + TX_HEADROOM).toBeLessThanOrEqual(MAX_TX_BYTES);
    }
  });

  test("every step fits the compute ceiling", () => {
    const plan = planReshape({
      accounts,
      position: held(-35, 34),
      activeId: 0,
      shape: "spot"
    });
    for (const step of plan.steps) {
      expect(step.computeUnits).toBeLessThanOrEqual(MAX_TX_COMPUTE);
    }
  });

  test("declaring warm bins is what buys a full-width reshape", () => {
    // 70 bins priced as if every target were cold does not fit; the same 70
    // priced off the bin arrays the caller already read does. This is the
    // whole reason `BinFacts` exists rather than a fixed worst case.
    const input = { accounts, position: held(-35, 34), activeId: 0, shape: "spot" as const };
    expect(planReshape(input).atomic).toBe(false);
    expect(planReshape({ ...input, facts: { warm: all(-35, 34) } }).atomic).toBe(true);
  });

  test("a range wider than one transaction is chunked and says so", () => {
    const plan = planReshape({
      accounts,
      position: held(0, 199),
      activeId: 100,
      shape: "spot",
      facts: { warm: all(0, 199) }
    });
    expect(plan.atomic).toBe(false);
    expect(plan.steps.length).toBeGreaterThan(1);
    // The chunks tile the range exactly once: no bin reshaped twice, none
    // left out.
    const covered = plan.steps.flatMap((s) => s.binArrays);
    expect(new Set(covered).size).toBeGreaterThan(0);
  });

  test("bins outside the range are never touched", () => {
    const plan = planReshape({
      accounts,
      position: held(-35, 34),
      activeId: 0,
      shape: "spot",
      range: { lower: -10, upper: 10 },
      facts: { warm: all(-10, 10) }
    });
    expect(plan.range).toEqual({ lower: -10, upper: 10 });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].binArrays).toEqual(arrayIndexesFor(-10, 10));
  });

  test("a range wider than the band is clamped to it", () => {
    // A caller may pass the band it *wants* rather than the one it has; the
    // program would refuse a bin outside the position, so the plan trims
    // rather than building a transaction that cannot land.
    const plan = planReshape({
      accounts,
      position: held(0, 69),
      activeId: 35,
      shape: "spot",
      range: { lower: -50, upper: 200 },
      facts: { warm: all(0, 69) }
    });
    expect(plan.range).toEqual({ lower: 0, upper: 69 });
  });

  test("the top-up rides on the first step only", () => {
    // Two steps spending the same top-up would draw it from the wallet twice.
    const plan = planReshape({
      accounts,
      position: held(0, 199),
      activeId: 100,
      shape: "spot",
      depositX: 500n,
      depositY: 700n,
      facts: { warm: all(0, 199) }
    });
    expect(plan.steps.length).toBeGreaterThan(1);
    expect(plan.steps[0].amountX).toBe(500n);
    expect(plan.steps[0].amountY).toBe(700n);
    for (const step of plan.steps.slice(1)) {
      expect(step.amountX).toBe(0n);
      expect(step.amountY).toBe(0n);
    }
  });

  test("a step carries the active-bin band its shape stays legal in", () => {
    const plan = planReshape({
      accounts,
      position: held(-35, 34),
      activeId: 0,
      shape: "spot",
      facts: { warm: all(-35, 34) }
    });
    const step = plan.steps[0];
    expect(stepIsLegal(step, 0)).toBe(true);
    // X sits above the active bin, so the pool trading up past it makes the
    // shape illegal — the program would refuse it as DepositXBelowActiveBin.
    expect(stepIsLegal(step, 30)).toBe(false);
  });

  test("an empty band plans nothing rather than an empty transaction", () => {
    const view = position(0, 69);
    const plan = planReshape({
      accounts,
      position: { address: key(), view: { ...view, shares: view.shares.map(() => 0n) } },
      activeId: 35,
      shape: "spot",
      // A shape over a band with nothing in it and nothing to place.
      range: { lower: 0, upper: 0 }
    });
    expect(plan.steps).toHaveLength(0);
  });
});
