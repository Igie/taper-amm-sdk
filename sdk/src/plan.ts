/**
 * Multi-transaction plans.
 *
 * A band of any interesting width is several transactions, for two independent
 * reasons and they bind at different places. **The packet** caps how many bins
 * one `add_liquidity` can carry: a transaction is 1,232 bytes and the account
 * list eats 513 of them, so a distribution runs out of room around 70 entries.
 * **The account** caps how many bins one position can *hold* at creation: 70
 * inline, and the rest arrive through `resize_position`, one call per
 * transaction because the runtime limits an account's growth to 10,240 bytes
 * per transaction.
 *
 * So a 300-bin position is: open it, grow it twice, then deposit into it four
 * times. Everything here exists to make that fan-out survivable — a sequence
 * that dies on transaction three must not leave the user guessing which of
 * their money moved.
 *
 * Three decisions carry that weight.
 *
 * **A plan is built once and never re-split.** The per-position allocation is
 * fixed at plan time, so retrying picks up the remaining steps against the
 * same split. Re-planning mid-sequence would re-divide the full requested
 * amount across whatever positions were left and deposit more than was asked.
 *
 * **A step is one transaction, and its creation is atomic with its deposit.**
 * `initialize_position` and `add_liquidity` ride together, so "did this step
 * run?" has an exact on-chain answer: does the position exist. That is what
 * `creates` is for, and `destroys` is the same question for a close. A runner
 * can therefore resolve an ambiguous timeout by looking, rather than by
 * re-sending a deposit that may already have landed.
 *
 * **A fill has no witness, which is the limit on resuming.** `creates` and
 * `grows` make the opening and growth steps skippable from chain state alone,
 * but nothing distinguishes a bin that this chunk funded from one that was
 * already funded. So a plan is resumable within the run that started it — the
 * runner remembers which steps completed — and re-running a *finished* plan
 * from cold would deposit its later chunks a second time. Keep a plan in
 * memory; never persist one and replay it.
 *
 * **A resize is a target, not a delta.** `resize_position` says "span these
 * bins", so re-sending it is a no-op and the account's own length and header
 * are the witness that it landed. That is why growth steps are marked
 * `idempotent` and a runner may simply retry them, where an ambiguous deposit
 * has to stop and ask.
 *
 * **Bin-array creation is folded into the step that needs it, at send time.**
 * `Step.build` takes the arrays that currently exist and emits
 * `initialize_bin_array` only for the ones that do not, so a single-position
 * deposit stays exactly one transaction and a concurrent creation by someone
 * else does not wedge the retry.
 *
 * Nothing here touches the network: every input is passed in, so the whole
 * module is a pure function of chain state a caller has already read.
 */
import { Keypair, PublicKey, type Signer, type TransactionInstruction } from "@solana/web3.js";
import { INLINE_BINS_PER_POSITION, MAX_BINS_PER_POSITION, positionLenFor } from "./constants";
import {
  addLiquidityIx,
  bandWidth,
  claimFeeIx,
  closePositionIx,
  initializeBinArrayIx,
  initializePositionIx,
  rebalanceLiquidityIx,
  removeLiquidityIx,
  resizePositionIx,
  resizeSteps,
  type Band,
  type LiquidityAccounts
} from "./instructions";
import { arrayIndexesFor, binArrayIndex, binArrayPda, binArrayUpper } from "./pda";
import { reductionsFor, reductionsForRange } from "./position";
import { distributeFromWeights, preview, weightsFor, type Shape } from "./shapes";
import type { BinDist, BinRebalance, PositionView, TokenPair } from "./types";

/** The most a single transaction may ask for. */
export const MAX_TX_COMPUTE = 1_400_000;

/** Solana's packet limit. A transaction over this is rejected before it is run. */
export const MAX_TX_BYTES = 1232;

/**
 * Bytes a wire transaction carrying `instructions` will occupy.
 *
 * Compute is not the only ceiling and, for this program, not the first one
 * reached: `add_liquidity` carries a bps table plus sixteen accounts, and a
 * wide enough deposit overflows the packet while still sitting well inside the
 * compute budget. That failure arrives as a client-side exception rather than a
 * program error, which is exactly the kind that gets discovered in production,
 * so the planner measures instead of hoping.
 *
 * The arithmetic is the wire format: a compact-u16 count and 64 bytes per
 * signature, then the message — three header bytes, the account table, the
 * blockhash, and each instruction as a program index, its account indexes and
 * its data.
 */
export function transactionSize(
  instructions: TransactionInstruction[],
  feePayer?: PublicKey,
  signers = 1
): number {
  const accounts = new Set<string>();
  for (const ix of instructions) {
    accounts.add(ix.programId.toBase58());
    for (const key of ix.keys) accounts.add(key.pubkey.toBase58());
  }
  // The fee payer joins the account table only if no instruction already named
  // it. For this program it always does — every instruction takes the owner.
  if (feePayer) accounts.add(feePayer.toBase58());
  const compact = (n: number) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);

  let size = compact(signers) + signers * 64; // signatures
  size += 3; // header: signers, readonly signed, readonly unsigned
  size += compact(accounts.size) + accounts.size * 32;
  size += 32; // recent blockhash
  size += compact(instructions.length);
  for (const ix of instructions) {
    size += 1 + compact(ix.keys.length) + ix.keys.length;
    size += compact(ix.data.length) + ix.data.length;
  }
  return size;
}

/**
 * Room a caller needs left over, for what the planner does not build.
 *
 * Every transaction the app sends carries a compute-unit limit and a price, and
 * a SOL pair adds an idempotent ATA create, a transfer, a `sync_native` and a
 * close. Reserving for them here is what keeps a plan that fits in theory from
 * failing in the panel that actually sends it.
 */
export const TX_HEADROOM = 64;

/**
 * Headroom for a pair with SOL on one side.
 *
 * Wrapping costs an idempotent ATA create, a lamport transfer, a `sync_native`
 * and a close — measured at 135 bytes on top of the compute-budget pair's 52.
 * It is the caller's to declare because only the caller knows the pair.
 */
export const TX_HEADROOM_NATIVE = 200;

/**
 * Compute headroom for the instructions a caller wraps around a step.
 *
 * The mirror of `TX_HEADROOM_NATIVE`, for the other budget. `Step.computeUnits`
 * covers the step's *own* instructions, because that is all the planner knows
 * about — but a runner sends them in one transaction with whatever it added,
 * and a compute limit applies to the whole of it. Adding token wrapping to a
 * step without adding this spends the step's budget on the wrapping: an
 * idempotent ATA create alone is 22.4k, which is most of a growth step's
 * estimate and leaves the instruction that matters to die at the meter.
 *
 * Sized from that create plus a transfer, a `sync_native` and a close, rounded
 * up. Add it whenever a step is decorated, and only then — over-asking costs a
 * little priority fee where under-asking costs the transaction.
 */
