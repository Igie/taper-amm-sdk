/**
 * Account parsers, read by byte offset.
 *
 * The offsets here are the ABI. They are duplicated in
 * `programs/taper-amm/src/state/` (the structs), `tests/src/lib.rs` (the Rust
 * client) and this file — CLAUDE.md lists them as the places that change
 * together. `ui/scripts/e2e.ts` is what catches a drift in this copy.
 */
import { PublicKey } from "@solana/web3.js";
import { ACCOUNT_LEN, MIN_BIN_ARRAY_INDEX } from "./constants";
import { i32At, i64At, keyAt, u128At, u16At, u32At, u64At, u8At } from "./codec";
import { binArrayLower } from "./pda";
import { q64ToNumber } from "./ladder";
import type { BinView, ConfigView, PoolView, PositionView } from "./types";

export function parseConfig(d: Uint8Array): ConfigView {
  return {
    authority: keyAt(d, 8),
    baseWidthQ64: u128At(d, 40),
    taperQ64: u128At(d, 56),
    minBinId: i32At(d, 72),
    maxBinId: i32At(d, 76),
    index: u16At(d, 80),
    baseFactor: u16At(d, 82),
    baseFeePowerFactor: u8At(d, 84),
    protocolShare: u16At(d, 85),
    collectFeeMode: u8At(d, 87),
    filterPeriod: u16At(d, 88),
    decayPeriod: u16At(d, 90),
    reductionFactor: u16At(d, 92),
    variableFeeControl: u32At(d, 94),
    maxVolatilityAccumulator: u32At(d, 98)
  };
}

export function parsePool(d: Uint8Array): PoolView {
  // `bin_array_bitmap` is [u64; 16] at offset 200, one bit per array index
  // starting at -512. The program keeps it current but does not route on it;
  // for a client it is the cheap answer to "where is there liquidity".
  const occupiedArrays = new Set<number>();
  for (let word = 0; word < 16; word += 1) {
    let bits = u64At(d, 200 + word * 8);
    if (bits === 0n) continue;
    for (let bit = 0; bit < 64; bit += 1) {
      if (bits & 1n) occupiedArrays.add(MIN_BIN_ARRAY_INDEX + word * 64 + bit);
      bits >>= 1n;
    }
  }
  return {
    config: keyAt(d, 8),
    tokenXMint: keyAt(d, 40),
    tokenYMint: keyAt(d, 72),
    reserveX: keyAt(d, 104),
    reserveY: keyAt(d, 136),
    creator: keyAt(d, 168),
    occupiedArrays,
    protocolFeeX: u64At(d, 328),
    protocolFeeY: u64At(d, 336),
    lastUpdateTimestamp: i64At(d, 344),
    activeId: i32At(d, 352),
    indexReference: i32At(d, 356),
    volatilityAccumulator: u32At(d, 360),
    volatilityReference: u32At(d, 364),
    status: u8At(d, 368),
    tokenXFlag: u8At(d, 370),
    tokenYFlag: u8At(d, 371),
    tokenXDecimals: u8At(d, 372),
    tokenYDecimals: u8At(d, 373)
  };
}

export function parsePosition(d: Uint8Array): PositionView {
  const lowerBinId = i32At(d, 4576);
  const upperBinId = i32At(d, 4580);
  const width = upperBinId - lowerBinId + 1;
  return {
    pool: keyAt(d, 8),
    owner: keyAt(d, 40),
    lowerBinId,
    upperBinId,
    lastUpdatedAt: i64At(d, 4552),
    totalClaimedFeeX: u64At(d, 4560),
    totalClaimedFeeY: u64At(d, 4568),
    shares: Array.from({ length: width }, (_, i) => u128At(d, 72 + i * 16)),
    // PositionBinFee is 48 bytes: two Q64.64 checkpoints then the two pendings.
    pendingFeeX: Array.from({ length: width }, (_, i) => u64At(d, 1192 + i * 48 + 32)),
    pendingFeeY: Array.from({ length: width }, (_, i) => u64At(d, 1192 + i * 48 + 40)),
    checkpointX: Array.from({ length: width }, (_, i) => u128At(d, 1192 + i * 48)),
    checkpointY: Array.from({ length: width }, (_, i) => u128At(d, 1192 + i * 48 + 16))
  };
}

/** Reads one bin out of the array account that holds it. */
export function parseBin(d: Uint8Array, arrayIndex: number, binId: number): BinView {
  const offset = 72 + (binId - binArrayLower(arrayIndex)) * 96;
  const priceQ64 = u128At(d, offset + 16);
  return {
    binId,
    amountX: u64At(d, offset),
    amountY: u64At(d, offset + 8),
    priceQ64,
    price: q64ToNumber(priceQ64),
    liquiditySupply: u128At(d, offset + 32),
    feeXPerShare: u128At(d, offset + 48),
    feeYPerShare: u128At(d, offset + 64),
    stepBpX100: u32At(d, offset + 80),
    derived: priceQ64 !== 0n
  };
}

/**
 * What a position has earned in a bin but not yet been credited with.
 *
 * The program only moves fee growth into `fee_*_pending` when it touches the
 * position — on a deposit, a withdrawal or a claim — so reading the stored
 * pending value alone reports zero for a position that has been earning all
 * along. Mirrors `accrued_fee`: `(share * growth_delta) >> 128`.
 */
export function accruedFee(share: bigint, growth: bigint, checkpoint: bigint) {
  if (share === 0n || growth <= checkpoint) return 0n;
  return (share * (growth - checkpoint)) >> 128n;
}

// --------------------------------------------- getProgramAccounts filters

/** Positions this owner holds, optionally narrowed to one pool. */
export function positionFilters(owner: PublicKey, pool?: PublicKey) {
  const filters: unknown[] = [
    { dataSize: ACCOUNT_LEN.position },
    { memcmp: { offset: 40, bytes: owner.toBase58() } }
  ];
  if (pool) filters.push({ memcmp: { offset: 8, bytes: pool.toBase58() } });
  return filters;
}

/** Every pool, or only those under one config. */
export function poolFilters(config?: PublicKey) {
  const filters: unknown[] = [{ dataSize: ACCOUNT_LEN.pool }];
  if (config) filters.push({ memcmp: { offset: 8, bytes: config.toBase58() } });
  return filters;
}

/** Every config, or only those an authority owns. */
export function configFilters(authority?: PublicKey) {
  const filters: unknown[] = [{ dataSize: ACCOUNT_LEN.config }];
  if (authority) filters.push({ memcmp: { offset: 8, bytes: authority.toBase58() } });
  return filters;
}
