/**
 * The price ladder, re-derived in `f64`.
 *
 * This is an independent implementation of the formulas in the program's
 * `math::ladder`, written from the paper definitions rather than from the Rust,
 * so anything drawn or previewed from it is a genuine cross-check of the
 * on-chain integer math and not an echo of it.
 *
 * ```text
 *   w(i) = w0 * tau^i                     bin width, in log2 price
 *   v(i) = w0 * (1 - tau^i) / (1 - tau)   log2 price of bin i
 *   P(i) = 2^v(i)                         anchored at P(0) = 1.0
 * ```
 */
import {
  BINS_PER_ARRAY,
  MAX_BIN_ARRAY_INDEX,
  MAX_FEE_RATE,
  MAX_PROTOCOL_SHARE,
  MIN_BIN_ARRAY_INDEX,
  ONE_Q64
} from "./constants";
import type { ConfigParams } from "./types";

export const q64ToNumber = (v: bigint) => Number(v >> 64n) + Number(v & (ONE_Q64 - 1n)) / 2 ** 64;
export const f64ToQ64 = (v: number) => BigInt(Math.floor(v * 2 ** 64));

/** `w0` giving a bin step of `bps` basis points at the anchor. */
export const widthForBps = (bps: number) => f64ToQ64(Math.log2(1 + bps / 10_000));

/** `tau` halving the bin width every `bins` bins going up. */
export const taperForHalfLife = (bins: number) =>
  Number.isFinite(bins) && bins > 0 ? f64ToQ64(2 ** (-1 / bins)) : ONE_Q64;

export const halfLifeForTaper = (taperQ64: bigint) => {
  const tau = q64ToNumber(taperQ64);
  return tau >= 1 ? Infinity : -1 / Math.log2(tau);
};

export const bpsForWidth = (baseWidthQ64: bigint) => (2 ** q64ToNumber(baseWidthQ64) - 1) * 10_000;

export class Ladder {
  readonly w0: number;
  readonly tau: number;

  constructor(baseWidthQ64: bigint, taperQ64: bigint) {
    this.w0 = q64ToNumber(baseWidthQ64);
    this.tau = q64ToNumber(taperQ64);
  }

  /** `w(i) = w0 * tau^i`, in log2 price. */
  width(id: number) {
    return this.w0 * this.tau ** id;
  }

  /** `v(i) = w0 * (1 - tau^i) / (1 - tau)`, the closed form. */
  log2Price(id: number) {
    return this.tau === 1 ? this.w0 * id : (this.w0 * (1 - this.tau ** id)) / (1 - this.tau);
  }

  price(id: number) {
    return 2 ** this.log2Price(id);
  }

  /** Bin width in hundredths of a basis point, as the program stores it. */
  stepBpX100(id: number) {
    return Math.round((2 ** this.width(id) - 1) * 1_000_000);
  }

  /** The asymptote `2^(w0/(1-tau))`. Infinite for a uniform ladder. */
  priceCeiling() {
    return this.tau === 1 ? Infinity : 2 ** (this.w0 / (1 - this.tau));
  }

  /** Total swap fee for crossing this bin, against `FEE_PRECISION`. */
  feeRate(id: number, config: ConfigParams, volatilityAccumulator: number) {
    return feeRateForStep(this.stepBpX100(id), config, volatilityAccumulator);
  }
}

/** A ladder read straight off a config account. */
export const ladderOf = (config: Pick<ConfigParams, "baseWidthQ64" | "taperQ64">) =>
  new Ladder(config.baseWidthQ64, config.taperQ64);

/**
 * Mirrors `base_fee_rate` + `variable_fee_rate`, capped at `MAX_FEE_RATE`.
 *
 * Takes the step rather than the bin id because the width is stored *per bin*
 * — under a taper it is not a pool constant — and the on-chain value is the
 * authority once a bin has been touched.
 */
export function feeRateForStep(
  stepBpX100: number,
  config: Pick<ConfigParams, "baseFactor" | "baseFeePowerFactor" | "variableFeeControl">,
  volatilityAccumulator: number
) {
  const base = Math.floor((config.baseFactor * stepBpX100 * 10 ** config.baseFeePowerFactor) / 10);
  // `ceil(variable_fee_control * (va * step)^2 / 1e15)`
  const x = volatilityAccumulator * stepBpX100;
  const variable = config.variableFeeControl ? Math.ceil((x * x * config.variableFeeControl) / 1e15) : 0;
  return Math.min(base + variable, MAX_FEE_RATE);
}

/**
 * Widest band the ladder stays sound over. The program *verifies* this range
 * rather than searching for it, so the client has to hand it a correct answer;
 * the bounds mirror `Ladder::validate_range`.
 */
export function usableRange(baseWidthQ64: bigint, taperQ64: bigint) {
  const ladder = new Ladder(baseWidthQ64, taperQ64);
  const ok = (id: number) => {
    const v = ladder.log2Price(id);
    const step = ladder.stepBpX100(id);
    const w = ladder.width(id);
    return v > -60 && v < 60 && step >= 1 && step <= 40_000 && v + Math.log2(w) > -62;
  };
  const find = (dir: -1 | 1) => {
    let lo = 0;
    let hi = 1;
    while (hi < 400_000 && ok(dir * hi)) {
      lo = hi;
      hi *= 2;
    }
    let a = lo;
    let b = Math.min(hi, 400_000);
    while (a + 1 < b) {
      const mid = a + Math.floor((b - a) / 2);
      if (ok(dir * mid)) a = mid;
      else b = mid;
    }
    return a;
  };
  // Two bins of slack, and never wider than the bitmap can address.
  //
  // The slack only ever shrinks the band. A bound is never pushed out to a bin
  // that failed `ok` above: widths grow going down, so with `w0` near the
  // 400 bps cap there may be no valid bin below the anchor at all, and
  // claiming one produces a config the program rejects outright.
  const min = Math.max(-Math.max(find(-1) - 2, 0), MIN_BIN_ARRAY_INDEX * BINS_PER_ARRAY);
  const max = Math.min(Math.max(find(1) - 2, 0), (MAX_BIN_ARRAY_INDEX + 1) * BINS_PER_ARRAY - 1);
  return [min, max] as const;
}

