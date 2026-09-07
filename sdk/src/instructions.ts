/** One builder per program instruction, plus the account lists they share. */
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { DISCRIMINATORS as DISC } from "./constants";
import { ix, Writer } from "./codec";
import { binArrayPda, configPda, poolPda, positionPda, reservePda } from "./pda";
import type { BinDist, BinReduction, ConfigParams, TokenPair, UpdateConfigParams } from "./types";

function mintKeys(t: TokenPair) {
  return [
    { pubkey: t.mintX, isSigner: false, isWritable: false },
    { pubkey: t.mintY, isSigner: false, isWritable: false }
  ];
}

function programKeys(t: TokenPair) {
  return [
    { pubkey: t.programX, isSigner: false, isWritable: false },
    { pubkey: t.programY, isSigner: false, isWritable: false }
  ];
}

export function initializeConfigIx(authority: PublicKey, params: ConfigParams) {
  const data = new Writer()
    .u16(params.index)
    .u128(params.baseWidthQ64)
    .u128(params.taperQ64)
    .i32(params.minBinId)
    .i32(params.maxBinId)
    .u16(params.baseFactor)
    .u8(params.baseFeePowerFactor)
    .u16(params.protocolShare)
    .u8(params.collectFeeMode)
    .u16(params.filterPeriod)
    .u16(params.decayPeriod)
    .u16(params.reductionFactor)
    .u32(params.variableFeeControl)
    .u32(params.maxVolatilityAccumulator)
    .bytes();

  return ix(
    DISC.initializeConfig,
    [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: configPda(authority, params.index), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data
  );
}

/**
 * Edits a config in place. Every field is optional; an omitted one is left as
 * it stands rather than rewritten from a possibly stale read.
 *
 * `config` is passed rather than derived, because a config is addressed by
 * `[authority, index]` and the caller already holds the address it listed.
 */
export function updateConfigIx(authority: PublicKey, config: PublicKey, params: UpdateConfigParams) {
  const data = new Writer()
    .option(params.minBinId, (w, v) => w.i32(v))
    .option(params.maxBinId, (w, v) => w.i32(v))
    .option(params.baseFactor, (w, v) => w.u16(v))
    .option(params.baseFeePowerFactor, (w, v) => w.u8(v))
    .option(params.protocolShare, (w, v) => w.u16(v))
    .option(params.collectFeeMode, (w, v) => w.u8(v))
    .option(params.filterPeriod, (w, v) => w.u16(v))
    .option(params.decayPeriod, (w, v) => w.u16(v))
    .option(params.reductionFactor, (w, v) => w.u16(v))
    .option(params.variableFeeControl, (w, v) => w.u32(v))
    .option(params.maxVolatilityAccumulator, (w, v) => w.u32(v))
    .bytes();

  return ix(
    DISC.updateConfig,
    [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: true }
    ],
    data
  );
}

export function initializePoolIx(creator: PublicKey, config: PublicKey, tokens: TokenPair, activeId: number) {
  const pool = poolPda(config, tokens.mintX, tokens.mintY);
  return ix(
    DISC.initializePool,
    [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      ...mintKeys(tokens),
      { pubkey: reservePda(pool, tokens.mintX), isSigner: false, isWritable: true },
      { pubkey: reservePda(pool, tokens.mintY), isSigner: false, isWritable: true },
      ...programKeys(tokens),
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
    ],
    new Writer().i32(activeId).bytes()
  );
}

