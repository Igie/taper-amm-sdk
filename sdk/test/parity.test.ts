/**
 * The TypeScript quote against real on-chain execution.
 *
 * `jupiter/fixtures/` holds snapshots written by
 * `tests/tests/parity_fixtures.rs`: the accounts a client would read, and
 * beside them what the trader's wallet actually gained and lost when the real
 * program executed that swap in LiteSVM.
 *
 * They exist for the Jupiter integration, and the Rust quote is checked
 * against them in `jupiter/taper-jupiter/tests/parity.rs`. Checking the
 * TypeScript quote against the same numbers costs almost nothing and buys the
 * property the plan asked for by a shorter route than porting vectors between
 * the two: both quotes are pinned to the same execution, so they are pinned to
 * each other.
 *
 * `ui/scripts/e2e.ts` proves the same thing against a live localnet. This is
 * the offline half — no server, no build, and it covers cases a lifecycle
 * script cannot easily reach, like a Token-2022 pair with a fee on both sides.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { BINS_PER_ARRAY } from "../src/constants";
import { parseBin, parseConfig, parsePool } from "../src/accounts";
import { amountAfterTransferFee, screenMint } from "../src/mint";
import { binArrayIndex, binArrayLower } from "../src/pda";
import { quoteSwap } from "../src/quote";
import type { BinView } from "../src/types";

const FIXTURES = join(import.meta.dir, "..", "..", "jupiter", "fixtures");

type Fixture = {
  name: string;
  covers: string;
  pool: string;
  unixTimestamp: number;
  epoch: number;
  inputMint: string;
  outputMint: string;
  amount: number;
  observedIn: number;
  observedOut: number;
  accounts: Record<string, { owner: string; data: string }>;
};

const names: string[] = JSON.parse(readFileSync(join(FIXTURES, "index.json"), "utf8"));
const load = (name: string): Fixture =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));

const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"));

/** A `BinArray`'s own index, from the account rather than from its address. */
const arrayIndexOf = (data: Uint8Array) =>
  Number(new DataView(data.buffer, data.byteOffset).getBigInt64(8 + 32, true));

/**
 * Quotes a fixture the way a client would: parse what was fetched, strip the
 * input mint's transfer fee before the walk, and take the output mint's off
 * after it.
 */
function quote(fixture: Fixture) {
  const account = (key: string) => {
    const entry = fixture.accounts[key];
    if (!entry) throw new Error(`${fixture.name}: ${key} is not in the snapshot`);
    return { data: bytes(entry.data), owner: new PublicKey(entry.owner) };
  };

  const pool = parsePool(account(fixture.pool).data);
  const config = parseConfig(account(pool.config.toBase58()).data);

  // Every bin in every array that was snapshotted. An untouched bin parses as
  // empty, which is exactly what the program's walk finds there.
  const bins = new Map<number, BinView>();
  const arrays = new Set<number>();
  for (const entry of Object.values(fixture.accounts)) {
    const data = bytes(entry.data);
    // A bin array is the only account of this size the snapshot holds.
    if (data.length !== 6792) continue;
    const index = arrayIndexOf(data);
    arrays.add(index);
    for (let slot = 0; slot < BINS_PER_ARRAY; slot += 1) {
      const binId = binArrayLower(index) + slot;
      bins.set(binId, parseBin(data, index, binId));
    }
  }

  const swapForY = fixture.inputMint === pool.tokenXMint.toBase58();
  const inAccount = account(fixture.inputMint);
  const outAccount = account(fixture.outputMint);
  const inMint = screenMint(new PublicKey(fixture.inputMint), inAccount.data, inAccount.owner);
  const outMint = screenMint(new PublicKey(fixture.outputMint), outAccount.data, outAccount.owner);

  // The ladder is budgeted in what arrives, never in what left the wallet.
  const budget = amountAfterTransferFee(inMint, BigInt(fixture.amount));
  const walk = quoteSwap({
    pool,
    config,
    bins,
    hasArray: (index) => arrays.has(index),
    amountIn: budget,
    swapForY,
    now: fixture.unixTimestamp
  });

  return {
    walk,
    outAmount: amountAfterTransferFee(outMint, walk.amountOut),
    inputHasFee: inMint.transferFeeBps > 0
  };
}

describe("quoteSwap against real execution", () => {
  test("the fixture set is present", () => {
    expect(names.length).toBeGreaterThanOrEqual(11);
    const files = readdirSync(FIXTURES).filter((f) => f !== "index.json");
    expect(files.length).toBe(names.length);
  });

  for (const name of names) {
    test(name, () => {
      const fixture = load(name);
      const { walk, outAmount, inputHasFee } = quote(fixture);

      expect(outAmount).toBe(BigInt(fixture.observedOut));

      // What the wallet sent only equals what the ladder consumed when there
      // is no transfer fee in between; with one, the program grosses the
      // consumed amount back up and caps it at the offer.
      if (!inputHasFee) {
        expect(walk.amountIn).toBe(BigInt(fixture.observedIn));
      } else if (!walk.partial) {
        expect(BigInt(fixture.observedIn)).toBe(BigInt(fixture.amount));
      }
    });
  }

  test("a one-lamport error would be caught", () => {
    const fixture = load("plain_x_to_y");
    const { outAmount } = quote(fixture);
    expect(outAmount).not.toBe(BigInt(fixture.observedOut) + 1n);
    expect(outAmount).not.toBe(BigInt(fixture.observedOut) - 1n);
  });

  test("a partial fill quotes what was consumed, not what was offered", () => {
    const fixture = load("partial_fill");
    const { walk } = quote(fixture);
    expect(walk.partial).toBe(true);
    expect(walk.amountIn).toBeLessThan(BigInt(fixture.amount));
    expect(walk.amountIn).toBe(BigInt(fixture.observedIn));
  });

  test("the array index a bin array reports is the one its address derives", () => {
    // The bins map above is keyed off the account's own index field; if that
    // read were wrong every price would be attributed to the wrong bin.
    const fixture = load("crosses_an_array_boundary");
    for (const [, entry] of Object.entries(fixture.accounts)) {
      const data = bytes(entry.data);
      if (data.length !== 6792) continue;
      const index = arrayIndexOf(data);
      expect(binArrayIndex(binArrayLower(index))).toBe(index);
    }
  });
});
