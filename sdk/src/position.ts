/**
 * What a position is actually worth, and what it is owed.
 *
 * Both answers need the bins as well as the position: shares are a claim on a
 * bin's reserves, not an amount, and fee growth lives on the bin. Mirrors the
 * program's own arithmetic — `remove_liquidity` for the amounts,
 * `accrued_fee` for the fees.
 */
import { accruedFee } from "./accounts";
import type { BinView, PositionView } from "./types";

export type BinHolding = {
  binId: number;
  share: bigint;
  /** The bin's total supply of shares, for context on how large the claim is. */
  supply: bigint;
  amountX: bigint;
  amountY: bigint;
  feeX: bigint;
  feeY: bigint;
};

export type PositionSummary = {
  bins: BinHolding[];
  amountX: bigint;
  amountY: bigint;
  /** Checkpointed pending plus growth not yet credited. */
  feeX: bigint;
  feeY: bigint;
  /** Bins in the position's range that still hold shares. */
  activeBins: number;
};

/**
 * A position's claim on each bin it spans.
 *
 * The share of a bin's reserves floors, exactly as `remove_liquidity` does, so
 * this never over-reports what a withdrawal would return.
 *
 * The fee figure is the one worth being careful about: the program only moves
 * growth into `fee_*_pending` when it *touches* the position — on a deposit, a
 * withdrawal or a claim — so reading the stored pending alone reports zero for
 * a position that has been earning all along. The uncredited growth is added
 * back here.
 */
export function summarise(position: PositionView, bins: Map<number, BinView>): PositionSummary {
  const out: BinHolding[] = [];
  let amountX = 0n;
  let amountY = 0n;
  let feeX = 0n;
  let feeY = 0n;

  for (let i = 0; i < position.shares.length; i += 1) {
    const binId = position.lowerBinId + i;
    const share = position.shares[i];
    const bin = bins.get(binId);
    if (!bin) continue;

    const supply = bin.liquiditySupply;
    const ownedX = supply > 0n ? (bin.amountX * share) / supply : 0n;
    const ownedY = supply > 0n ? (bin.amountY * share) / supply : 0n;

    const earnedX =
      position.pendingFeeX[i] + accruedFee(share, bin.feeXPerShare, position.checkpointX[i]);
    const earnedY =
      position.pendingFeeY[i] + accruedFee(share, bin.feeYPerShare, position.checkpointY[i]);

    out.push({ binId, share, supply, amountX: ownedX, amountY: ownedY, feeX: earnedX, feeY: earnedY });
    amountX += ownedX;
    amountY += ownedY;
    feeX += earnedX;
    feeY += earnedY;
  }

  return {
    bins: out,
    amountX,
    amountY,
    feeX,
    feeY,
    activeBins: out.filter((b) => b.share > 0n).length
  };
}

/**
 * The state `close_position` requires, mirroring `Position::is_empty`.
 *
 * Liquidity is only half of it: a position that still has a fee checkpointed
 * as pending cannot be closed either, because closing it would strand that fee
 * in the reserve with nobody able to claim it. A client that closes has to
 * claim in the same transaction, so it must not read "no shares" as "closable".
 */
export const isEmpty = (position: PositionView) =>
  position.shares.every((s) => s === 0n) &&
  position.pendingFeeX.every((f) => f === 0n) &&
  position.pendingFeeY.every((f) => f === 0n);

/** Whether any bin still holds shares, i.e. whether there is anything to withdraw. */
export const hasLiquidity = (position: PositionView) => position.shares.some((s) => s > 0n);

/**
 * Bin-by-bin reductions in bps, for `remove_liquidity`.
 *
 * Only bins that hold shares are named: the program rejects a reduction that
 * would burn nothing, so sending an empty bin fails the whole instruction.
 */
export const reductionsFor = (position: PositionView, bps: number) =>
  position.shares
    .map((share, i) => ({ binId: position.lowerBinId + i, bps, share }))
    .filter((r) => r.share > 0n)
    .map(({ binId, bps: b }) => ({ binId, bps: b }));
