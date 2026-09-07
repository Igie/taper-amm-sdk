/**
 * Every address the program derives, and the bin-array arithmetic that decides
 * which of them a given bin range touches.
 */
import { PublicKey } from "@solana/web3.js";
import { BINS_PER_ARRAY, MAX_BIN_ARRAY_INDEX, MIN_BIN_ARRAY_INDEX, PROGRAM_ID } from "./constants";
import { seedI64, seedU16 } from "./codec";

/**
 * Canonical mint order. The pool PDA is seeded with both mints, so X must sort
 * below Y or the same pair would be creatable at two addresses.
 */
export function comparePublicKeys(a: PublicKey, b: PublicKey) {
  return Buffer.compare(a.toBuffer(), b.toBuffer());
}

/** `[x, y]` in the order the pool PDA requires, whichever way they came in. */
export function orderMints(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  return comparePublicKeys(a, b) < 0 ? [a, b] : [b, a];
}

const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

export const configPda = (authority: PublicKey, index: number) =>
  pda([Buffer.from("config"), authority.toBuffer(), seedU16(index)]);

export const poolPda = (config: PublicKey, mintX: PublicKey, mintY: PublicKey) =>
  pda([Buffer.from("pool"), config.toBuffer(), mintX.toBuffer(), mintY.toBuffer()]);

export const reservePda = (pool: PublicKey, mint: PublicKey) =>
  pda([Buffer.from("reserve"), pool.toBuffer(), mint.toBuffer()]);

export const binArrayPda = (pool: PublicKey, index: number) =>
  pda([Buffer.from("bin_array"), pool.toBuffer(), seedI64(index)]);

// A position has no PDA. It is a plain keypair account, because its band
// moves — `resize_position` changes both edges — and an address derived from a
// band would be stale the moment it did. Positions are found with
// `getProgramAccounts` filtered on the owner, which is how clients have always
// found them; the keypair is needed only to sign the account into existence.

/** Floors towards -infinity, matching `i32::div_euclid` on chain. */
export const binArrayIndex = (binId: number) => Math.floor(binId / BINS_PER_ARRAY);

export const binArrayLower = (index: number) => index * BINS_PER_ARRAY;
export const binArrayUpper = (index: number) => index * BINS_PER_ARRAY + BINS_PER_ARRAY - 1;

export function arrayIndexesFor(lowerBinId: number, upperBinId: number) {
  const lo = binArrayIndex(lowerBinId);
  const hi = binArrayIndex(upperBinId);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/**
 * The bin arrays to hand a swap, in the order it will walk them.
 *
 * A swap starts at the active bin and moves down for X→Y or up for Y→X, so the
 * arrays it can reach are the active one and its neighbours in that direction.
 * Only arrays that exist are named: the program takes them as remaining
 * accounts and an address with no account behind it fails the instruction.
 *
 * `reach` is how many arrays past the active one to carry. Three covers 210
 * bins, which is further than a single swap will normally travel, and each
 * extra array is 6,792 bytes of account the transaction has to reference.
 *
 * Compute is the real ceiling on how far the walk gets: about 12,200 CU per
 * funded bin crossed against the 1.4M transaction limit caps any swap at 113
 * bins, and 23 under the 300k a router budgets. Carrying an array the walk
 * never reaches costs only 394 CU, which is why the Jupiter SDK trims to
 * `REACH = 2` and this default does not — see `jupiter/taper-amm-sdk/src/pda.rs`.
 * Both are measured by `swap_cost_by_reach` in `tests/tests/compute.rs`.
 */
export function swapArrayIndexes(
  activeId: number,
  swapForY: boolean,
  exists: (index: number) => boolean,
  reach = 3
) {
  const home = binArrayIndex(activeId);
  const step = swapForY ? -1 : 1;
  const out: number[] = [];
  for (let i = 0; i < reach; i += 1) {
    const index = home + step * i;
    if (index < MIN_BIN_ARRAY_INDEX || index > MAX_BIN_ARRAY_INDEX) break;
    // A missing array *is* a stop: the program breaks its walk the moment it
    // needs an index that was not supplied, so nothing past a gap can trade in
    // this swap. Naming the arrays beyond it is harmless but pointless.
    if (exists(index)) out.push(index);
  }
  return out;
}
