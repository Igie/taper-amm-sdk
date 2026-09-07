# The one change that is Jupiter's to make

`jupiter_amm_interface::Swap` is a closed enum, and its `DynamicV1` escape
hatch is closed too — `CandidateSwap` names only HumidiFi, TesseraV and
HumidiFiV2. So a Taper hop cannot be expressed at all until the enum has a
variant for it, and that variant is a commit in Jupiter's repository rather
than ours.

This directory is our half of that: the diff, and everything an aggregator
needs to dispatch what it selects.

| file | against |
| --- | --- |
| `swap-taper-0.6.1.patch` | `jupiter-amm-interface` 0.6.1 — what this workspace pins, and what `jup-ag/jupiter-amm-implementation` pins |
| `swap-taper-1.0.0-beta.0.patch` | 1.0.0-beta.0, if that is the line Jupiter would rather take |

Both append one variant to the end of `Swap`:

```rust
    Taper {
        swap_for_y: bool,
    },
```

Appended, not inserted, because a variant's position is an ordinal that
`jupiter_v6.so` decodes. Nothing else in the crate has to move: the only
`match` over `Swap` is `TryInto<CandidateSwap>`, and it already has a `_` arm.
`swap_for_y` mirrors `SarosDlmm`, the closest existing precedent — another
bin AMM in the DLMM lineage — and it is the program's own argument name.

## Verifying it

```powershell
./scripts/verify-swap-variant.ps1                        # 0.6.1
./scripts/verify-swap-variant.ps1 -Version 1.0.0-beta.0  # the fallback
```

That copies the published crate out of the cargo registry, applies the patch,
points `[patch.crates-io]` at the copy and runs `taper-jupiter`'s tests with
`--features pending-swap-variant` — the feature that switches
`taper_jupiter::taper_swap` from an honest error to `Swap::Taper`. Both
versions pass, and a run leaves `git status` clean.

Without it, that feature would be code nobody had ever compiled. It is easy to
write a one-line `#[cfg]` arm against a type that does not exist yet and
believe it, and the two type errors it took to get this passing were both real.

## Dispatching it

What the aggregator has to build once it has selected the variant. All of it is
also in `taper-amm-sdk::instructions`, which is the source these numbers were
read from.

**Program** `taperAJP7yuCyqnFUW3Xa3byvQ2YRY29w73NJrjYRUd`

**Data** — 25 bytes, Anchor's layout:

| bytes | |
| --- | --- |
| 0..8 | `sha256("global:swap")[..8]` = `f8 c6 9e 91 e1 75 87 c8` |
| 8..16 | `amount_in`, `u64` little-endian |
| 16..24 | `min_amount_out`, `u64` little-endian |
| 24 | `swap_for_y`, one byte |

**Accounts** — the eleven `Amm::get_swap_and_account_metas` returns first, then
one per bin array:

| # | account | |
| --- | --- | --- |
| 0 | user | signer |
| 1 | pool | writable |
| 2 | config | |
| 3 | token X mint | |
| 4 | token Y mint | |
| 5 | user's input token account | writable |
| 6 | user's output token account | writable |
| 7 | reserve X | writable |
| 8 | reserve Y | writable |
| 9 | token X's program | |
| 10 | token Y's program | |
| 11.. | bin arrays | writable |

Two things about that list are worth stating rather than inferring.

**The mints and token programs are named by side, X then Y, never by
direction.** The program decides which is in and which is out from
`swap_for_y`, so the account list does not change shape when the direction
does — only slots 5 and 6 and the bin arrays move. Either side may be SPL
Token or Token-2022, which is why both programs are named.

**The bin arrays are in the order the walk will visit them**: down from the
active bin's array when X is going in, up when Y is. At most two, and the
walk stops at the first index it was not handed, so an array out of order is a
hop that fills less than it quoted rather than one that fails. `reach = 2` is
measured, not guessed — a Taper hop costs ~12,400 CU per funded bin crossed,
which caps any hop at ~110 bins against a 1.4M ceiling, and two arrays already
cover between 71 and 140.

## The one open question

`swap` fills partially: it breaks its walk at the band edge, at a missing bin
array, at dust, or at `MAX_BINS_PER_SWAP`, and transfers only what the ladder
absorbed. `Quote.in_amount` reports the smaller figure honestly, but under
`shared_accounts_route` the unconsumed remainder would sit in a Jupiter program
ATA.

If that is a problem, `swap_strict` is the same instruction — same accounts,
same args, byte for byte identical but for the discriminator
`sha256("global:swap_strict")[..8]` = `0f a7 d2 a8 3e 8f 0a e3` — with one added
post-condition: it reverts rather than under-filling. It already exists on
chain and is tested. Which of the two `Swap::Taper` should dispatch is Jupiter's
call, and it does not change the variant.