export const CU_HEADROOM_NATIVE = 35_000;

/**
 * Compute estimates, from the measurements in `tests/tests/compute.rs`.
 *
 * Two of these are not a function of bin count alone, and both cost a whole
 * transaction if they are guessed.
 *
 * **A deposit is priced cold.** Deriving a bin price is the most expensive
 * thing this program does, and a plan cannot know which bins a pool has already
 * cached: 70 bins cost 688k CU cold against 84k warm.
 *
 * **A withdrawal is priced against a shared bin.** Burning the whole of a bin's
 * supply returns its balances outright, but burning part of it divides in 256
 * bits — 70 bins cost 53k when the position is the bin's only holder and 800k
 * when it is not, and a client cannot know which it will be.
 *
 * Over-asking costs a little priority fee; under-asking costs the transaction,
 * so every figure here sits above what was measured.
 */
export const CU = {
  /** Measured 7.6k. */
  initBinArray: 15_000,
  /** Measured 9.3k. */
  initPosition: 15_000,
  /** A realloc and at most one lamport transfer. */
  /**
   * A realloc, at most one lamport transfer, and — when the band's lower edge
   * moves — a shift of every surviving slot.
   *
   * `shifted` is the number of bins that have to move, which is **zero for the
   * common case of growing at the top**: slot `k` means bin
   * `lower_bin_id + k`, so a band that only widens upward renumbers nothing.
   *
   * Measured 16.4k widening 160 bins with no shift, and 43.2k sliding a
   * 230-bin band where every slot moves. Rounded up from both, which puts a
   * full 1,400-bin slide near 305k against the 1.4M ceiling.
   */
  resizePosition: (shifted = 0) => 25_000 + shifted * 200,
  /** Measured 688k cold at 70 bins. */
  addLiquidity: (bins: number) => 60_000 + bins * 11_000,
  /** Measured 800k at 70 bins shared with another position. */
  removeLiquidity: (bins: number) => 60_000 + bins * 12_000,
  /** Measured 41k at 70 warm bins; a range with cold bins in it derives them. */
  claimFee: (bins: number) => 20_000 + bins * 1_500,
  closePosition: 10_000,
  /**
   * A burn pass and a redeposit pass over the same bins, in one instruction.
   *
   * Both passes have a cheap branch and an expensive one, and — unlike a plain
   * deposit or withdrawal, where a planner cannot know which it will get — a
   * rebalance's caller can read both off the bin arrays it already fetched. So
   * this takes counts rather than assuming the worst: `warm` bins have their
   * price cached, `sole` bins are ones the position wholly owns. Whatever is
   * not declared is priced at its worst case.
   *
   * From `a_reshape_fits_its_budget` in tests/tests/compute.rs, at 70 bins:
   * **133k** warm and sole, **882k** when 69 of the bins are shared with
   * another position, and **417k** when 34 of the targets are bins the pool
   * has never priced. Every rate below sits above what those measured.
   *
   * The practical consequence is worth stating: declaring `warm` — which a
   * client can always do — is what fits a full 70-bin reshape in one
   * transaction. Declaring nothing caps it near 61.
   */
  rebalanceLiquidity: (bins: number, warm = 0, sole = 0) => {
    const clamp = (n: number) => Math.min(Math.max(n, 0), bins);
    const shared = bins - clamp(sole);
    const cold = bins - clamp(warm);
    return 50_000 + bins * 1_500 + shared * 11_500 + cold * 9_000;
  }
} as const;

/** The `ModifyLiquidity` accounts that do not vary between positions. */
export type BaseAccounts = {
  owner: PublicKey;
  pool: PublicKey;
  config: PublicKey;
  tokens: TokenPair;
  userTokenX: PublicKey;
  userTokenY: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
};

export type StepKind =
  | "openPosition"
  | "resizePosition"
  | "addLiquidity"
  | "rebalanceLiquidity"
  | "exitPosition";

export type Step = {
  /** Stable across re-plans of the same band, so progress can be matched up. */
  id: string;
  kind: StepKind;
  label: string;
  computeUnits: number;
  /** The bin arrays this step writes to. */
  binArrays: number[];
  /**
   * The account whose existence proves this step ran. Present only when the
   * step creates it in the same transaction as everything else it does.
   */
  creates?: PublicKey;
  /** The mirror image: this step closed the account, so absence proves it ran. */
  destroys?: PublicKey;
  /**
   * The witness for a growth step: this account being at least this long
   * proves it ran.
   *
   * A position's length *is* its capacity, so "did the extension land?" has an
   * exact answer that costs one account read. Together with `idempotent` it
   * makes a growth step both skippable when it already ran and harmless when
   * it is sent anyway.
   *
   * **Only ever set on a step that lengthens the account.** The runner reads
   * it as "already at least this long, so skip", which a step that *shortens*
   * the account would satisfy before it ran — and the step would be skipped
   * for good. A narrowing `resize_position` carries no witness and relies on
   * `idempotent` instead.
   */
  grows?: { account: PublicKey; toLength: number };
  /**
   * Re-sending this step cannot do its work twice.
   *
   * True only for `resize_position`, which takes an absolute band: asking a
   * position to span bins 100…329 when it already does succeeds and changes
   * nothing. A runner whose confirmation timed out may therefore just try
   * again, instead of having to stop and ask the way an ambiguous deposit
   * forces it to.
   */
  idempotent?: boolean;
  /**
   * Keys beyond the owner's that must sign this step.
   *
   * Only an opening step has one: a position is a plain keypair account rather
   * than a PDA, so the account signs itself into existence and the keypair has
   * no use after that. The runner passes these to `sendTransaction`; nothing
   * needs to persist them, because the position is found by
   * `getProgramAccounts` from then on.
   */
  signers?: Signer[];
  /**
   * The band of active-bin values this step's distribution stays legal for.
   * A bin above the active one may only take X and a bin below it only Y, so a
   * deposit planned at one active bin is rejected outright once the pool has
   * traded past it. A runner checks this before sending rather than after.
   */
  validWhileActiveIn?: { min: number | null; max: number | null };
  /** What this transaction spends, so a caller can wrap exactly that much SOL. */
  amountX: bigint;
  amountY: bigint;
  /** Emits the instructions, creating whichever bin arrays are still missing. */
  build: (existingArrays: ReadonlySet<number>) => TransactionInstruction[];
};

