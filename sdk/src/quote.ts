/**
 * A client-side swap quote.
 *
 * This is a line-by-line mirror of `instructions::swap` and `math::swap`, in
 * `bigint`. It exists because `min_amount_out` is the only thing standing
 * between a trader and a fill they did not want, and a slippage bound computed
 * from a guess is worse than none — it either rejects good fills or permits
 * bad ones.
 *
 * Mirroring means mirroring the rounding. Outputs floor and required inputs
 * ceil, always in the pool's favour; the volatility accumulator is advanced
 * per bin crossed, exactly as the walk does, because under a taper the fee is
 * a function of the bin being crossed rather than a pool constant.
 *
 * The quote is exact for the state it was given. It is still only a quote:
 * another trade landing first moves the active bin, which is what slippage
 * tolerance is for.
 */
import { FEE_PRECISION, MAX_FEE_RATE, ONE_Q64 } from "./constants";
import { binArrayIndex } from "./pda";
import { feeRateForStep } from "./ladder";
import type { BinView, ConfigView, PoolView } from "./types";

/** `MAX_BINS_PER_SWAP` in the program. */
export const MAX_BINS_PER_SWAP = 200;

const U64_MAX = (1n << 64n) - 1n;
const PRECISION = BigInt(FEE_PRECISION);

const clampU64 = (v: bigint) => (v > U64_MAX ? U64_MAX : v);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** `ceil(amount * rate / 1e9)` — a fee carved out of an amount. */
const feeFromAmount = (amount: bigint, rate: bigint) =>
  rate === 0n ? 0n : clampU64(ceilDiv(amount * rate, PRECISION));

/** `ceil(amount * rate / (1e9 - rate))` — a fee added on top of a net amount. */
const feeOnAmount = (amount: bigint, rate: bigint) =>
  rate === 0n ? 0n : clampU64(ceilDiv(amount * rate, PRECISION - rate));

const outputFor = (netIn: bigint, priceQ64: bigint, swapForY: boolean) =>
  swapForY ? (netIn * priceQ64) / ONE_Q64 : (netIn * ONE_Q64) / priceQ64;

export type BinSwap = {
  amountIn: bigint;
  amountOut: bigint;
  fee: bigint;
  binIn: bigint;
  binOut: bigint;
};

const NOOP: BinSwap = { amountIn: 0n, amountOut: 0n, fee: 0n, binIn: 0n, binOut: 0n };
const isNoop = (r: BinSwap) => r.amountIn === 0n && r.amountOut === 0n;

/** Mirrors `math::swap::swap_in_bin`. */
export function swapInBin(
  binAmountX: bigint,
  binAmountY: bigint,
  priceQ64: bigint,
  amountInLeft: bigint,
  swapForY: boolean,
  feeRate: bigint,
  feeOnOutput: boolean
): BinSwap {
  const maxBinOut = swapForY ? binAmountY : binAmountX;
  if (maxBinOut === 0n || amountInLeft === 0n || priceQ64 === 0n) return NOOP;

  // Input, net of any input-side fee, that would drain the bin. Saturating is
  // correct: a requirement past u64 cannot be met by `amountInLeft` anyway.
  const maxNetIn = clampU64(
    swapForY ? ceilDiv(maxBinOut * ONE_Q64, priceQ64) : ceilDiv(maxBinOut * priceQ64, ONE_Q64)
  );

  if (feeOnOutput) {
    // Quote-only collection on an X -> Y swap: the whole input enters the bin
    // and the fee is taken out of the Y leaving it.
    let amountIn: bigint;
    let binOut: bigint;
    if (amountInLeft >= maxNetIn) {
      amountIn = maxNetIn;
      binOut = maxBinOut;
    } else {
      amountIn = amountInLeft;
      const out = outputFor(amountInLeft, priceQ64, swapForY);
      binOut = out < maxBinOut ? out : maxBinOut;
    }
    if (binOut === 0n) return NOOP;
    const fee = feeFromAmount(binOut, feeRate);
    return { amountIn, amountOut: binOut - fee, fee, binIn: amountIn, binOut };
  }

  // Fee on the input side.
  const maxFee = feeOnAmount(maxNetIn, feeRate);
  const maxGrossIn = maxNetIn + maxFee;

  if (maxGrossIn <= U64_MAX && amountInLeft >= maxGrossIn) {
    return {
      amountIn: maxGrossIn,
      amountOut: maxBinOut,
      fee: maxFee,
      binIn: maxNetIn,
      binOut: maxBinOut
    };
  }

  const fee = feeFromAmount(amountInLeft, feeRate);
  const net = amountInLeft - fee;
  const raw = outputFor(net, priceQ64, swapForY);
  const out = raw < maxBinOut ? raw : maxBinOut;
  if (out === 0n) return NOOP;
  return { amountIn: amountInLeft, amountOut: out, fee, binIn: net, binOut: out };
}

export type QuoteInput = {
  pool: PoolView;
  config: ConfigView;
  /** Bins by id. Only bins the program has derived can trade. */
  bins: Map<number, BinView>;
  /** Whether the bin array covering an index was supplied to the swap. */
  hasArray: (index: number) => boolean;
  /** Input in *arrival* units — after the input mint's transfer fee. */
  amountIn: bigint;
  swapForY: boolean;
  /** Unix seconds the transaction will land at. Drives the volatility decay. */
  now: number;
};

/** One bin's contribution to a walk, in the order the walk visited them. */
export type BinFill = BinSwap & {
  binId: number;
  priceQ64: bigint;
  /** The rate this bin charged, against `FEE_PRECISION`. */
  feeRate: bigint;
};

