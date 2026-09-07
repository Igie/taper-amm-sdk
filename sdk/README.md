# `@taper/sdk`

A client-side view of the `taper-amm` ABI: program addresses, PDAs,
instruction builders, account parsers, and an independent `f64` re-derivation
of the price ladder.

## What it is not

There is no `Connection`, no RPC client, and no transaction sender. The SDK
builds `TransactionInstruction`s and reads `Uint8Array`s; transport is the
caller's problem. That is deliberate — it is what lets the same code drive the
WebSocket-less localnet in [`../localnet`](../localnet) and a real devnet
endpoint without branching.

## Why it is written this way

Nothing here imports the program crate. Discriminators are the constants
Anchor generates, instruction data is packed by hand, and accounts are read by
byte offset — exactly like `tests/src/lib.rs`. A layout drift on chain
therefore breaks this package loudly rather than silently misparsing.

The ladder in [`src/ladder.ts`](src/ladder.ts) is written from the formulas,
not from the Rust:

```
w(i) = w0 · τ^i                     bin width, in log2 price
v(i) = w0 · (1 − τ^i) / (1 − τ)     log2 price of bin i
P(i) = 2^v(i)                       anchored at P(0) = 1.0
```

So anything a caller draws or previews from it is a genuine cross-check of the
on-chain integer math, not an echo of it. `ui/scripts/e2e.ts` leans on exactly
that: it compares every on-chain bin price and step against this ladder.

## Layout

```
src/
  constants.ts     program id, account sizes, Anchor discriminators
  types.ts         ConfigView / PoolView / BinView / PositionView, TokenPair
  codec.ts         little-endian writers and readers, the instruction ctor
  pda.ts           every derived address, plus bin-array arithmetic
  ladder.ts        the f64 ladder, fee schedule, usable range, config builder
  instructions.ts  one builder per program instruction
  accounts.ts      parsers, accrued-fee math, getProgramAccounts filters
  shapes.ts        spot / curve / bid-ask deposit distributions
```

## Using it

```ts
import {
  PROGRAM_ID, buildConfig, initializeConfigIx, poolPda, orderMints,
  parsePool, tokenPairOf, poolFilters, Ladder
} from "@taper/sdk";

// Mint order is not optional: the pool PDA is seeded with both mints, so the
// same pair would otherwise be creatable at two addresses.
const [mintX, mintY] = orderMints(a, b);
const pool = poolPda(config, mintX, mintY);

// Enumerate every pool under one config.
const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
  filters: poolFilters(config)
});
const pools = accounts.map((a) => parsePool(a.account.data));
```

Instructions that touch bins take the covering bin arrays as remaining
accounts; `arrayIndexesFor(lower, upper)` and `binArrayPda` name them.

## Compute budget

Bin price derivation is the expensive part of this program — roughly 10k CU
per bin. Anything touching a wide range blows past the 200k default, so raise
the limit explicitly with `ComputeBudgetProgram.setComputeUnitLimit`. The
console uses 1.4M for everything.

## Building

Consumers inside this repo (Vite, bun) read the TypeScript directly, so
`exports` points at `src/`. `bun run build` emits `dist/` with declarations,
for the day this is published.

```powershell
bun run --cwd sdk typecheck
bun run --cwd sdk build
```