export type PositionSpec = {
  lowerBinId: number;
  upperBinId: number;
  width: number;
  arrayIndexes: number[];
};

/**
 * How to cut a band into positions.
 *
 * `packed` takes the widest legal chunk each time, which minimises the number
 * of positions. `aligned` additionally stops at every bin-array boundary, so
 * each position sits inside exactly one array and its transactions carry one
 * fewer account.
 *
 * Since a position may now declare up to `MAX_BINS_PER_POSITION` bins, a band
 * is usually one position — and the rent difference between one wide position
 * and several narrow ones is small, because rent tracks bins either way. What
 * one position buys is a single account to claim from, close, and reason
 * about. What it costs is the `resize_position` sequence to grow it.
 *
 * Alignment saves no *array* rent: which arrays a band touches is fixed by the
 * band, not by how it is cut. It trades one position for smaller
 * transactions, which is why `packed` is the default.
 */
export type SplitStrategy = "packed" | "aligned";

export function splitRange(
  lower: number,
  upper: number,
  strategy: SplitStrategy = "packed",
  maxWidth = MAX_BINS_PER_POSITION
): PositionSpec[] {
  const cap = Math.max(1, Math.min(MAX_BINS_PER_POSITION, Math.floor(maxWidth)));
  const specs: PositionSpec[] = [];
  let start = lower;
  while (start <= upper) {
    let end = Math.min(upper, start + cap - 1);
    if (strategy === "aligned") end = Math.min(end, binArrayUpper(binArrayIndex(start)));
    specs.push({
      lowerBinId: start,
      upperBinId: end,
      width: end - start + 1,
      arrayIndexes: arrayIndexesFor(start, end)
    });
    start = end + 1;
  }
  return specs;
}

/**
 * Splits `total` across `weights` exactly, in integer units.
 *
 * The remainder goes to the heaviest entry with a nonzero weight, never simply
 * the first: a chunk sitting entirely below the active bin has zero weight on
 * the X side and cannot deposit X at all, so handing it the dust would quietly
 * drop that dust from the deposit.
 */
function allocate(total: bigint, weights: number[]): bigint[] {
  const out = weights.map(() => 0n);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0n || sum <= 0) return out;

  // Scale to integers first: token amounts run to u64 and `Number` would stop
  // being exact well before that.
  const scaled = weights.map((w) => BigInt(Math.max(0, Math.round((w / sum) * 1e9))));
  const scaledSum = scaled.reduce((a, b) => a + b, 0n);
  if (scaledSum === 0n) return out;

  let assigned = 0n;
  let heaviest = -1;
  scaled.forEach((w, i) => {
    out[i] = (total * w) / scaledSum;
    assigned += out[i];
    if (w > 0n && (heaviest < 0 || w > scaled[heaviest])) heaviest = i;
  });
  if (heaviest >= 0) out[heaviest] += total - assigned;
  return out;
}

/**
 * The most bins one `add_liquidity` transaction can carry.
 *
 * This bounds a *deposit chunk*, not a position: a position may declare up to
 * `MAX_BINS_PER_POSITION` bins and is filled over as many transactions as it
 * takes. Compute is the constraint everywhere else in this program; here it is
 * not. The distribution table is the largest thing in the packet and the
 * account table is the second, so what a caller wraps around a step decides
 * how many bins it can deposit into at once. It is measured rather than
 * guessed: an over-long transaction fails in the client with an assertion
 * rather than as a program error, which is the kind that reaches production.
 *
 * The probe is deliberately the worst case — both bin arrays still to create,
 * the position still to open — because `Step.build` decides what to include at
 * send time and a plan sized for the warm case would overflow the moment an
 * array turned out to be missing.
 */
/**
 * A stand-in position account for the probe below.
 *
 * Generated once, and never used to sign anything: `widthThatFits` needs only
 * a key that is 32 bytes and collides with nothing else in the table.
 */
const PROBE_POSITION = Keypair.generate().publicKey;

export function widthThatFits(
  accounts: BaseAccounts,
  headroom = TX_HEADROOM,
  opening = true
): number {
  // Probed at the inline width: a chunk can never usefully exceed it, since
  // the packet gives out first, and probing at the 1,400-bin ceiling would
  // build a distribution twenty times larger than any that could be sent.
  const bins = INLINE_BINS_PER_POSITION;
  const probe: BinDist[] = Array.from({ length: bins }, (_, i) => ({
    binId: i,
    distributionX: 1,
    distributionY: 1
  }));
  // Two arrays: the most a chunk this wide can straddle.
  const arrays = [0, 1];
  // Any key measures the same, but it must be *distinct* from the others or
  // the account table dedupes it and the probe undercounts by 32 bytes.
  const position = PROBE_POSITION;
  const size = transactionSize(
    [
      ...arrayIxs(accounts, arrays, new Set()),
      initializePositionIx(accounts.owner, accounts.pool, accounts.config, position, 0, bins),
      addLiquidityIx(liquidityAccounts(accounts, position, arrays), 0n, 0n, probe)
    ],
    accounts.owner,
    // A position is a keypair account, so the transaction that opens one
    // carries a second signature — 64 bytes, which is 16 bins of dense table.
    // Only the opening chunk pays it; every later fill signs with the owner
    // alone, and charging them all for it would cost throughput for nothing.
    opening ? 2 : 1
  );

  const over = size + headroom - MAX_TX_BYTES;
  // Each bin is exactly four bytes of table: two u16 shares, the bin id being
  // implied by the entry's position in the dense list.
  return over <= 0 ? bins : Math.max(1, bins - Math.ceil(over / 4));
}

/** The active-bin band a distribution stays legal within. */
function activeBinBounds(dist: BinDist[]) {
  const xBins = dist.filter((d) => d.distributionX > 0).map((d) => d.binId);
  const yBins = dist.filter((d) => d.distributionY > 0).map((d) => d.binId);
  return {
    min: yBins.length ? Math.max(...yBins) : null,
    max: xBins.length ? Math.min(...xBins) : null
  };
}

/** Whether a step's deposit is still legal with the active bin where it is. */
export function stepIsLegal(step: Step, activeId: number): boolean {
  const bounds = step.validWhileActiveIn;
  if (!bounds) return true;
  if (bounds.min !== null && activeId < bounds.min) return false;
  if (bounds.max !== null && activeId > bounds.max) return false;
  return true;
}

function arrayIxs(
  a: BaseAccounts,
  indexes: number[],
  existing: ReadonlySet<number>
): TransactionInstruction[] {
  return indexes
    .filter((index) => !existing.has(index))
    .map((index) => initializeBinArrayIx(a.owner, a.pool, a.config, index));
}