/**
 * The pool fields the walk advanced.
 *
 * A quote is a pure function of the state it is handed, so simulating a
 * *sequence* of swaps — a round trip, a route, a backtest — means feeding this
 * back in along with the bin inventories `fills` moved. It is exactly what
 * `instructions::swap` leaves on the pool account.
 */
export type WalkState = {
  activeId: number;
  indexReference: number;
  volatilityAccumulator: number;
  volatilityReference: number;
  lastUpdateTimestamp: bigint;
};

export type Quote = {
  /** Consumed from the budget. Less than `amountIn` on a partial fill. */
  amountIn: bigint;
  /** Delivered from the reserves, before the output mint's transfer fee. */
  amountOut: bigint;
  /** Total swap fee, in whichever token the mode collects it. */
  fee: bigint;
  binsCrossed: number;
  startId: number;
  endId: number;
  /** True when the pool could not absorb the whole input. */
  partial: boolean;
  /** Average execution price, Y-lamports per X-lamport. */
  executionPrice: number;
  /** Fee as a fraction of the input actually consumed. */
  effectiveFeeRate: number;
  /** Per-bin detail, in visit order. */
  fills: BinFill[];
  /** Pool state after the walk. */
  state: WalkState;
};

/**
 * Walks the ladder the way the program does and reports what would come back.
 *
 * `hasArray` matters as much as the bins do: the program breaks its walk the
 * moment it needs an array that was not passed as a remaining account, so a
 * quote that ignored array availability would promise fills the transaction
 * cannot deliver. Use `swapArrayIndexes` to build both from the same source.
 */
export function quoteSwap({
  pool,
  config,
  bins,
  hasArray,
  amountIn,
  swapForY,
  now
}: QuoteInput): Quote {
  const startId = pool.activeId;
  let activeId = startId;
  let amountLeft = amountIn;
  let totalIn = 0n;
  let totalOut = 0n;
  let totalFee = 0n;
  let crossed = 0;
  const fills: BinFill[] = [];

  const feeOnOutput = config.collectFeeMode === 1 && swapForY;
  const step = swapForY ? -1 : 1;
  const inBand = (id: number) => id >= config.minBinId && id <= config.maxBinId;

  // `update_references`: decay the reference if the pool has been idle past
  // the filter period, then re-anchor it.
  let indexReference = pool.indexReference;
  let volatilityReference = pool.volatilityReference;
  const elapsed = now - Number(pool.lastUpdateTimestamp);
  if (elapsed >= config.filterPeriod) {
    indexReference = pool.activeId;
    volatilityReference =
      elapsed < config.decayPeriod
        ? Math.floor((pool.volatilityAccumulator * config.reductionFactor) / 10_000)
        : 0;
  }
  let volatilityAccumulator = pool.volatilityAccumulator;

  for (let i = 0; i < MAX_BINS_PER_SWAP; i += 1) {
    if (amountLeft === 0n) break;
    if (!inBand(activeId)) break;
    if (!hasArray(binArrayIndex(activeId))) break;

    const bin = bins.get(activeId);
    const available = bin ? (swapForY ? bin.amountY : bin.amountX) : 0n;

    let filled = false;
    let exhausted = false;

    if (!bin || available === 0n) {
      exhausted = true;
    } else {
      // `update_volatility_accumulator`, per bin crossed.
      volatilityAccumulator = Math.min(
        volatilityReference + Math.abs(activeId - indexReference) * 10_000,
        config.maxVolatilityAccumulator
      );
      const feeRate = BigInt(
        Math.min(feeRateForStep(bin.stepBpX100, config, volatilityAccumulator), MAX_FEE_RATE)
      );

      const result = swapInBin(
        bin.amountX,
        bin.amountY,
        bin.priceQ64,
        amountLeft,
        swapForY,
        feeRate,
        feeOnOutput
      );

      if (isNoop(result)) {
        // The bin holds inventory but the remaining input buys none of it.
        break;
      }

      amountLeft -= result.amountIn;
      totalIn += result.amountIn;
      totalOut += result.amountOut;
      totalFee += result.fee;
      crossed += 1;
      filled = true;
      fills.push({ ...result, binId: activeId, priceQ64: bin.priceQ64, feeRate });
    }

    if (!filled && !exhausted) break;
    if (amountLeft === 0n) break;

    const next = activeId + step;
    if (!inBand(next)) break;
    activeId = next;
  }

  const executionPrice =
    totalIn > 0n && totalOut > 0n
      ? swapForY
        ? Number(totalOut) / Number(totalIn)
        : Number(totalIn) / Number(totalOut)
      : 0;

  return {
    amountIn: totalIn,
    amountOut: totalOut,
    fee: totalFee,
    binsCrossed: crossed,
    startId,
    endId: activeId,
    partial: totalIn < amountIn,
    executionPrice,
    effectiveFeeRate: totalIn > 0n ? Number(totalFee) / Number(totalIn) : 0,
    fills,
    state: {
      activeId,
      indexReference,
      volatilityAccumulator,
      volatilityReference,
      // `update_references` stamps the pool whether or not anything filled.
      lastUpdateTimestamp: BigInt(Math.trunc(now))
    }
  };
}

/**
 * `min_amount_out` for a quote at a given slippage tolerance, in bps.
 *
 * The program checks this against what *reaches the trader's wallet*, so the
 * output mint's transfer fee has already to have been applied to `amountOut`
 * before it gets here.
 */
export const minOutFor = (amountOut: bigint, slippageBps: number) =>
  (amountOut * BigInt(10_000 - Math.max(0, Math.min(10_000, Math.round(slippageBps))))) / 10_000n;
