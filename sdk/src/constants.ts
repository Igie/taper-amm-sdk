/**
 * Program address, layout sizes, and the Anchor discriminators.
 *
 * These are the parts of the ABI that are pure data. Everything else in this
 * package is derived from them, so a layout drift on chain shows up here
 * first — `ACCOUNT_LEN` doubles as the `dataSize` filter used to enumerate
 * accounts, so a wrong size means an empty pool list rather than a subtle
 * misparse.
 */
import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("taperAJP7yuCyqnFUW3Xa3byvQ2YRY29w73NJrjYRUd");

export const BINS_PER_ARRAY = 70;

/**
 * Bins whose data sits inline in the fixed `Position` struct.
 *
 * A position account is this many bins plus, appended, one 64-byte record per
 * bin beyond them. So the inline block is both the minimum size and the
 * boundary every byte offset below stays fixed across.
 */
export const INLINE_BINS_PER_POSITION = 70;

/**
 * Widest band one position may declare.
 *
 * A full-width position is about 89 KB and 0.63 SOL of rent, so this is a
 * ceiling rather than a target. It is DLMM's number.
 */
export const MAX_BINS_PER_POSITION = 1_400;

/** Bytes one bin past the inline block costs. */
export const POSITION_BIN_DATA_SIZE = 64;

/**
 * Bins one `resize_position` may **add**. Shrinking is uncapped.
 *
 * The runtime caps an account's growth at 10,240 bytes per *transaction*,
 * measured from its length when the transaction began — so two resizes in one
 * transaction share this budget rather than doubling it. Send one per
 * transaction.
 */
export const MAX_BINS_PER_EXTEND = 160;
export const ONE_Q64 = 1n << 64n;
/** `[u64; 16]` of bin-array occupancy, covering indexes -512..511. */
export const MIN_BIN_ARRAY_INDEX = -512;
export const MAX_BIN_ARRAY_INDEX = 511;
export const FEE_PRECISION = 1_000_000_000;
export const MAX_FEE_RATE = 100_000_000;
/** Ceiling on a config's `protocolShare`, in bps of the trading fee. */
export const MAX_PROTOCOL_SHARE = 2_500;

/**
 * Account sizes, and the `dataSize` filters that enumerate them.
 *
 * `position` is the odd one: it is a *minimum*, not a size. A position grows
 * past it, so it can never be used as a `dataSize` filter — see
 * `positionFilters`, which matches on the discriminator instead.
 */
export const ACCOUNT_LEN = { config: 168, pool: 432, binArray: 6792, position: 4616 } as const;

/** Bytes a position account occupies with storage for `bins` of its band. */
export const positionLenFor = (bins: number) =>
  bins <= INLINE_BINS_PER_POSITION
    ? ACCOUNT_LEN.position
    : ACCOUNT_LEN.position + (bins - INLINE_BINS_PER_POSITION) * POSITION_BIN_DATA_SIZE;

/** Bins a position account of this length has storage for. */
export const positionCapacityFor = (len: number) =>
  len <= ACCOUNT_LEN.position
    ? INLINE_BINS_PER_POSITION
    : INLINE_BINS_PER_POSITION + Math.floor((len - ACCOUNT_LEN.position) / POSITION_BIN_DATA_SIZE);

/**
 * `sha256("account:<Name>")[..8]`, the eight bytes Anchor writes at the front
 * of every account it owns.
 *
 * Only `position` is needed today, and it is needed because a position is the
 * one account whose *size* varies — so it cannot be enumerated by `dataSize`
 * the way the other three are.
 */
export const ACCOUNT_DISCRIMINATORS = {
  config: [155, 12, 170, 224, 30, 250, 204, 130],
  pool: [241, 154, 109, 4, 17, 177, 109, 188],
  binArray: [92, 142, 92, 220, 5, 148, 70, 181],
  position: [170, 188, 143, 228, 122, 64, 247, 208]
} as const;

/** `sha256("global:<name>")[..8]`, as Anchor generates them. */
export const DISCRIMINATORS = {
  initializeConfig: [208, 127, 21, 1, 194, 190, 196, 70],
  initializePool: [95, 180, 10, 172, 84, 174, 232, 40],
  initializeBinArray: [35, 86, 19, 185, 78, 212, 75, 211],
  initializePosition: [219, 192, 234, 71, 190, 191, 102, 80],
  resizePosition: [253, 57, 59, 172, 87, 25, 175, 115],
  addLiquidity: [181, 157, 89, 67, 143, 182, 52, 72],
  removeLiquidity: [80, 85, 209, 72, 24, 206, 177, 108],
  rebalanceLiquidity: [92, 4, 176, 193, 119, 185, 83, 9],
  claimFee: [169, 32, 79, 137, 136, 232, 70, 137],
  closePosition: [123, 134, 81, 0, 49, 68, 98, 98],
  swap: [248, 198, 158, 145, 225, 117, 135, 200],
  swapStrict: [15, 167, 210, 168, 62, 143, 10, 227],
  withdrawProtocolFee: [158, 201, 158, 189, 33, 93, 162, 103],
  setPoolStatus: [112, 87, 135, 223, 83, 204, 132, 53],
  updateConfig: [29, 158, 252, 191, 10, 83, 219, 99]
} as const;

/** Pool status byte, as `PoolStatus` on chain. */
export const POOL_ENABLED = 0;
export const POOL_DISABLED = 1;

/** `TokenProgramFlag` on chain. */
export const FLAG_SPL_TOKEN = 0;
export const FLAG_TOKEN_2022 = 1;