function liquidityAccounts(
  a: BaseAccounts,
  position: PublicKey,
  arrayIndexes: number[]
): LiquidityAccounts {
  return {
    ...a,
    position,
    binArrays: arrayIndexes.map((index) => binArrayPda(a.pool, index))
  };
}

export type PositionPlan = {
  spec: PositionSpec;
  address: PublicKey;
  /**
   * The key that signs this position into existence, present only when the
   * plan opens it.
   *
   * A position is a plain keypair account, so the plan generates the address
   * rather than deriving it — which means a plan built twice names two
   * different accounts. Callers that compare plans should compare bands.
   */
  keypair?: Keypair;
  /** Whether the owner already holds a position over exactly this band. */
  exists: boolean;
  /** The band the position spans right now, which `resize_position` moves. */
  band: Band;
  /**
   * Bins it has storage for today. `INLINE_BINS_PER_POSITION` for one this
   * plan opens, and for an existing one whose capacity the caller did not
   * supply — an unnecessary `resize_position` is a no-op, so guessing low is
   * safe where guessing high would leave a deposit with nowhere to land.
   */
  capacity: number;
  /** Bytes the account occupies once it covers the whole band. */
  bytes: number;
  amountX: bigint;
  amountY: bigint;
  dist: BinDist[];
};

export type DepositPlan = {
  kind: "deposit";
  activeId: number;
  positions: PositionPlan[];
  /** Arrays the band needs that did not exist when the plan was built. */
  missingArrays: number[];
  steps: Step[];
  /** What the plan actually commits, after per-chunk flooring. */
  allocatedX: bigint;
  allocatedY: bigint;
  /** Positions opened by this plan. */
  newPositions: number;
  /**
   * Bytes of position account this plan pays rent for.
   *
   * Not `newPositions * 4,616` any more: a position is 4,616 bytes plus 64 a
   * bin past the inline 70, so a wide one costs proportionally more. Price
   * rent from this, never from the count.
   */
  newPositionBytes: number;
  /**
   * The chunk width the packet limit allowed, which is below the program's 70
   * whenever the caller's overhead is large enough to matter.
   */
  maxWidth: number;
};

export type DepositInput = {
  accounts: BaseAccounts;
  lower: number;
  upper: number;
  activeId: number;
  amountX: bigint;
  amountY: bigint;
  shape: Shape;
  spotBlendBps?: number;
  /** Bin-array indexes known to exist. */
  existingArrays?: Iterable<number>;
  /**
   * Positions the owner already holds in this pool.
   *
   * Bands rather than addresses, because a position's address derives from
   * nothing: the planner matches an existing position to a spec by the band it
   * currently spans. `capacity` is only an optimisation — omit it and the
   * inline block is assumed, which at worst adds `resize_position` calls that
   * turn out to be no-ops. `parsePosition` reports all three.
   */
  existingPositions?: Iterable<{
    address: PublicKey;
    lowerBinId: number;
    upperBinId: number;
    capacity?: number;
  }>;
  /**
   * Widest position to open. Defaults to the program's ceiling, so a band is
   * normally one position; lower it to trade extension transactions for
   * several narrower positions.
   */
  maxPositionWidth?: number;
  strategy?: SplitStrategy;
  /**
   * Bytes to leave for instructions the caller adds around each step — the
   * compute-budget pair, and the SOL wrapping if the pair has a native side.
   * `TX_HEADROOM` covers the former, `TX_HEADROOM_NATIVE` both.
   */
  headroom?: number;
};

/**
 * A deposit over a band of any width.
 *
 * The shape is taken over the *whole* band and then sliced, so cutting a band
 * into three positions produces the same curve as one 210-bin position would
 * have if the program allowed it. Each chunk's own bps are renormalised to
 * 10_000 afterwards; the chunk's share of the deposit is carried by its share
 * of the amounts, not by its bps.
 *
 * Chunks that would receive nothing are dropped rather than opened — a
 * one-sided deposit leaves every chunk on the far side of the active bin with
 * no work to do, and opening one would cost 0.033 SOL of rent for an account
 * holding nothing.
 */
