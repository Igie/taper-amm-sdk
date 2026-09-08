/** One builder per program instruction, plus the account lists they share. */
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { DISCRIMINATORS as DISC, MAX_BINS_PER_EXTEND, PROGRAM_ID, positionLenFor } from "./constants";
import { rentFor } from "./native";
import { ix, Writer } from "./codec";
import { binArrayPda, configPda, poolPda, reservePda } from "./pda";
import type {
  BinDist,
  BinRebalance,
  BinReduction,
  ConfigParams,
  TokenPair,
  UpdateConfigParams
} from "./types";

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

/**
 * Allocates the account a position will live in, at the length its band needs.
 *
 * The program does not create this account, and the reason is the runtime: an
 * account created through a **CPI** may not exceed 10,240 bytes, which is 157
 * bins, while a position runs to `MAX_BINS_PER_POSITION`. A top-level
 * `create_account` has no such cap, so the client allocates and
 * `initialize_position` only checks that the band fits what arrived.
 *
 * Rent is computed rather than fetched — `rentFor` is the runtime's own
 * formula — because the SDK has no RPC layer. A short account is not a silent
 * problem: the runtime refuses any transaction that leaves a data-carrying
 * account below the rent-exempt minimum.
 */
export function createPositionAccountIx(payer: PublicKey, position: PublicKey, width: number) {
  const space = positionLenFor(width);
  return SystemProgram.createAccount({
    fromPubkey: payer,
    newAccountPubkey: position,
    lamports: Number(rentFor(space)),
    space,
    programId: PROGRAM_ID
  });
}

/**
 * The two instructions that open a position: allocate the account, then
 * declare the band over it.
 *
 * They belong together — an allocated account that was never initialised is a
 * position nobody can use and rent nobody gets back — so this is what callers
 * should reach for. `initializePositionIx` alone is for a caller that has
 * already created the account some other way.
 */
export function openPositionIxs(
  owner: PublicKey,
  pool: PublicKey,
  config: PublicKey,
  position: PublicKey,
  lowerBinId: number,
  width: number
): TransactionInstruction[] {
  return [
    createPositionAccountIx(owner, position, width),
    initializePositionIx(owner, pool, config, position, lowerBinId, width)
  ];
}

/**
 * Opens a position at `position`, which is a **keypair the caller generates**
 * and must sign this transaction with — a position is not a PDA, so there is
 * nothing to derive and nothing to collide with.
 *
 * The account must already exist, be owned by the program and be long enough
 * for `width` bins: `createPositionAccountIx` is the instruction that puts it
 * there, and `openPositionIxs` is the pair. A band wider than the account can
 * hold is refused as `PositionTooWide`.
 */
