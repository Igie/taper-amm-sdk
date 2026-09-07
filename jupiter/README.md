# Taper for Jupiter

Two crates, and a fourth cargo workspace to hold them. `jupiter-amm-interface`
drags in the Agave host tree, which has to stay out of the SBF graph the
program compiles in — the same reason `tests/` and `localnet/` are separate.

| crate | what it is |
| --- | --- |
| `taper-amm-sdk` | Taper from the outside: PDAs, account parsing, quotes, instruction builders |
| `taper-jupiter` | `jupiter_amm_interface::Amm`, and nothing else |

```powershell
cd jupiter
cargo test --locked                           # see "Interface version" for the --locked
cargo tree -e normal | Select-String anchor   # nothing, and that is the point
cd ..; ./scripts/verify-swap-variant.ps1      # the half of it Jupiter has to merge
```

## The one idea

**The quote is not a reimplementation.** `taper-amm-sdk::quote` is
`instructions::swap` with the token transfers removed, calling the same
`taper_core` functions the on-chain program calls — the same `swap_in_bin`,
the same ladder, the same per-bin fee, the same volatility accumulator. There
is one `Ladder::price` in this repository and this crate calls it.

That is what makes exactness a property rather than an aspiration, and it is
why `taper-core` was extracted before any of this was written.

## Three things a bin AMM makes awkward

- **Jupiter forbids network calls, and the bin arrays are not fixed.**
  `Pool::bin_array_bitmap` is what makes `get_accounts_to_update` answerable:
  it already says which arrays exist, so they can be named without a lookup.
  `has_dynamic_accounts` is `true` because the set follows the active bin.
- **A quote is not a pure function of account state.** The pool decays its
  volatility reference off the wall clock, so `quote` reads the timestamp from
  the `ClockRef` in `AmmContext`, never from the pool.
- **Transfer fees move both ends.** The ladder is budgeted in what *arrives*,
  so the input mint's fee comes off before the walk and the output mint's after
  it. Jupiter measures at the trader's wallet, and so does `quote_exact_in`.

## `reach = 2`

The active bin's array, plus one in the direction of travel.

`tests/tests/compute.rs` measures a hop at ~12,400 CU per funded bin crossed
against a 1.4M transaction ceiling, which caps *any* Taper hop at about 110
bins. Two arrays cover between 71 and 140, depending where the active bin sits
inside its own array — so a third can never be reached by a swap that fits in a
transaction at all. `get_accounts_to_update` names three (both directions, since
the direction is unknown then); `get_accounts_len` is `11 + 2`.

## What is not finished, and cannot be by us

`get_swap_and_account_metas` builds its account metas and then fails, because
`jupiter_amm_interface::Swap` is a closed enum of 95 DEX-specific variants and
its `DynamicV1` escape hatch is closed too — `CandidateSwap` names only
HumidiFi, TesseraV and HumidiFiV2. **`Swap::Taper { swap_for_y }` is a commit in
Jupiter's repository.**

Failing is deliberate. Borrowing another DEX's variant would compile and look
finished, and then have Jupiter build a CPI against a different program's
instruction layout — a malformed transaction rather than an honest "not yet".

Everything either side of it is tested in both builds. The metas are reachable
without the variant, through `TaperAmm::swap_account_metas`, so
`tests/swap_variant.rs` checks them in the build that ships today: the eleven
fixed accounts against the pool's own, the arrays in travel order, and that no
hop names more accounts than `get_accounts_len` declared. The same file asserts
the gate reports its own absence, and — under `pending-swap-variant` — that the
variant carries the direction.

[`upstream/`](upstream/) holds the patch we are asking Jupiter to take, for
both interface versions, plus what an aggregator needs to dispatch it.
`./scripts/verify-swap-variant.ps1` applies it to a copy of the published crate
and runs the feature build against it, so "one line to change" is a tested
claim. Both versions pass.

## Interface version (D2)

`jupiter-amm-interface = "0.6.1"`, in `[workspace.dependencies]` so there is one
line to change.

Chosen because it is what `jup-ag/jupiter-amm-implementation` itself pins:
`0.6.0`, with `solana-account-decoder` locked at `2.2.19`.

It does not build on its own. The interface asks for `solana-account-decoder
>= 2` and calls `UiAccount::decode`, which 4.x removed, so a fresh resolve hands
it a version it cannot compile against. `1.0.0-beta.0` needs none of that and
builds with no change to our code; both were tried.

**`Cargo.lock` is what holds that together, and it is load-bearing.** The
`solana-account-decoder = "~2"` line below is a steer, not a constraint: it
fixes the version *we* link, and cargo is free to answer the interface's own
`>= 2` with a different one. Delete the lock and `cargo generate-lockfile`
takes both — 2.3.13 for us, 4.1.2 for the interface — and the build fails in
the interface, on `UiAccount`. So **build this workspace `--locked`**, and treat
a `cargo update` here as a change that has to be re-verified rather than a
routine one. Jupiter's own harness works the same way, locking
`solana-account-decoder` at `2.2.19`.

The same loose `>= 2` requirements are why `scripts/verify-swap-variant.ps1`
pins the patched copy's dependencies to what the lock already resolved: patching
a package re-resolves *its* dependencies, and left alone the interface lands on
a different `Pubkey` and `AccountMeta` than our crates.