export function planDeposit(input: DepositInput): DepositPlan {
  const {
    accounts,
    lower,
    upper,
    activeId,
    amountX,
    amountY,
    shape,
    spotBlendBps = 0,
    strategy = "packed",
    maxPositionWidth = MAX_BINS_PER_POSITION,
    headroom = TX_HEADROOM
  } = input;
  const existingArrays = new Set(input.existingArrays ?? []);
  // Keyed by band, because that is all a position's identity consists of now.
  const held = new Map(
    [...(input.existingPositions ?? [])].map((p) => [`${p.lowerBinId}:${p.upperBinId}`, p])
  );

  const weights = weightsFor(lower, upper, activeId, shape, spotBlendBps);
  const byBin = new Map(weights.map((w) => [w.binId, w]));
  const specs = splitRange(lower, upper, strategy, maxPositionWidth);
  // How many bins one deposit transaction may carry. Independent of how wide
  // the positions are: a 300-bin position is filled by several of these. The
  // chunk that opens the position carries an extra signature, so it is sized
  // on its own rather than dragging every other chunk down with it.
  const chunkWidth = widthThatFits(accounts, headroom, false);
  const openWidth = widthThatFits(accounts, headroom, true);

  const slices = specs.map((spec) =>
    Array.from({ length: spec.width }, (_, i) => byBin.get(spec.lowerBinId + i)).filter(
      (w): w is NonNullable<typeof w> => Boolean(w)
    )
  );
  const xAmounts = allocate(
    amountX,
    slices.map((s) => s.reduce((a, w) => a + w.weightX, 0))
  );
  const yAmounts = allocate(
    amountY,
    slices.map((s) => s.reduce((a, w) => a + w.weightY, 0))
  );

  const positions: PositionPlan[] = [];
  specs.forEach((spec, i) => {
    const dist = distributeFromWeights(slices[i]);
    // `mul_bps` floors per bin, so ask what the program would actually place
    // rather than trusting a nonzero bps to mean a nonzero deposit.
    const rows = preview(dist, xAmounts[i], yAmounts[i]);
    if (!rows.some((r) => r.amountX > 0n || r.amountY > 0n)) return;

    const existing = held.get(`${spec.lowerBinId}:${spec.upperBinId}`);
    // A position opens inside the inline block whatever the spec asks for:
    // `initialize_position` will not declare a band the account cannot hold,
    // and the rest of the band arrives through `resize_position`.
    const keypair = existing ? undefined : Keypair.generate();
    positions.push({
      spec,
      address: existing ? existing.address : keypair!.publicKey,
      keypair,
      exists: Boolean(existing),
      band: existing
        ? { lower: existing.lowerBinId, upper: existing.upperBinId }
        : {
            lower: spec.lowerBinId,
            upper: spec.lowerBinId + Math.min(spec.width, INLINE_BINS_PER_POSITION) - 1
          },
      capacity: existing?.capacity ?? INLINE_BINS_PER_POSITION,
      bytes: positionLenFor(spec.width),
      amountX: xAmounts[i],
      amountY: yAmounts[i],
      dist
    });
  });

  const steps: Step[] = [];
  for (const p of positions) {
    // The distribution is cut into transaction-sized pieces. Each piece keeps
    // the position's *whole* amounts and only its own bps, which is what makes
    // the split invisible on chain: `add_liquidity` places
    // `amount * bps / 10_000` per bin, so four calls with a quarter of the
    // table each place exactly what one call with all of it would have.
    const chunks: BinDist[][] = [];
    for (let at = 0; at < p.dist.length; ) {
      const width = chunks.length === 0 && !p.exists ? openWidth : chunkWidth;
      const slice = p.dist.slice(at, at + width);
      at += width;
      // A slice that places nothing is not worth a signature.
      if (slice.some((d) => d.distributionX > 0 || d.distributionY > 0)) chunks.push(slice);
    }
    if (!chunks.length) continue;

    const spend = (dist: BinDist[]) =>
      preview(dist, p.amountX, p.amountY).reduce(
        (a, r) => ({ x: a.x + r.amountX, y: a.y + r.amountY }),
        { x: 0n, y: 0n }
      );

    const key = p.address.toBase58();
    const arraysFor = (dist: BinDist[]) =>
      arrayIndexesFor(dist[0].binId, dist[dist.length - 1].binId);

    chunks.forEach((dist, index) => {
      const opening = !p.exists && index === 0;
      const arrayIndexes = arraysFor(dist);
      const accountsFor = liquidityAccounts(accounts, p.address, arrayIndexes);
      const { x, y } = spend(dist);
      const first = dist[0].binId;
      const last = dist[dist.length - 1].binId;

      steps.push({
        id: `deposit:${key}:${index}`,
        kind: opening ? "openPosition" : "addLiquidity",
        label: opening
          ? `Open bins ${p.spec.lowerBinId}…${p.spec.upperBinId}`
          : `Fill bins ${first}…${last}`,
        computeUnits: Math.min(
          MAX_TX_COMPUTE,
          arrayIndexes.length * CU.initBinArray +
            (opening ? CU.initPosition : 0) +
            CU.addLiquidity(dist.length)
        ),
        binArrays: arrayIndexes,
        // Only an opening step is provably re-runnable: the position it creates
        // is created in the same transaction as the deposit, so its existence
        // and the deposit's having landed are the same fact. Adding to a
        // position that was already there has no such witness, and a runner
        // must not re-send it on a timeout.
        creates: opening ? p.address : undefined,
        // The position account signs itself into existence.
        signers: opening && p.keypair ? [p.keypair] : undefined,
        validWhileActiveIn: activeBinBounds(dist),
        amountX: x,
        amountY: y,
        build: (existing) => [
          ...arrayIxs(accounts, arrayIndexes, existing),
          ...(opening
            ? [
                initializePositionIx(
                  accounts.owner,
                  accounts.pool,
                  accounts.config,
                  p.address,
                  p.band.lower,
                  bandWidth(p.band)
                )
              ]
            : []),
          addLiquidityIx(accountsFor, p.amountX, p.amountY, dist)
        ]
      });
    });

    // Growth goes between the opening step and the rest, because a deposit
    // into a bin the band does not reach yet is refused. One band per
    // transaction; each is absolute, so a retry is a no-op.
    const target: Band = { lower: p.spec.lowerBinId, upper: p.spec.upperBinId };
    const growth: Step[] = resizeSteps(p.band, target).map((band) => ({
      id: `resize:${key}:${band.lower}:${band.upper}`,
      kind: "resizePosition",
      label: `Grow to bins ${band.lower}…${band.upper}`,
      // These only ever widen at the top, so no slot moves.
      computeUnits: CU.resizePosition(0),
      binArrays: [],
      idempotent: true,
      grows: { account: p.address, toLength: positionLenFor(bandWidth(band)) },
      amountX: 0n,
      amountY: 0n,
      build: () => [
        resizePositionIx(accounts.owner, p.address, accounts.pool, accounts.config, band.lower, band.upper)
      ]
    }));

    // Splice them in after the first deposit, which is the one that creates
    // the account they grow.
    if (growth.length) {
      const at = steps.length - chunks.length + 1;
      steps.splice(at, 0, ...growth);
    }
  }

  return {
    kind: "deposit",
    activeId,
    positions,
    missingArrays: arrayIndexesFor(lower, upper).filter((index) => !existingArrays.has(index)),
    steps,
    allocatedX: positions.reduce((a, p) => a + p.amountX, 0n),
    allocatedY: positions.reduce((a, p) => a + p.amountY, 0n),
    newPositions: positions.filter((p) => !p.exists).length,
    newPositionBytes: positions.filter((p) => !p.exists).reduce((a, p) => a + p.bytes, 0),
    maxWidth: specs.length ? Math.max(...specs.map((s) => s.width)) : 0
  };
}

export type ExitPlan = {
  kind: "exit";
  steps: Step[];
  /** Positions this plan closes, refunding their whole rent. */
  closing: number;
};

export type ExitInput = {
  accounts: BaseAccounts;
  positions: { address: PublicKey; view: PositionView }[];
  /** Bps of each bin's shares to burn. */
  bps: number;
  /** Restrict the withdrawal to these bins; omit for the whole position. */
  range?: { lower: number; upper: number };
  /**
   * Close each position once it is emptied. Only legal at a full withdrawal
   * over the whole position — `close_position` demands no shares *and* no
   * pending fee anywhere in the range.
   */
  close?: boolean;
  /**
   * Bytes to leave for instructions the caller adds around each step. Sizes
   * the withdrawal chunks the same way `planDeposit` sizes its deposits.
   */
  headroom?: number;
};

/**
 * A withdrawal across any number of positions.
 *
 * The claim always rides along. A withdrawal checkpoints fees on its way out,
 * so a position emptied without claiming is left holding a pending balance it
 * cannot be closed with — which is the state that strands rent.
 *
 * A wide position is several transactions here too, and for the same two
 * reasons a deposit is: the dense bps table and the bin arrays both grow with
 * the range. Each step withdraws from one chunk of bins and claims over that
 * chunk's arrays — `claim_fee` syncs only the arrays it is given and pays out
 * everything pending, so claiming in pieces is exactly as complete as claiming
 * at once. The close rides on the last step, by which point every bin has been
 * synced by its own chunk and every share burned.
 */