export function initializePositionIx(
  owner: PublicKey,
  pool: PublicKey,
  config: PublicKey,
  position: PublicKey,
  lowerBinId: number,
  width: number
) {
  return ix(
    DISC.initializePosition,
    [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: position, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    new Writer().i32(lowerBinId).u16(width).bytes()
  );
}

/**
 * Moves a position's band to `newLower ..= newUpper`, resizing its storage to
 * match — widening, narrowing, or sliding it whole.
 *
 * Sliding both edges the same way is a **rebalance in place**: the position
 * keeps its account, its fee checkpoints and its claim totals rather than
 * being closed and reopened. Bins leaving the band must hold no shares and no
 * unclaimed fee, or the program refuses with `ResizeDropsLiquidity`.
 *
 * **The arguments are a target, not a delta.** Re-sending is a no-op, so a
 * runner that timed out can simply try again — the account's own length and
 * header are the witness that it landed.
 *
 * At most `MAX_BINS_PER_EXTEND` bins may be *added* per call, and that budget
 * is per *transaction* rather than per instruction: the runtime measures
 * growth from the account's length when the transaction began, so two of these
 * in one transaction share it. Send one per transaction. Shrinking is
 * uncapped, and refunds the rent on the bytes it drops.
 */
export function resizePositionIx(
  owner: PublicKey,
  position: PublicKey,
  pool: PublicKey,
  config: PublicKey,
  newLower: number,
  newUpper: number
) {
  return ix(
    DISC.resizePosition,
    [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    new Writer().i32(newLower).i32(newUpper).bytes()
  );
}

export type Band = { lower: number; upper: number };

export const bandWidth = (b: Band) => b.upper - b.lower + 1;

/**
 * The successive bands that carry a position from `from` to `to`, one per
 * transaction.
 *
 * The realloc ceiling is on the account's **length**, so what a step may spend
 * is net width growth, not bins added at an edge: a band that sheds forty bins
 * at the bottom while gaining forty at the top grows by nothing and is always
 * one step. Narrowing is free, so each step sheds everything it is going to
 * shed first and spends its whole budget widening.
 *
 * Every intermediate band contains `from ∩ to` — the bins that survive the
 * move and may still hold liquidity — so no step drops a bin the target meant
 * to keep. Returns `[]` when the position is already there.
 */
export function resizeSteps(from: Band, to: Band, step = MAX_BINS_PER_EXTEND): Band[] {
  const out: Band[] = [];
  let cur = from;
  while (cur.lower !== to.lower || cur.upper !== to.upper) {
    const room = bandWidth(cur) + step;
    if (bandWidth(to) <= room) {
      out.push(to);
      break;
    }
    // Shed first: whatever the two bands share has to survive, and anything
    // else the target does not want is free to drop now.
    let lower = Math.max(cur.lower, to.lower);
    let upper = Math.min(cur.upper, to.upper);
    // A move clear of the old band keeps nothing, so it starts from a point.
    if (lower > upper) [lower, upper] = [to.lower, to.lower];
    let budget = room - (upper - lower + 1);
    const down = Math.min(budget, lower - to.lower);
    lower -= down;
    budget -= down;
    upper += Math.min(budget, to.upper - upper);
    out.push({ lower, upper });
    cur = { lower, upper };
  }
  return out;
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

/**
 * Fills the gaps in a sorted, sparse bin list so it can be sent densely.
 *
 * The instruction carries one entry per consecutive bin from `firstBinId`, so a
 * bin the caller left out becomes an explicit zero rather than a hole. That
 * costs a few bytes for a shape with gaps and saves 280 on a full-width
 * deposit, because the bin id every entry used to carry is now implied by its
 * position in the list — and a zero is skipped by the program before it loads
 * the bin at all.
 */
function densify<T>(entries: { binId: number }[], zero: T, at: (e: never) => T): { firstBinId: number; values: T[] } {
  const sorted = [...entries].sort((l, r) => l.binId - r.binId);
  if (!sorted.length) return { firstBinId: 0, values: [] };
  const firstBinId = sorted[0].binId;
  const span = sorted[sorted.length - 1].binId - firstBinId + 1;
  const values: T[] = Array.from({ length: span }, () => zero);
  for (const e of sorted) values[e.binId - firstBinId] = at(e as never);
  return { firstBinId, values };
}

export function addLiquidityIx(a: LiquidityAccounts, amountX: bigint, amountY: bigint, dist: BinDist[]) {
  const { firstBinId, values } = densify<[number, number]>(dist, [0, 0], (d: BinDist) => [
    d.distributionX,
    d.distributionY
  ]);
  const data = new Writer().u64(amountX).u64(amountY).i32(firstBinId).u32(values.length);
  for (const [x, y] of values) data.u16(x).u16(y);
  return ix(DISC.addLiquidity, modifyLiquidityKeys(a), data.bytes());
}

export function removeLiquidityIx(a: LiquidityAccounts, reductions: BinReduction[]) {
  const { firstBinId, values } = densify<number>(reductions, 0, (r: BinReduction) => r.bps);
  const data = new Writer().i32(firstBinId).u32(values.length);
  for (const bps of values) data.u16(bps);
  return ix(DISC.removeLiquidity, modifyLiquidityKeys(a), data.bytes());
}

/**
 * Burns shares over a stretch of the band and redeposits the proceeds into
 * the same stretch, at a new shape.
 *
 * **The deposit is quoted in bps of the pot, not in tokens.** What comes out
 * of the bins is only knowable once the burn has run on chain, so there is no
 * amount for a client to pass — which is the whole reason this exists rather
 * than a `removeLiquidityIx` and an `addLiquidityIx` side by side. Those two
 * force a client to predict the number in between: predict high and the
 * deposit fails on a balance it does not have, taking the withdrawal down with
 * it; predict low and the difference is stranded in the wallet.
 *
 * `depositX`/`depositY` top the pot up from the wallet before it is spent, and
 * anything the distribution leaves unspent is paid back out — so one call
 * covers a reshape, a reshape that adds, and a reshape that partially exits.
 *
 * `activeBounds` is the only slippage guard available here and is not
 * decoration: the shape is computed against an active bin, and which side of
 * it a bin falls on decides whether that bin may hold X or Y at all. Omit it
 * only when the caller genuinely does not care where the price is.
 */
export function rebalanceLiquidityIx(
  a: LiquidityAccounts,
  entries: BinRebalance[],
  options: {
    depositX?: bigint;
    depositY?: bigint;
    compoundFees?: boolean;
    activeBounds?: { min: number; max: number };
  } = {}
) {
  const { firstBinId, values } = densify<[number, number, number]>(
    entries,
    [0, 0, 0],
    (e: BinRebalance) => [e.withdrawBps, e.distributionX, e.distributionY]
  );
  const bounds = options.activeBounds ?? { min: -0x8000_0000, max: 0x7fff_ffff };
  const data = new Writer()
    .u64(options.depositX ?? 0n)
    .u64(options.depositY ?? 0n)
    .i32(firstBinId)
    .i32(bounds.min)
    .i32(bounds.max)
    .u8(options.compoundFees ? 1 : 0)
    .u32(values.length);
  for (const [withdraw, x, y] of values) data.u16(withdraw).u16(x).u16(y);
  return ix(DISC.rebalanceLiquidity, modifyLiquidityKeys(a), data.bytes());
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
