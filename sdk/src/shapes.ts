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
 * That third case is why these weights are per side but the *shape* is not.
 * The active bin appears on both legs, and giving it a full weight on each
 * would deposit two bins' worth of liquidity into one bin, at a mix decided by
 * nothing but the caller's two amounts. It gets one bin's worth instead, split
 * by what the bin already holds — see `activeXShare` on [`weightsFor`].
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
  { id: "curve", label: "Curve", hint: "Deepest at the active bin, thinning to the edges — bid-ask reflected." },
  { id: "bidask", label: "Bid-ask", hint: "Weighted to the edges; thin in the middle." }
];

/** `spotBlendBps` denominator: 10_000 is a deposit that is exactly spot. */
export const SPOT_BLEND_MAX = 10_000;

/**
 * The raw shape weight at `position` along a side's ramp, where 0 is the bin
 * nearest the price and 1 the furthest.
 *
 * **Curve and bid-ask are one ramp and its reflection.** `curve + bidask` is
 * flat at every bin, so the two are opposite corners of the space spot sits in
 * the middle of. A Gaussian stood at curve and was wrong in the way a smoothed
 * function is wrong: it had no edge where bid-ask has its peak, so the pair no
 * longer summed to a flat spread and "the other one" was not on offer. DLMM's
 * curve is the same linear ramp, for the harder reason that its on-chain
 * strategy parameters are affine per side and cannot express anything else.
 *
 * Both shapes reach zero at one end, and a bin of zero weight drops out of the
 * table entirely: bid-ask puts nothing in the bin nearest the price, curve
 * nothing in the outermost bin of each side. That is the shape rather than an
 * omission — `spotBlendBps` is how a caller fills either back in.
 *
 * **The ramp runs between the range's own ends, not from the active bin.**
 * The two coincide whenever the range reaches the price, which is the ordinary
 * case, and they part company for a range sitting wholly to one side of it —
 * a reshape of the far edge of a band, say. Measuring from the active bin
 * there left bid-ask a ramp whose zero was outside the range: bins 10…20 with
 * the price at bin 0 came out `606 … 1212`, a 2:1 tilt where curve was a full
 * `1818 … 0`, so the further from the price a range sat the closer bid-ask
 * came to plain spot. Curve never showed it because the offset it carried was
 * an affine rescale that normalising divides straight back out — its bps are
 * identical either way — while bid-ask's survived as a pedestal under the
 * whole side.
 */
function weight(shape: Shape, position: number) {
  switch (shape) {
    case "spot":
      return 1;
    case "curve":
      return 1 - position;
    case "bidask":
      return position;
  }
}

/**
 * One side's raw weights, laid along the ramp between its own two ends.
 *
 * `distances` are from the active bin, in bin counts. The nearest is the ramp's
 * origin and the furthest its end, so a side that reaches the price puts its
 * origin exactly there and one that does not puts it at the range's own inner
 * edge.
 *
 * A side with nowhere to ramp — one bin, or every bin at the same distance —
 * is flat, and every shape agrees with spot on it. Without that, bid-ask would
 * put a zero on the only bin the side has and drop it from the table.
 */