export function planExit(input: ExitInput): ExitPlan {
  const { accounts, positions, bps, range, headroom = TX_HEADROOM } = input;
  const close = Boolean(input.close) && bps === 10_000 && !range;
  // An exit never opens a position, so it never carries the second signature.
  const chunkWidth = widthThatFits(accounts, headroom, false);

  const steps: Step[] = [];
  for (const { address, view } of positions) {
    const reductions = range
      ? reductionsForRange(view, range.lower, range.upper, bps)
      : reductionsFor(view, bps);
    const hasPending =
      view.pendingFeeX.some((f) => f > 0n) || view.pendingFeeY.some((f) => f > 0n);
    if (!reductions.length && !hasPending && !close) continue;

    const key = address.toBase58();

    // Chunks are cut over the *claimable* span rather than only the bins being
    // withdrawn from: a claim has to reach every bin holding a pending fee,
    // and on a full exit that is the whole allocated band.
    const first = reductions.length ? reductions[0].binId : view.lowerBinId;
    const lastBin = view.lowerBinId + Math.min(view.width, view.capacity) - 1;
    const last = reductions.length ? reductions[reductions.length - 1].binId : lastBin;
    const spans: { lower: number; upper: number }[] = [];
    for (let at = first; at <= last; at += chunkWidth) {
      spans.push({ lower: at, upper: Math.min(last, at + chunkWidth - 1) });
    }

    spans.forEach((span, index) => {
      const slice = reductions.filter((r) => r.binId >= span.lower && r.binId <= span.upper);
      const arrayIndexes = arrayIndexesFor(span.lower, span.upper);
      const accountsFor = liquidityAccounts(accounts, address, arrayIndexes);
      const bins = span.upper - span.lower + 1;
      const closing = close && index === spans.length - 1;

      steps.push({
        id: `exit:${key}:${index}`,
        kind: "exitPosition",
        label: closing
          ? `Close bins ${view.lowerBinId}…${view.upperBinId}`
          : `Withdraw ${(bps / 100).toFixed(0)}% from bins ${span.lower}…${span.upper}`,
        computeUnits: Math.min(
          MAX_TX_COMPUTE,
          CU.removeLiquidity(slice.length) + CU.claimFee(bins) + (closing ? CU.closePosition : 0)
        ),
        binArrays: arrayIndexes,
        // A close deletes the account, so its absence proves the step ran — the
        // same witness `creates` gives a deposit, read the other way round.
        destroys: closing ? address : undefined,
        amountX: 0n,
        amountY: 0n,
        build: () => [
          ...(slice.length ? [removeLiquidityIx(accountsFor, slice)] : []),
          claimFeeIx(accountsFor),
          ...(closing ? [closePositionIx(accounts.owner, address)] : [])
        ]
      });
    });
  }

  return { kind: "exit", steps, closing: close ? positions.length : 0 };
}

// ------------------------------------------------------------ rebalancing

export type RebalancePlan = {
  kind: "rebalance";
  steps: Step[];
  /**
   * Bins the move drops. They must be emptied first — `resize_position`
   * refuses to drop a bin still holding shares or an unclaimed fee — which is
   * what the withdraw steps at the front of this plan are for.
   */
  leaving: number[];
  /** Bins the move adds. Empty on arrival, and ready to be deposited into. */
  arriving: number[];
  /**
   * Bins in both bands. **These keep their liquidity and their fee
   * checkpoints**, and never leave the reserve — which is the whole reason to
   * move a band rather than close and reopen it.
   */
  kept: number[];
};

export type RebalanceInput = {
  accounts: BaseAccounts;
  position: { address: PublicKey; view: PositionView };
  /** The band to move to. */
  target: Band;
  /** Bytes to leave for instructions the caller adds around each step. */
  headroom?: number;
};

/**
 * Moves one position's band, emptying whatever the move drops on the way.
 *
 * A rebalance is two things in order: **withdraw and claim over the bins that
 * are leaving**, because the program refuses to drop a bin that still holds
 * shares or an unclaimed fee; then **resize** onto the new band. The bins the
 * two bands share are not touched at all — their liquidity stays in the
 * reserve, still earning, and their fee checkpoints survive. That is the whole
 * difference from closing and reopening, which returns every bin's tokens to
 * the wallet and starts a new account with a new address.
 *
 * The bins the move *adds* arrive empty. Filling them is an ordinary
 * `planDeposit` against the position once it has moved, so it is deliberately
 * not folded in here: how much to put in is a decision the caller makes after
 * seeing what the withdrawal returned.
 *
 * The withdrawal is 100% of each leaving bin, and the claim rides along
 * exactly as it does in `planExit` — a withdrawal checkpoints a fee on its way
 * out, so a bin emptied without claiming still reads as non-empty to
 * `resize_position`.
 */
