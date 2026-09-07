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
 */
import type { BinDist } from "./types";

export type Shape = "spot" | "curve" | "bidask";

export const SHAPES: { id: Shape; label: string; hint: string }[] = [
  { id: "spot", label: "Spot", hint: "Flat across the range — DLMM's uniform deposit." },
  { id: "curve", label: "Curve", hint: "Gaussian around the active bin; deepest where it trades." },
  { id: "bidask", label: "Bid-ask", hint: "Weighted to the edges; thin in the middle." }
];

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
      return 0.15 + (reach === 0 ? 1 : distance / reach);
  }
}

/**
 * Spreads 10_000 bps over `ids` by weight, giving the rounding remainder to
 * the heaviest bin so the total is exactly 10_000 (the program caps the sum at
 * 10_000 but does not require it, and leaving dust unallocated is just lost
 * deposit).
 */
function toBps(ids: number[], weights: number[]) {
  const out = new Map<number, number>();
  const total = weights.reduce((a, b) => a + b, 0);
  if (!ids.length || total <= 0) return out;

  let assigned = 0;
  ids.forEach((id, i) => {
    const bps = Math.floor((weights[i] / total) * 10_000);
    out.set(id, bps);
    assigned += bps;
  });
  const heaviest = ids[weights.indexOf(Math.max(...weights))];
  out.set(heaviest, (out.get(heaviest) ?? 0) + (10_000 - assigned));
  return out;
}

/**
 * Builds the per-bin split for a deposit over `[lower, upper]` at `activeId`.
 *
 * Bins are dropped from the result when they would receive nothing on either
 * side — the program rejects a deposit that mints zero shares, so sending a
 * bin with 0/0 is a guaranteed failure rather than a no-op.
 */
export function distribute(lower: number, upper: number, activeId: number, shape: Shape): BinDist[] {
  const ids = Array.from({ length: upper - lower + 1 }, (_, i) => lower + i);
  const xIds = ids.filter((id) => id >= activeId);
  const yIds = ids.filter((id) => id <= activeId);

  const xReach = xIds.length ? Math.max(...xIds.map((id) => id - activeId)) : 0;
  const yReach = yIds.length ? Math.max(...yIds.map((id) => activeId - id)) : 0;

  const xBps = toBps(xIds, xIds.map((id) => weight(shape, id - activeId, xReach)));
  const yBps = toBps(yIds, yIds.map((id) => weight(shape, activeId - id, yReach)));

  return ids
    .map((binId) => ({
      binId,
      distributionX: xBps.get(binId) ?? 0,
      distributionY: yBps.get(binId) ?? 0
    }))
    .filter((d) => d.distributionX > 0 || d.distributionY > 0);
}

/** What each bin actually receives, for the preview. `mul_bps` floors. */
export function preview(dist: BinDist[], amountX: bigint, amountY: bigint) {
  return dist.map((d) => ({
    ...d,
    amountX: (amountX * BigInt(d.distributionX)) / 10_000n,
    amountY: (amountY * BigInt(d.distributionY)) / 10_000n
  }));
}