export function initializeBinArrayIx(funder: PublicKey, pool: PublicKey, config: PublicKey, index: number) {
  return ix(
    DISC.initializeBinArray,
    [
      { pubkey: funder, isSigner: true, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: binArrayPda(pool, index), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    new Writer().i64(index).bytes()
  );
}

export function initializePositionIx(
  owner: PublicKey,
  pool: PublicKey,
  config: PublicKey,
  lowerBinId: number,
  width: number
) {
  return ix(
    DISC.initializePosition,
    [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: positionPda(pool, owner, lowerBinId, width), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    new Writer().i32(lowerBinId).u16(width).bytes()
  );
}

/** The account list every `ModifyLiquidity` instruction shares. */
export type LiquidityAccounts = {
  owner: PublicKey;
  position: PublicKey;
  pool: PublicKey;
  config: PublicKey;
  tokens: TokenPair;
  userTokenX: PublicKey;
  userTokenY: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  binArrays: PublicKey[];
};

function modifyLiquidityKeys(a: LiquidityAccounts): TransactionInstruction["keys"] {
  return [
    { pubkey: a.owner, isSigner: true, isWritable: false },
    { pubkey: a.position, isSigner: false, isWritable: true },
    { pubkey: a.pool, isSigner: false, isWritable: true },
    { pubkey: a.config, isSigner: false, isWritable: false },
    ...mintKeys(a.tokens),
    { pubkey: a.userTokenX, isSigner: false, isWritable: true },
    { pubkey: a.userTokenY, isSigner: false, isWritable: true },
    { pubkey: a.reserveX, isSigner: false, isWritable: true },
    { pubkey: a.reserveY, isSigner: false, isWritable: true },
    ...programKeys(a.tokens),
    // remaining accounts: the bin arrays covering the touched bins
    ...a.binArrays.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))
  ];
}

export function addLiquidityIx(a: LiquidityAccounts, amountX: bigint, amountY: bigint, dist: BinDist[]) {
  const data = new Writer().u64(amountX).u64(amountY).u32(dist.length);
  // The program requires strictly ascending bin ids.
  for (const d of [...dist].sort((l, r) => l.binId - r.binId)) {
    data.i32(d.binId).u16(d.distributionX).u16(d.distributionY);
  }
  return ix(DISC.addLiquidity, modifyLiquidityKeys(a), data.bytes());
}

export function removeLiquidityIx(a: LiquidityAccounts, reductions: BinReduction[]) {
  const data = new Writer().u32(reductions.length);
  for (const r of reductions) data.i32(r.binId).u16(r.bps);
  return ix(DISC.removeLiquidity, modifyLiquidityKeys(a), data.bytes());
}

export function claimFeeIx(a: LiquidityAccounts) {
  return ix(DISC.claimFee, modifyLiquidityKeys(a), new Uint8Array());
}

export function closePositionIx(owner: PublicKey, position: PublicKey) {
  return ix(
    DISC.closePosition,
    [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true }
    ],
    new Uint8Array()
  );
}

type SwapArgs = [
  user: PublicKey,
  pool: PublicKey,
  config: PublicKey,
  tokens: TokenPair,
  userTokenIn: PublicKey,
  userTokenOut: PublicKey,
  reserveX: PublicKey,
  reserveY: PublicKey,
  binArrays: PublicKey[],
  amountIn: bigint,
  minAmountOut: bigint,
  swapForY: boolean
];

/**
 * Swaps along the ladder, filling as far as the liquidity and the supplied bin
 * arrays allow and taking only the input it used.
 */
export const swapIx = (...args: SwapArgs) => buildSwap(DISC.swap, args);

/**
 * The same swap, all or nothing: a walk that cannot consume the whole input
 * reverts with `IncompleteFill` rather than filling what it can.
 *
 * For a trader with their own wallet a partial fill is strictly better, which
 * is why this is the exception. It is for callers that have nowhere to put the
 * remainder — a router executing through a shared program account would leave
 * it stranded in an ATA it does not own.
 *
 * `quoteSwap` with `strict` set reports whether this would revert, and its
 * `amountIn` is the largest input that would not.
 */
export const swapStrictIx = (...args: SwapArgs) => buildSwap(DISC.swapStrict, args);

/**
 * Byte for byte identical but for the discriminator — which is exactly what
 * the two instructions are on chain.
 */
function buildSwap(
  disc: readonly number[],
  [
    user,
    pool,
    config,
    tokens,
    userTokenIn,
    userTokenOut,
    reserveX,
    reserveY,
    binArrays,
    amountIn,
    minAmountOut,
    swapForY
  ]: SwapArgs
) {
  return ix(
    disc,
    [
      { pubkey: user, isSigner: true, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      // Named by side, not by direction: the program picks in/out itself.
      ...mintKeys(tokens),
      { pubkey: userTokenIn, isSigner: false, isWritable: true },
      { pubkey: userTokenOut, isSigner: false, isWritable: true },
      { pubkey: reserveX, isSigner: false, isWritable: true },
      { pubkey: reserveY, isSigner: false, isWritable: true },
      ...programKeys(tokens),
      ...binArrays.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))
    ],
    new Writer().u64(amountIn).u64(minAmountOut).u8(swapForY ? 1 : 0).bytes()
  );
}

export function setPoolStatusIx(authority: PublicKey, config: PublicKey, pool: PublicKey, status: number) {
  return ix(
    DISC.setPoolStatus,
    [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true }
    ],
    Uint8Array.from([status])
  );
}

export function withdrawProtocolFeeIx(
  authority: PublicKey,
  config: PublicKey,
  pool: PublicKey,
  tokens: TokenPair,
  reserveX: PublicKey,
  reserveY: PublicKey,
  destinationX: PublicKey,
  destinationY: PublicKey
) {
  return ix(
    DISC.withdrawProtocolFee,
    [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      ...mintKeys(tokens),
      { pubkey: reserveX, isSigner: false, isWritable: true },
      { pubkey: reserveY, isSigner: false, isWritable: true },
      { pubkey: destinationX, isSigner: false, isWritable: true },
      { pubkey: destinationY, isSigner: false, isWritable: true },
      ...programKeys(tokens)
    ],
    new Uint8Array()
  );
}