export function planRebalance(input: RebalanceInput): RebalancePlan {
  const { accounts, position, target, headroom = TX_HEADROOM } = input;
  const { address, view } = position;
  const key = address.toBase58();
  // A rebalance never opens a position, so it never carries a second signature.
  const chunkWidth = widthThatFits(accounts, headroom, false);

  const held = Math.min(view.width, view.capacity);
  const lastHeld = view.lowerBinId + held - 1;
  const inTarget = (bin: number) => bin >= target.lower && bin <= target.upper;

  const leaving: number[] = [];
  const kept: number[] = [];
  for (let bin = view.lowerBinId; bin <= lastHeld; bin += 1) {
    (inTarget(bin) ? kept : leaving).push(bin);
  }
  const arriving: number[] = [];
  for (let bin = target.lower; bin <= target.upper; bin += 1) {
    if (bin < view.lowerBinId || bin > lastHeld) arriving.push(bin);
  }

  const steps: Step[] = [];

  // ---- empty what is leaving ------------------------------------------
  //
  // The two ends are planned as one list rather than two: a move that shifts
  // the band drops bins at one end only, and a narrowing drops both, but
  // either way the chunking below is over bin ids and does not care which.
  const reductions = leaving.length
    ? [
        ...reductionsForRange(view, view.lowerBinId, target.lower - 1, 10_000),
        ...reductionsForRange(view, target.upper + 1, lastHeld, 10_000)
      ]
    : [];
  const pendingIn = (lower: number, upper: number) =>
    view.pendingFeeX.some((f, i) => f > 0n && inRange(view.lowerBinId + i, lower, upper)) ||
    view.pendingFeeY.some((f, i) => f > 0n && inRange(view.lowerBinId + i, lower, upper));

  if (leaving.length && (reductions.length || pendingIn(leaving[0], leaving[leaving.length - 1]))) {
    const first = leaving[0];
    const last = leaving[leaving.length - 1];
    for (let at = first, index = 0; at <= last; at += chunkWidth, index += 1) {
      const span = { lower: at, upper: Math.min(last, at + chunkWidth - 1) };
      const slice = reductions.filter((r) => r.binId >= span.lower && r.binId <= span.upper);
      const arrayIndexes = arrayIndexesFor(span.lower, span.upper);
      const accountsFor = liquidityAccounts(accounts, address, arrayIndexes);
      const bins = span.upper - span.lower + 1;
      steps.push({
        id: `rebalance-exit:${key}:${index}`,
        kind: "exitPosition",
        label: `Empty bins ${span.lower}…${span.upper}`,
        computeUnits: Math.min(
          MAX_TX_COMPUTE,
          CU.removeLiquidity(slice.length) + CU.claimFee(bins)
        ),
        binArrays: arrayIndexes,
        amountX: 0n,
        amountY: 0n,
        build: () => [
          ...(slice.length ? [removeLiquidityIx(accountsFor, slice)] : []),
          claimFeeIx(accountsFor)
        ]
      });
    }
  }

  // ---- move the band ---------------------------------------------------
  let cur: Band = { lower: view.lowerBinId, upper: view.upperBinId };
  let curLen = positionLenFor(view.capacity);
  for (const band of resizeSteps(cur, target)) {
    // Only a move of the *lower* edge renumbers slots, and then it is the bins
    // the two bands share that have to be carried across.
    const shifted =
      band.lower === cur.lower
        ? 0
        : Math.max(0, Math.min(cur.upper, band.upper) - Math.max(cur.lower, band.lower) + 1);
    const nextLen = positionLenFor(bandWidth(band));
    steps.push({
      id: `resize:${key}:${band.lower}:${band.upper}`,
      kind: "resizePosition",
      label: `Move band to ${band.lower}…${band.upper}`,
      computeUnits: CU.resizePosition(shifted),
      binArrays: [],
      idempotent: true,
      // Only when the step actually lengthens the account. `grows` is a
      // "reached at least this length" witness, so putting it on a step that
      // *shrinks* would read as already-satisfied — the account is still the
      // longer one — and the runner would skip the step that has to happen.
      // A narrowing step has no length witness; `idempotent` is what makes it
      // safe to re-send instead.
      grows: nextLen > curLen ? { account: address, toLength: nextLen } : undefined,
      amountX: 0n,
      amountY: 0n,
      build: () => [
        resizePositionIx(
          accounts.owner,
          address,
          accounts.pool,
          accounts.config,
          band.lower,
          band.upper
        )
      ]
    });
    cur = band;
    curLen = nextLen;
  }

  return { kind: "rebalance", steps, leaving, arriving, kept };
}

/**
 * The most bins one `rebalance_liquidity` transaction can carry.
 *
 * Six bytes a bin against a deposit's four — the withdraw side rides along —
 * but only one account list where fusing the three separate instructions would
 * carry three, so it comes out ahead. Measured the same way and for the same
 * reason as `widthThatFits`: a transaction that overflows fails as a
 * client-side assertion, which is the kind that reaches production.
 */
export function reshapeWidthThatFits(accounts: BaseAccounts, headroom = TX_HEADROOM): number {
  const bins = INLINE_BINS_PER_POSITION;
  const probe: BinRebalance[] = Array.from({ length: bins }, (_, i) => ({
    binId: i,
    withdrawBps: 10_000,
    distributionX: 1,
    distributionY: 1
  }));
  const size = transactionSize(
    [rebalanceLiquidityIx(liquidityAccounts(accounts, PROBE_POSITION, [0, 1]), probe)],
    accounts.owner,
    1
  );
  const over = size + headroom - MAX_TX_BYTES;
  return over <= 0 ? bins : Math.max(1, bins - Math.ceil(over / 6));
}

/**
 * What a caller already knows about the bins it is about to reshape, from the
 * bin arrays it had to fetch anyway.
 *
 * Both facts pick between a cheap path and an expensive one, both are readable
 * rather than guessable, and together they are the difference between fitting
 * a full-width reshape in one transaction and not.
 *
 * **`warm`** is a bin whose price is already derived (`BinView.derived`).
 * Deriving one is the most expensive thing the program does. A rebalance
 * mostly redeposits into bins it just withdrew from, so in practice nearly all
 * of them are warm — but a shape that reaches a bin nobody has ever funded
 * will pay for it.
 *
 * **`sole`** is a bin where the position holds the whole supply
 * (`shares === bin.liquiditySupply`). A withdrawal returns the bin's balances
 * outright in that case and divides in 256 bits otherwise, which at 70 bins is
 * the difference between 53k CU and 800k.
 *
 * Omit either and that half is priced at its worst case — correct, but it caps
 * a reshape near 61 bins a transaction instead of the full 70. `warm` is the
 * one that pays: a shared 70-bin reshape was measured at 882k CU, which fits,
 * while the same reshape priced as if every target were cold does not.
 */
export type BinFacts = { warm?: ReadonlySet<number>; sole?: ReadonlySet<number> };

export type ReshapeInput = {
  accounts: BaseAccounts;
  position: { address: PublicKey; view: PositionView };
  /** Where the pool is trading. The shape is built against it. */
  activeId: number;
  shape: Shape;
  spotBlendBps?: number;
  /**
   * The stretch of the band to reshape. Defaults to the whole of it.
   *
   * Bins outside it are left exactly as they are — shares, fee checkpoints and
   * prices all untouched.
   */
  range?: Band;
  /** Extra tokens to fold into the pot from the wallet before it is spent. */
  depositX?: bigint;
  depositY?: bigint;
  /** Sweep pending fees into the pot rather than leaving them claimable. */
  compoundFees?: boolean;
  /**
   * How far the active bin may drift between planning and landing before the
   * program refuses the call. Defaults to 5 bins; `null` allows any.
   */
  activeSlippageBins?: number | null;
  /** What the caller read from the bin arrays. See {@link BinFacts}. */
  facts?: BinFacts;
  headroom?: number;
};