export function buildConfig(
  index: number,
  bps: number,
  halfLife: number,
  overrides: Partial<ConfigParams> = {}
): ConfigParams {
  const baseWidthQ64 = widthForBps(bps);
  const taperQ64 = taperForHalfLife(halfLife);
  const [minBinId, maxBinId] = usableRange(baseWidthQ64, taperQ64);
  // `validate_range` requires `min < max`, and rejects a widest bin above
  // 400 bps. Both fail here rather than as a program error, because the only
  // fix is a different `bps`/`halfLife` and the caller is the one who has it.
  if (minBinId >= maxBinId) {
    throw new Error(
      `A ${bps} bps anchor with a ${halfLife} bin half-life leaves no usable band: ` +
        "bin widths grow going down and cap at 400 bps, so a wide anchor has nowhere below it. " +
        "Use a narrower step, or a longer half-life."
    );
  }
  return {
    index,
    baseWidthQ64,
    taperQ64,
    minBinId,
    maxBinId,
    baseFactor: 10_000,
    baseFeePowerFactor: 0,
    protocolShare: 1_000,
    collectFeeMode: 0,
    filterPeriod: 30,
    decayPeriod: 600,
    reductionFactor: 5_000,
    variableFeeControl: 40_000,
    maxVolatilityAccumulator: 350_000,
    ...overrides
  };
}

/**
 * Mirrors `Config::validate`, so a form can say what is wrong before a
 * transaction says it less clearly.
 *
 * Returns one message per broken rule, empty when the config would be
 * accepted. This is a *client* check: the program validates independently and
 * is the authority. It is kept here, beside `usableRange`, because the two
 * stand in the same relation to the chain — the program verifies what a client
 * computes, so a client that computes a wrong answer produces a config the
 * chain rejects outright.
 */
export function validateConfig(params: ConfigParams): string[] {
  const problems: string[] = [];

  const [usableMin, usableMax] = usableRange(params.baseWidthQ64, params.taperQ64);
  if (params.minBinId >= params.maxBinId) {
    problems.push("The band is empty: the lower bin must sit below the upper one.");
  }
  if (params.minBinId < usableMin || params.maxBinId > usableMax) {
    problems.push(
      `The band must sit inside ${usableMin.toLocaleString()} to ${usableMax.toLocaleString()}, ` +
        "where this ladder's bin widths stay between 0.01 and 400 bps and the bitmap can reach."
    );
  }
  if (params.protocolShare > MAX_PROTOCOL_SHARE) {
    problems.push(`Protocol share is capped at ${MAX_PROTOCOL_SHARE / 100}% of the fee.`);
  }
  if (params.baseFactor <= 0) problems.push("Base factor must be above zero.");
  if (params.baseFeePowerFactor > 10) problems.push("Base fee power factor is capped at 10.");
  if (params.reductionFactor > 10_000) problems.push("Reduction factor is a bps value, so at most 10,000.");
  if (params.filterPeriod > params.decayPeriod) {
    problems.push("Filter period must not exceed the decay period.");
  }
  if (params.collectFeeMode !== 0 && params.collectFeeMode !== 1) {
    problems.push("Collect fee mode must be 0 (input token) or 1 (quote only).");
  }
  // A variable fee that can never engage is a mistake, not a disabled
  // feature; disabling is expressed by a zero control.
  if (params.variableFeeControl > 0 && params.maxVolatilityAccumulator === 0) {
    problems.push(
      "A non-zero variable fee control needs a non-zero max volatility accumulator, or it can never engage. " +
        "Set the control to zero to turn the variable fee off."
    );
  }
  return problems;
}

/**
 * The bin whose price is closest to `price`, expressed in lamport terms.
 *
 * Pool prices are Y-lamports per X-lamport, so a human-facing price has to be
 * scaled by the decimal difference before it can be located on the ladder.
 * Inverted by `displayPrice`.
 */
export function binIdForPrice(
  ladder: Ladder,
  price: number,
  decimalsX: number,
  decimalsY: number,
  range: readonly [number, number]
) {
  const target = Math.log2(price * 10 ** (decimalsY - decimalsX));
  const [min, max] = range;
  // v(i) is strictly increasing in i, so a plain bisection lands the bin.
  let lo = min;
  let hi = max;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ladder.log2Price(mid) < target) lo = mid + 1;
    else hi = mid;
  }
  // Bisection gives the first bin at or above the target; the one below may be
  // nearer in log space.
  const below = Math.max(lo - 1, min);
  const dLo = Math.abs(ladder.log2Price(lo) - target);
  const dBelow = Math.abs(ladder.log2Price(below) - target);
  return dBelow < dLo ? below : lo;
}

/** A bin's lamport price as a human-facing Y-per-X price. */
export const displayPrice = (priceQ64OrNumber: bigint | number, decimalsX: number, decimalsY: number) => {
  const p = typeof priceQ64OrNumber === "bigint" ? q64ToNumber(priceQ64OrNumber) : priceQ64OrNumber;
  return p * 10 ** (decimalsX - decimalsY);
};
