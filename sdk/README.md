# `@taper/sdk`

A client-side view of the [`taper-amm`](https://explorer.solana.com/address/taperAJP7yuCyqnFUW3Xa3byvQ2YRY29w73NJrjYRUd)
ABI: program addresses, PDAs, instruction builders, account parsers, a swap
quote, a multi-transaction planner, and an independent `f64` re-derivation of
the price ladder.

`taper-amm` is a discrete-bin AMM in the DLMM lineage with a **non-constant bin
step**: each bin is a fixed factor narrower than the one below it, so the
ladder tightens as price rises and the fee schedule is per-bin rather than
per-pool.

```powershell
bun install
bun test
```

## What it is not

There is no `Connection`, no RPC client, and no transaction sender. The SDK
builds `TransactionInstruction`s and reads `Uint8Array`s; transport is the
caller's problem. That is deliberate — it is what lets the same code drive a
WebSocket-less local simulator, devnet and mainnet without branching.

## Why it is written this way

Nothing here imports the program crate. Discriminators are the constants
Anchor generates, instruction data is packed by hand, and accounts are read by
byte offset — exactly like the program's own integration tests. A layout drift
on chain therefore breaks this package loudly rather than silently misparsing.

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

The same discipline runs through the two copied tables. `test/parity.test.ts`
checks the swap quote against snapshots of *real executions* — the accounts a
client would read, and beside them what the trader's wallet actually gained and
lost — so the quote is pinned to what the program did rather than to what it
was expected to do. `test/errors.test.ts` parses the program's error table out
of the Rust source and fails if `src/errors.ts` drifts from it in name, order
or message.

## Layout

```
src/
  constants.ts     program id, account sizes, Anchor discriminators
  network.ts       mainnet / devnet / localnet, endpoints, explorer links
  errors.ts        the program's error table; decoding a bare Custom(n)
  types.ts         ConfigView / PoolView / BinView / PositionView, TokenPair
  codec.ts         little-endian writers and readers, the instruction ctor
  pda.ts           every derived address, plus bin-array arithmetic
  ladder.ts        the f64 ladder, fee schedule, usable range, config builder
  instructions.ts  one builder per program instruction
  accounts.ts      parsers, accrued-fee math, getProgramAccounts filters
  quote.ts         the swap walk, mirrored from the program line for line
  plan.ts          open, grow and fill a position across transactions
  shapes.ts        spot / curve / bid-ask deposit distributions
  position.ts      what a position holds, is worth, and is owed
  mint.ts          Token-2022 extension screening, transfer-fee arithmetic
  token.ts         ATA derivation, balances, idempotent creates
  native.ts        wrapping and unwrapping SOL around a transaction
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

## Networks

The program has **one address on every network**, so nothing here takes a
cluster to derive an address. `network.ts` exists for the three things that do
differ: a default endpoint, an explorer link, and whether a mistake costs real
money (`live`).

```ts
import { NETWORKS, networkFor, withEndpoint, explorerTx } from "@taper/sdk";

const network = withEndpoint(networkFor("mainnet-beta")!, myPrivateRpc);
const connection = new Connection(network.endpoint, "confirmed");
```

`hasWebsocket` is the field that changes caller code: against the local
simulator there is no subscription endpoint, so poll `getSignatureStatuses`
and never call `confirmTransaction`.

## Two things worth knowing before you build a transaction

**A swap quote is not advisory.** `quote.ts` reproduces the program's walk line
by line — the same rounding, the same per-bin fee rate, the same volatility
accumulation — because every client's `min_amount_out` is computed from it. Any
change to the program's swap or fee math must be mirrored there.

**A wide position is built in three phases, and `plan.ts` emits all of them.**
A position spans up to 1,400 bins but is created holding at most 70, so the
sequence is: open it, grow it with `resize_position` (one call per transaction
— the runtime caps an account's growth at 10,240 bytes a transaction), then
fill it with `add_liquidity` (about 70 bins a transaction — a packet is 1,232
bytes and the account list eats 513). `widthThatFits` measures the second
ceiling rather than assuming it, taking the headroom a caller needs for its own
instructions, and an `opening` flag for the extra signature the first chunk
carries.

**A position is a keypair account, not a PDA.** `plan.ts` therefore *generates*
position addresses rather than deriving them, and an opening step carries the
keypair in `Step.signers` for the runner to pass to `sendTransaction`. Two
consequences: a plan built twice names two different accounts, so compare plans
by band rather than by address; and `existingPositions` is a list of bands, not
of addresses, because a band is all the identity a position has.

A plan is built once and *resumed* rather than re-split, so a retry after an
ambiguous timeout cannot deposit twice. Growth steps carry `idempotent: true`,
because `resize_position` takes an absolute band: re-sending one cannot do
anything twice, so a runner may simply try again where an ambiguous deposit has
to stop and ask.

**`planRebalance` moves a band without closing the position.** It withdraws and
claims over the bins that are leaving — the program refuses to drop a bin still
holding shares or an unclaimed fee — and then resizes onto the new band. The
bins the two bands share are never touched: their liquidity stays in the
reserve, still earning, and their fee checkpoints survive. The plan reports
`kept`, `leaving` and `arriving` so a caller can show what a move costs before
running it.

Two rules a runner has to respect. `Step.grows` is a "reached at least this
length" witness and is only ever set on a step that *lengthens* the account — a
narrowing resize would satisfy it before running and be skipped for good, so it
carries `idempotent` instead. And `Step.computeUnits` covers the step's own
instructions only: a runner that wraps a step in token handling shares one
compute limit with it and must add `CU_HEADROOM_NATIVE`.

## Compute budget

Bin price derivation is the expensive part of this program — roughly 10k CU
per bin. Anything touching a wide range blows past the 200k default, so raise
the limit explicitly with `ComputeBudgetProgram.setComputeUnitLimit`; `plan.ts`
exports the `CU` figures each step needs, sized from the *expensive* branch of
each measured pair, because a client cannot know in advance which it will get.

## Building

Consumers inside the monorepo (Vite, bun) read the TypeScript directly, so
`exports` points at `src/`. `bun run build` emits `dist/` with declarations,
for the day this is published to a registry.

```powershell
bun run --cwd sdk typecheck
bun run --cwd sdk build
```