export type ReshapePlan = {
  kind: "reshape";
  steps: Step[];
  /** The bins this plan rewrites. */
  range: Band;
  /**
   * Whether the whole reshape is one transaction — and so whether liquidity
   * may move freely across the range.
   *
   * **This is a semantic difference, not a performance one.** A rebalance's
   * pot is whatever *its own* bins gave up, so a range cut into two steps is
   * two reshapes that cannot exchange liquidity: nothing withdrawn in the
   * first can land in the second's bins, and the shape each step produces is
   * the requested one restricted to its own span rather than a slice of the
   * global answer. A caller that needs a genuinely global reshape of a range
   * too wide to fit must withdraw and redeposit instead — `planRebalance` and
   * `planDeposit` are that path, at the cost of the round trip through the
   * wallet that this instruction exists to avoid.
   */
  atomic: boolean;
};

/**
 * Reshapes liquidity within a band that is already where the owner wants it.
 *
 * The band does not move, so nothing here resizes: this is the other half of
 * rebalancing, and the half that used to take three transactions and a guess
 * at the amount in between. One `rebalance_liquidity` burns the range into a
 * pot and lays it back out at `shape`, without the tokens leaving the reserve.
 *
 * Two things worth knowing are decided here rather than on chain.
 *
 * **A pot with nowhere to go is refunded.** X can only land at or above the
 * active bin and Y only at or below it, so a range sitting entirely on one
 * side of the price gives back the token it cannot place. That is the
 * program's `DepositXBelowActiveBin` guard doing its job rather than a
 * planning failure — a rebalance moves liquidity along the ladder and never
 * converts one token into the other.
 *
 * **`atomic` is the flag to read before trusting the shape.** See
 * {@link ReshapePlan.atomic}.
 */
export function planReshape(input: ReshapeInput): ReshapePlan {
  const {
    accounts,
    position,
    activeId,
    shape,
    spotBlendBps = 0,
    depositX = 0n,
    depositY = 0n,
    compoundFees = false,
    activeSlippageBins = 5,
    facts = {},
    headroom = TX_HEADROOM
  } = input;
  const { address, view } = position;
  const key = address.toBase58();

  const held = Math.min(view.width, view.capacity);
  const band: Band = { lower: view.lowerBinId, upper: view.lowerBinId + held - 1 };
  const range: Band = {
    lower: Math.max(band.lower, input.range?.lower ?? band.lower),
    upper: Math.min(band.upper, input.range?.upper ?? band.upper)
  };

  const activeBounds =
    activeSlippageBins === null
      ? undefined
      : { min: activeId - activeSlippageBins, max: activeId + activeSlippageBins };

  const chunkWidth = Math.max(
    1,
    Math.min(reshapeWidthThatFits(accounts, headroom), reshapeWidthByCompute(range, facts))
  );
  const atomic = range.upper - range.lower + 1 <= chunkWidth;

  const steps: Step[] = [];
  for (let at = range.lower, index = 0; at <= range.upper; at += chunkWidth, index += 1) {
    const span: Band = { lower: at, upper: Math.min(range.upper, at + chunkWidth - 1) };
    const dist = distributeFromWeights(
      weightsFor(span.lower, span.upper, activeId, shape, spotBlendBps)
    );
    const byBin = new Map(dist.map((d) => [d.binId, d]));

    // Dense over the span: a bin the shape gives nothing to still has to give
    // its own liquidity up, or it would sit out the reshape entirely.
    const entries: BinRebalance[] = [];
    for (let bin = span.lower; bin <= span.upper; bin += 1) {
      const d = byBin.get(bin);
      entries.push({
        binId: bin,
        withdrawBps: view.shares[bin - view.lowerBinId] > 0n ? 10_000 : 0,
        distributionX: d?.distributionX ?? 0,
        distributionY: d?.distributionY ?? 0
      });
    }
    // The top-up and the fee sweep ride on the first step that is actually
    // sent, not on span zero — a span with nothing in it is skipped below, and
    // hanging the top-up on it would drop the deposit entirely.
    const first = steps.length === 0;
    const topUpX = first ? depositX : 0n;
    const topUpY = first ? depositY : 0n;

    // Nothing to burn and nothing added to the pot: every bin would be quoted
    // `mul_bps` of zero, so the transaction would place nothing. Not worth a
    // signature. A span that burns but has nowhere to place is *not* skipped —
    // that is a full exit, and the pot comes back to the wallet.
    const burns = entries.some((e) => e.withdrawBps > 0);
    if (!burns && topUpX === 0n && topUpY === 0n) continue;

    const arrayIndexes = arrayIndexesFor(span.lower, span.upper);
    const accountsFor = liquidityAccounts(accounts, address, arrayIndexes);
    const countIn = (set: ReadonlySet<number> | undefined) =>
      set ? entries.filter((e) => set.has(e.binId)).length : 0;

    steps.push({
      id: `reshape:${key}:${index}`,
      kind: "rebalanceLiquidity",
      label: `Reshape bins ${span.lower}…${span.upper}`,
      computeUnits: Math.min(
        MAX_TX_COMPUTE,
        CU.rebalanceLiquidity(entries.length, countIn(facts.warm), countIn(facts.sole))
      ),
      binArrays: arrayIndexes,
      validWhileActiveIn: activeBinBounds(dist),
      amountX: topUpX,
      amountY: topUpY,
      build: () => [
        rebalanceLiquidityIx(accountsFor, entries, {
          depositX: topUpX,
          depositY: topUpY,
          compoundFees: first ? compoundFees : false,
          activeBounds
        })
      ]
    });
  }

  return { kind: "reshape", steps, range, atomic };
}

/**
 * The widest span whose cost still sits inside one transaction.
 *
 * A chunk is only priced at the cheap rate when *every* bin in the range
 * qualifies, because the chunking below cannot know which bins a given chunk
 * will end up holding until the width is already chosen. A range that is
 * partly warm is therefore sized as if none of it were — pessimistic by a
 * chunk or two, and never by a failed transaction.
 */
function reshapeWidthByCompute(range: Band, facts: BinFacts): number {
  const bins = Array.from(
    { length: range.upper - range.lower + 1 },
    (_, i) => range.lower + i
  );
  const all = (set: ReadonlySet<number> | undefined) => Boolean(set) && bins.every((b) => set!.has(b));
  const warm = all(facts.warm);
  const sole = all(facts.sole);
  for (let width = INLINE_BINS_PER_POSITION; width > 1; width -= 1) {
    const cu = CU.rebalanceLiquidity(width, warm ? width : 0, sole ? width : 0);
    if (cu <= MAX_TX_COMPUTE) return width;
  }
  return 1;
}

const inRange = (bin: number, lower: number, upper: number) => bin >= lower && bin <= upper;

