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
export const MAX_BINS_PER_POSITION = 70;
export const ONE_Q64 = 1n << 64n;
/** `[u64; 16]` of bin-array occupancy, covering indexes -512..511. */
export const MIN_BIN_ARRAY_INDEX = -512;
export const MAX_BIN_ARRAY_INDEX = 511;
export const FEE_PRECISION = 1_000_000_000;
export const MAX_FEE_RATE = 100_000_000;
/** Ceiling on a config's `protocolShare`, in bps of the trading fee. */
export const MAX_PROTOCOL_SHARE = 2_500;

export const ACCOUNT_LEN = { config: 168, pool: 432, binArray: 6792, position: 4616 } as const;

/** `sha256("global:<name>")[..8]`, as Anchor generates them. */
export const DISCRIMINATORS = {
  initializeConfig: [208, 127, 21, 1, 194, 190, 196, 70],
  initializePool: [95, 180, 10, 172, 84, 174, 232, 40],
  initializeBinArray: [35, 86, 19, 185, 78, 212, 75, 211],
  initializePosition: [219, 192, 234, 71, 190, 191, 102, 80],
  addLiquidity: [181, 157, 89, 67, 143, 182, 52, 72],
  removeLiquidity: [80, 85, 209, 72, 24, 206, 177, 108],
  claimFee: [169, 32, 79, 137, 136, 232, 70, 137],
  closePosition: [123, 134, 81, 0, 49, 68, 98, 98],
  swap: [248, 198, 158, 145, 225, 117, 135, 200],
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
