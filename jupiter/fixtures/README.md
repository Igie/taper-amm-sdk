# Parity fixtures

Snapshots of real pool state, and beside each one what the program actually did
with it.

`tests/tests/parity_fixtures.rs` writes them: it builds a scenario in LiteSVM,
records the accounts a client would read, executes the swap against the real
`taper_amm.so`, and stores the deltas the trader's wallet saw. So the numbers in
`observedIn` / `observedOut` are not expectations anybody typed — they came out
of the SVM.

Three things then check themselves against the same set:

| consumer | what it proves |
| --- | --- |
| `jupiter/taper-jupiter/tests/parity.rs` | the Rust `Amm::quote` predicts execution exactly |
| `sdk/test/parity.test.ts` | the TypeScript `quoteSwap` does too |
| `tests/tests/parity_fixtures.rs` | the fixtures still describe the current program |

Pinning both quotes to the same execution pins them to each other, which is
what the integration plan wanted from porting vectors between them — by a
shorter route, and against a stronger reference.

## Regenerating

```powershell
cd tests; cargo test --test parity_fixtures
```

Every key is seeded, so a run that changes nothing rewrites the files byte for
byte and `git status` stays clean. A diff here means the program's behaviour
moved, and the two quote implementations should be expected to fail until they
move with it.

## Why not Jupiter's own harness

`jup-ag/jupiter-amm-implementation` does exactly this, routing through a
committed `jupiter_v6.so`. That binary decodes a `Swap` enum variant to decide
which DEX to call, so it cannot execute a Taper hop until Jupiter ships both
`Swap::Taper` and an aggregator that dispatches it. Neither is forkable, so the
property is tested here instead — the same property, minus Jupiter's own CPI
wrapper.

## The cases, and why each is here

| fixture | what would break without it |
| --- | --- |
| `plain_x_to_y`, `plain_y_to_x` | the plumbing, in both directions |
| `crosses_an_array_boundary` | a walk that leaves one bin-array account for the next |
| `starts_on_an_empty_bin` | the active bin holding nothing, so the walk steps past it |
| `partial_fill` | quoting what the ladder absorbed rather than what was offered |
| `quote_only_fee_x_to_y`, `quote_only_fee_y_to_x` | `CollectFeeMode::QuoteOnly`, where one direction takes the fee out of the output |
| `after_a_quiet_period` | reading the clock rather than the pool — a quote is not a pure function of account state |
| `transfer_fee_on_input`, `_output`, `_both` | the ladder trading arrival units while the trader is quoted wallet units |