function rampWeights(shape: Shape, distances: number[]): number[] {
  if (!distances.length) return [];
  const near = Math.min(...distances);
  const span = Math.max(...distances) - near;
  if (span === 0) return distances.map(() => 1);
  return distances.map((d) => weight(shape, (d - near) / span));
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
 * The fraction of a bin's value that is held as X — what the active bin's
 * weight is split by. In `[0, 1]`.
 *
 * A bin is constant-*sum*, so its value is `P·x + y` and the split is that
 * ratio, taken in Q64.64. Only the active bin can hold both tokens, so it is
 * the only bin this is ever asked about.
 *
 * An empty bin — or one the program has not priced, which comes to the same
 * thing, since an unpriced bin has never held anything — answers **0.5**: half
 * the weight to each token, which is what a bin sitting squarely at the price
 * holds and the only defensible guess when there is no ratio to match. That is
 * also what a caller who passes nothing gets, so a client that has not fetched
 * the bin degrades to the old symmetric behaviour rather than to a wrong one.
 */
export function compositionXShare(bin?: {
  amountX: bigint;
  amountY: bigint;
  priceQ64: bigint;
}): number {
  if (!bin || bin.priceQ64 <= 0n) return 0.5;
  const valueX = bin.priceQ64 * bin.amountX;
  const valueY = bin.amountY << 64n;
  const total = valueX + valueY;
  if (total === 0n) return 0.5;
  // Divided as integers and only then made an f64: `P·x` is a Q64.64 product
  // that outruns a double long before a bin outruns a `u64` of tokens. The
  // answer is a weight, and a bp of one is already finer than the bps table it
  // ends up in.
  return Number((valueX * 10_000n) / total) / 10_000;
}

/**
 * Rescales the active bin's leg of one side, then renormalises that side.
 *
 * `keep` is the share of the active bin's weight this token is entitled to.
 * The scaling happens *after* the spot blend, never before: the blend pulls
 * every bin towards uniform, so a split applied first would be blended away —
 * at a full blend the active bin would be back to a whole weight on each side,
 * which is the double deposit this exists to prevent. Spot is split for the
 * same reason curve is; it is a property of the bin, not of the shape.
 */
function splitActive(ids: number[], weights: number[], activeId: number, keep: number) {
  const at = ids.indexOf(activeId);
  const scaled = at < 0 ? weights : weights.map((w, i) => (i === at ? w * keep : w));
  const total = scaled.reduce((a, b) => a + b, 0);
  if (total > 0) return scaled.map((w) => w / total);

  // The active bin was this side's only weight and it holds none of this token,
  // so the split scaled the side to nothing — and a side of no weight is a side
  // of no bps, which would leave that half of the deposit in the wallet rather
  // than in the pool. The caller has asked to deposit a token whose only home in
  // this band is a bin already full of the other one; it goes there and pays the
  // composition fee. That is the trade they asked for, not a planning failure.
  const raw = weights.reduce((a, b) => a + b, 0);
  return raw > 0 ? weights.map((w) => w / raw) : weights;
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
 *
 * `activeXShare` is the one place the pool's own state reaches the shape, and
 * it touches one bin. The active bin sits on both legs, so a full weight on
 * each puts two bins of liquidity into one bin — at a mix set by the ratio of
 * the caller's two amounts, which is a fact about the wallet rather than about
 * the pool. Splitting a single bin's weight by what the bin already holds fixes
 * both halves of that: the bin takes a neighbour's worth of liquidity, and it
 * takes it in the ratio it is already in, so the deposit is not doing a swap's
 * work and paying a swap's fee for it. `compositionXShare` reads the number off
 * the bin; the default 0.5 is an empty active bin, which is exactly the case
 * where there is no composition fee to avoid.
 */
export function weightsFor(
  lower: number,
  upper: number,
  activeId: number,
  shape: Shape,
  spotBlendBps = 0,
  activeXShare = 0.5
): BinWeight[] {
  const ids = Array.from({ length: upper - lower + 1 }, (_, i) => lower + i);
  const xIds = ids.filter((id) => id >= activeId);
  const yIds = ids.filter((id) => id <= activeId);

  const xRaw = rampWeights(shape, xIds.map((id) => id - activeId));
  const yRaw = rampWeights(shape, yIds.map((id) => activeId - id));

  const share = Math.min(1, Math.max(0, activeXShare));
  const xw = splitActive(xIds, blendToSpot(xRaw, spotBlendBps), activeId, share);
  const yw = splitActive(yIds, blendToSpot(yRaw, spotBlendBps), activeId, 1 - share);
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
 *
 * `activeXShare` is the active bin's X:Y split, from `compositionXShare`. See
 * [`weightsFor`] for why the active bin is not simply on both sides at once.
 */
export function distribute(
  lower: number,
  upper: number,
  activeId: number,
  shape: Shape,
  spotBlendBps = 0,
  activeXShare = 0.5
): BinDist[] {
  return distributeFromWeights(
    weightsFor(lower, upper, activeId, shape, spotBlendBps, activeXShare)
  );
}

/** What each bin actually receives, for the preview. `mul_bps` floors. */
export function preview(dist: BinDist[], amountX: bigint, amountY: bigint) {
  return dist.map((d) => ({
    ...d,
    amountX: (amountX * BigInt(d.distributionX)) / 10_000n,
    amountY: (amountY * BigInt(d.distributionY)) / 10_000n
  }));
}
