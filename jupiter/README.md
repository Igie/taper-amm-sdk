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
cargo test
cargo tree -e normal | Select-String anchor   # nothing, and that is the point
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
Against a patched interface, `--features pending-swap-variant` switches to the
real variant; everything either side of it is done and tested.

## Interface version (D2)

`jupiter-amm-interface = "0.6.1"`, in `[workspace.dependencies]` so there is one
line to change.

It does not build on its own. The interface requires `solana-account-decoder
>= 2` and calls `UiAccount::decode`, which 4.x removed, so a fresh resolve picks
a version the interface cannot compile against. The workspace pins `~2` to fix
it. `1.0.0-beta.0` builds with no pin and no other change to our code; both were
tried before this was chosen.
