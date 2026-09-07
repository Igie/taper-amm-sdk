# Taper — client SDK and Jupiter integration

Taper is a discrete-bin AMM on Solana in the DLMM lineage, with a
**non-constant bin step**: each bin is a fixed factor narrower than the one
below it, so the ladder tightens as price rises and the fee schedule is
per-bin rather than per-pool.

This repository is what a client needs to read a Taper pool and trade against
it, and nothing else. Three crates:

| crate | what it is |
| --- | --- |
| [`crates/taper-core`](crates/taper-core) | the ladder, the swap walk, the fee schedule and the account layouts — the same code the on-chain program runs |
| [`jupiter/taper-amm-sdk`](jupiter/taper-amm-sdk) | Taper from the outside: PDAs, account parsing, quotes, instruction builders |
| [`jupiter/taper-jupiter`](jupiter/taper-jupiter) | `jupiter_amm_interface::Amm`, and nothing else |

```powershell
cd jupiter
cargo test --locked
```

`--locked` is not optional here; [`jupiter/README.md`](jupiter/README.md#interface-version-d2)
explains why, and that file is the real documentation for everything below.

## The quote is not a reimplementation

`taper-amm-sdk::quote` is the program's `swap` instruction with the token
transfers removed, calling the same `taper_core` functions the program calls —
the same `swap_in_bin`, the same `Ladder::price`, the same per-bin fee, the
same volatility accumulator. There is exactly one price ladder in this
repository and the quote goes through it.

That is what makes exactness a property rather than an aspiration, and it is
why `taper-core` was split out of the Anchor program before any of this was
written: it depends on `bytemuck` and nothing else, so it can be shared by a
program built for SBF and a client built against Jupiter's Agave tree without
either constraining the other.

```powershell
cd jupiter
cargo tree -p taper-core -e normal    # bytemuck, and nothing else
cargo tree -e normal | Select-String anchor   # nothing, and that is the point
```

## Quote parity is proven against execution, not against expectations

[`jupiter/fixtures`](jupiter/fixtures) holds snapshots of real pool state and,
beside each one, what the program actually did with it: the scenario is built
in LiteSVM, the accounts a client would read are recorded, the swap is executed
against the real `taper_amm.so`, and the deltas the trader's wallet saw are
stored. `jupiter/taper-jupiter/tests/parity.rs` then builds the `Amm` the way
Jupiter does — `from_keyed_account`, `update`, `quote` — and asserts the quote
equals those deltas to the lamport.

Eleven fixtures: both directions, a walk crossing a bin-array boundary, a walk
starting on an empty bin, a partial fill, quote-only fee mode both ways, a pool
idle past its filter period, and Token-2022 transfer fees on each side and on
both.

## One piece is Jupiter's to merge

`jupiter_amm_interface::Swap` is a closed enum, so a Taper hop cannot be
expressed until it has a variant. `get_swap_and_account_metas` therefore builds
its account metas and then returns an error rather than borrowing another DEX's
variant — which would compile, look finished, and have Jupiter build a CPI
against a different program's instruction layout.

[`jupiter/upstream`](jupiter/upstream) holds the one-variant diff we are asking
for, against both interface versions, plus the program id, discriminators, data
layout and account order an aggregator needs to dispatch it.
`./scripts/verify-swap-variant.ps1` applies that diff to a copy of the published
crate and runs the integration against it, so the switch is a tested claim.

## About the layout

`crates/` and `jupiter/` sit at these paths because this repository is a
subtree of Taper's monorepo, mirrored without rewriting anything on the way
out. A path rewritten here would be a fifth place encoding the same facts, and
this codebase already tracks four. The cost is that the cargo workspace is
`jupiter/` rather than the root; the benefit is that what you fork is byte for
byte what we build and test.

The on-chain program, its tests, and the TypeScript SDK are not here. The
program is deployed at `taperAJP7yuCyqnFUW3Xa3byvQ2YRY29w73NJrjYRUd`.
