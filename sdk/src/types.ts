/** The account shapes this package reads and writes, as plain TypeScript. */
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { FLAG_TOKEN_2022 } from "./constants";

/**
 * A pool's two mints with the token program that owns each.
 *
 * The sides are independent — a pool may pair a legacy SPL Token mint with a
 * Token-2022 one — so the mint and its program travel together, and every
 * instruction that moves tokens names both. `parsePool` reports the programs
 * as flags, so a client never has to fetch the mints just to build a
 * transaction.
 */
export type TokenPair = {
  mintX: PublicKey;
  programX: PublicKey;
  mintY: PublicKey;
  programY: PublicKey;
};

/** Both sides on the legacy SPL Token program. */
export function splTokenPair(mintX: PublicKey, mintY: PublicKey): TokenPair {
  return { mintX, programX: TOKEN_PROGRAM_ID, mintY, programY: TOKEN_PROGRAM_ID };
}

/** The pair a pool account describes, ready to hand to an instruction. */
export function tokenPairOf(pool: PoolView): TokenPair {
  const program = (flag: number) => (flag === FLAG_TOKEN_2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
  return {
    mintX: pool.tokenXMint,
    programX: program(pool.tokenXFlag),
    mintY: pool.tokenYMint,
    programY: program(pool.tokenYFlag)
  };
}

export type ConfigParams = {
  index: number;
  baseWidthQ64: bigint;
  taperQ64: bigint;
  minBinId: number;
  maxBinId: number;
  baseFactor: number;
  baseFeePowerFactor: number;
  protocolShare: number;
  collectFeeMode: number;
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  variableFeeControl: number;
  maxVolatilityAccumulator: number;
};

export type ConfigView = ConfigParams & { authority: PublicKey };

/**
 * What `update_config` may change, all optional: an omitted field is left
 * alone on chain rather than rewritten with a stale read.
 *
 * `baseWidthQ64` and `taperQ64` are absent on purpose. The ladder is fixed at
 * creation because bins cache their price as they are first touched, so
 * moving it would leave a live pool straddling two ladders. Publish a new
 * config instead.
 */
export type UpdateConfigParams = {
  /** Widening only: at most the current `minBinId`. */
  minBinId?: number;
  /** Widening only: at least the current `maxBinId`. */
  maxBinId?: number;
  baseFactor?: number;
  baseFeePowerFactor?: number;
  protocolShare?: number;
  collectFeeMode?: number;
  filterPeriod?: number;
  decayPeriod?: number;
  reductionFactor?: number;
  variableFeeControl?: number;
  maxVolatilityAccumulator?: number;
};

export type BinDist = { binId: number; distributionX: number; distributionY: number };
export type BinReduction = { binId: number; bps: number };

export type PoolView = {
  config: PublicKey;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  creator: PublicKey;
  occupiedArrays: Set<number>;
  protocolFeeX: bigint;
  protocolFeeY: bigint;
  lastUpdateTimestamp: bigint;
  activeId: number;
  indexReference: number;
  volatilityAccumulator: number;
  volatilityReference: number;
  status: number;
  /** 0 for SPL Token, 1 for Token-2022. */
  tokenXFlag: number;
  tokenYFlag: number;
  tokenXDecimals: number;
  tokenYDecimals: number;
};

export type BinView = {
  binId: number;
  amountX: bigint;
  amountY: bigint;
  priceQ64: bigint;
  price: number;
  liquiditySupply: bigint;
  /** Cumulative fee per liquidity share, Q64.64. */
  feeXPerShare: bigint;
  feeYPerShare: bigint;
  stepBpX100: number;
  /** False until the bin has been touched: the program derives price lazily. */
  derived: boolean;
};

export type PositionView = {
  pool: PublicKey;
  owner: PublicKey;
  lowerBinId: number;
  upperBinId: number;
  lastUpdatedAt: bigint;
  totalClaimedFeeX: bigint;
  totalClaimedFeeY: bigint;
  shares: bigint[];
  pendingFeeX: bigint[];
  pendingFeeY: bigint[];
  /** Fee growth this position has already been credited for, per bin. */
  checkpointX: bigint[];
  checkpointY: bigint[];
};
