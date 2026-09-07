/**
 * Liquidity shapes.
 *
 * `add_liquidity` takes an explicit `(bin_id, bps_x, bps_y)` list rather than
 * DLMM's affine strategy parameters, so any shape at all is expressible. These
 * are just three convenient ones; the table in the UI stays editable.
 *
 * Two rules come from the program and are not negotiable: a bin below the
 * active bin may only take Y, and a bin above it may only take X. The active
 * bin itself takes both — and a deposit that shifts its X/Y mix pays a
 * composition fee, which is why the preview calls it out.
 *
 * Curve and bid-ask are both *blendable* towards spot: see `spotBlendBps` on
 * [`distribute`]. The three shapes are corners of one space rather than three
 * separate presets, which is what lets a UI offer "70% bid-ask" instead of
 * making the user hand-edit 70 rows to soften an edge-heavy deposit.
 */
import type { BinDist, BinWeight } from "./types";

export type Shape = "spot" | "curve" | "bidask";

export const SHAPES: { id: Shape; label: string; hint: string }[] = [
  { id: "spot", label: "Spot", hint: "Flat across the range — DLMM's uniform deposit." },
  { id: "curve", label: "Curve", hint: "Gaussian around the active bin; deepest where it trades." },
  { id: "bidask", label: "Bid-ask", hint: "Weighted to the edges; thin in the middle." }
];

/** `spotBlendBps` denominator: 10_000 is a deposit that is exactly spot. */
export const SPOT_BLEND_MAX = 10_000;

/**
 * The raw shape weight for a bin `distance` bins from the active one, where
 * `reach` is the furthest bin on that side.
 *
 * Bid-ask is deliberately zero at the active bin. It used to carry a 0.15
 * floor, which was a spot blend by another name and hidden at a fixed
 * strength; `spotBlendBps` now does that job where a caller can see it.
 */
function weight(shape: Shape, distance: number, reach: number) {
  switch (shape) {
    case "spot":
      return 1;
    case "curve": {
      // sigma chosen so the far edge sits at ~2.5 sigma and still carries mass
      const sigma = Math.max(reach, 1) / 2.5;
      return Math.exp(-((distance / sigma) ** 2));
    }
    case "bidask":
      return reach === 0 ? 1 : distance / reach;
  }
}

/**
 * Mixes a side's weights towards a flat spread.
 *
 * The mix is taken on **normalised** weights, never raw ones. A curve peaks at
 * 1.0, a bid-ask edge peaks at 1.0 and a spot weight is 1.0, but the three sum
 * to wildly different totals over the same bins, so lerping the raw numbers
 * would make the parameter mean something different per shape and per range
 * width. Normalising first makes it mean exactly what it says: at 0 the shape
 * is untouched, at `SPOT_BLEND_MAX` the result is uniform whatever the shape,
 * and in between the fraction of the deposit sitting flat is the parameter.
 *
 * The result sums to 1, so `toBps` below is unaffected.
 */
function blendToSpot(weights: number[], spotBlendBps: number) {
  if (!weights.length) return weights;
  const blend = Math.min(SPOT_BLEND_MAX, Math.max(0, spotBlendBps)) / SPOT_BLEND_MAX;
  const uniform = 1 / weights.length;
  const total = weights.reduce((a, w) => a + w, 0);
  if (total <= 0) return weights.map(() => uniform);
  return weights.map((w) => (1 - blend) * (w / total) + blend * uniform);
}

/**
 * Spreads 10_000 bps over `ids` by weight.
 *
 * The program caps each side's sum at 10_000 but does not require it, so bps
 * lost to flooring are simply deposit left in the wallet — the total has to
 * come out exact. It is made exact by the largest-remainder method: floor
 * every bin, then hand the leftover bps out one at a time to the bins with the
 * largest fractional parts.
 *
 * Handing the whole remainder to the single heaviest bin is the obvious
 * alternative and it is wrong once a band is split across several positions.
 * Each chunk renormalises to its own 10_000, so each would dump up to 70 bps
 * on its heaviest bin — which is the bin nearest the active price — and the
 * deposit would grow a spike at the inner edge of every chunk.
 *
 * Bins of zero weight are excluded from the hand-out. A stray bp on the wrong
 * side of the active bin is not cosmetic: the program rejects X below the
 * active bin and Y above it outright.
 */
function toBps(ids: number[], weights: number[]) {
  const out = new Map<number, number>();
  const total = weights.reduce((a, b) => a + b, 0);
  if (!ids.length || total <= 0) return out;

  const exact = weights.map((w) => (w / total) * 10_000);
  const bps = exact.map((v) => Math.floor(v));
  let remainder = 10_000 - bps.reduce((a, b) => a + b, 0);

  // Each floor loses under one bp, so the leftover is always smaller than the
  // number of bins carrying weight and one pass is enough.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .filter(({ i }) => weights[i] > 0)
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0 && k < order.length; k += 1, remainder -= 1) {
    bps[order[k].i] += 1;
  }

  ids.forEach((id, i) => out.set(id, bps[i]));
  return out;
}

/**
 * The normalised shape weights over `[lower, upper]`, per side.
 *
 * Each side sums to 1 across the whole band (or to 0 if that side has no bins
 * at all). This is the form a band wider than one position needs: a plan that
 * cuts a 200-bin band into three positions has to know what fraction of the
 * deposit each chunk carries *before* renormalising each chunk's own bps to
 * 10_000, and that fraction is only meaningful against weights taken over the
 * whole band. Slicing the bps table instead would silently reshape the deposit,
 * because every chunk would spend a full 10_000 whatever its share of the band.
 */
export function weightsFor(
  lower: number,
  upper: number,
  activeId: number,
  shape: Shape,
  spotBlendBps = 0
): BinWeight[] {
  const ids = Array.from({ length: upper - lower + 1 }, (_, i) => lower + i);
  const xIds = ids.filter((id) => id >= activeId);
  const yIds = ids.filter((id) => id <= activeId);

  const xReach = xIds.length ? Math.max(...xIds.map((id) => id - activeId)) : 0;
  const yReach = yIds.length ? Math.max(...yIds.map((id) => activeId - id)) : 0;

  const xw = blendToSpot(xIds.map((id) => weight(shape, id - activeId, xReach)), spotBlendBps);
  const yw = blendToSpot(yIds.map((id) => weight(shape, activeId - id, yReach)), spotBlendBps);
  const x = new Map(xIds.map((id, i) => [id, xw[i]]));
  const y = new Map(yIds.map((id, i) => [id, yw[i]]));

  return ids.map((binId) => ({
    binId,
    weightX: x.get(binId) ?? 0,
    weightY: y.get(binId) ?? 0
  }));
}

/**
 * Turns a stretch of weights into the bps table `add_liquidity` wants,
 * renormalising each side to 10_000 over exactly the bins given.
 *
 * Bins are dropped when they would receive nothing on either side — the
 * program mints no shares for them, and a bin that rounds to a nonzero amount
 * but zero shares fails the whole instruction with `ZeroLiquidity`, so sending
 * an empty bin buys nothing either way.
 */
export function distributeFromWeights(weights: BinWeight[]): BinDist[] {
  const ids = weights.map((w) => w.binId);
  const xBps = toBps(ids, weights.map((w) => w.weightX));
  const yBps = toBps(ids, weights.map((w) => w.weightY));

  return ids
    .map((binId) => ({
      binId,
      distributionX: xBps.get(binId) ?? 0,
      distributionY: yBps.get(binId) ?? 0
    }))
    .filter((d) => d.distributionX > 0 || d.distributionY > 0);
}

/**
 * Builds the per-bin split for a deposit over `[lower, upper]` at `activeId`.
 *
 * `spotBlendBps` mixes the shape towards a flat spread: 0 leaves it alone,
 * `SPOT_BLEND_MAX` makes it exactly spot, and the value in between is the
 * fraction of each side's deposit laid out flat. It is applied per side, so a
 * range that straddles the active bin softens its X and Y legs by the same
 * proportion even though the two legs have different bin counts.
 */
export function distribute(
  lower: number,
  upper: number,
  activeId: number,
  shape: Shape,
  spotBlendBps = 0
): BinDist[] {
  return distributeFromWeights(weightsFor(lower, upper, activeId, shape, spotBlendBps));
}

/** What each bin actually receives, for the preview. `mul_bps` floors. */
export function preview(dist: BinDist[], amountX: bigint, amountY: bigint) {
  return dist.map((d) => ({
    ...d,
    amountX: (amountX * BigInt(d.distributionX)) / 10_000n,
    amountY: (amountY * BigInt(d.distributionY)) / 10_000n
  }));
}
