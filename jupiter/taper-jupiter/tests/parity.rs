//! Quote parity against real on-chain execution.
//!
//! Jupiter's bar for an integration: take live pool state, run `Amm::quote`,
//! execute the real instruction, and assert the token deltas match the quote
//! exactly. This is the second half of that. The first half runs in
//! `tests/tests/parity_fixtures.rs`, where LiteSVM and the real `taper_amm.so`
//! already live: it snapshots the accounts an `Amm` would read, executes the
//! swap for real, and records what the trader's wallet actually gained and
//! lost. Here those snapshots are quoted and the two are compared.
//!
//! So the numbers below are not expectations anybody typed. They came out of
//! the program, executed by the SVM.
//!
//! Their own harness routes through a committed `jupiter_v6.so` that decodes a
//! `Swap` enum variant to pick a DEX, so it cannot execute a Taper hop until
//! Jupiter ships both `Swap::Taper` and an aggregator that dispatches it —
//! neither of which is forkable. Splitting the property across the two
//! workspaces tests the same thing without waiting on that.
//!
//! Regenerate the fixtures with `cd tests; cargo test --test parity_fixtures`.

mod common;

use common::{load, names, Fixture};
use jupiter_amm_interface::{Amm, QuoteParams, SwapMode};

fn quote(fixture: &Fixture) -> jupiter_amm_interface::Quote {
    common::amm(fixture)
        .quote(&QuoteParams {
            amount: fixture.amount,
            input_mint: fixture.input_mint,
            output_mint: fixture.output_mint,
            swap_mode: SwapMode::ExactIn,
            fee_mode: Default::default(),
        })
        .expect("quote")
}

#[test]
fn every_quote_matches_what_the_program_actually_did() {
    let names = names();
    assert!(names.len() >= 11, "the fixture set has shrunk: {names:?}");

    for name in &names {
        let fixture = load(name);
        let quote = quote(&fixture);

        println!(
            "{:<28} in {:>12} out {:>12}   {}",
            fixture.name, quote.in_amount, quote.out_amount, fixture.covers
        );
        assert_eq!(
            quote.in_amount, fixture.observed_in,
            "{}: quoted input does not match what the swap took ({})",
            fixture.name, fixture.covers
        );
        assert_eq!(
            quote.out_amount, fixture.observed_out,
            "{}: quoted output does not match what the swap delivered ({})",
            fixture.name, fixture.covers
        );
    }
}

/// The check on the check: if the comparison above could not fail, it would
/// prove nothing. One lamport either way has to be caught.
#[test]
fn a_one_lamport_error_would_be_caught() {
    let fixture = load("plain_x_to_y");
    let quote = quote(&fixture);
    assert_ne!(quote.out_amount, fixture.observed_out + 1);
    assert_ne!(quote.out_amount, fixture.observed_out - 1);
    assert_ne!(quote.in_amount, fixture.observed_in + 1);
}

/// A partial fill is where a quote is easiest to get wrong: the honest answer
/// is what the ladder absorbed, not what was offered.
#[test]
fn a_partial_fill_quotes_what_was_consumed_not_what_was_offered() {
    let fixture = load("partial_fill");
    let quote = quote(&fixture);
    assert!(
        quote.in_amount < fixture.amount,
        "the fixture should not be fillable in full"
    );
    assert_eq!(quote.in_amount, fixture.observed_in);
}

/// The transfer-fee cases are the ones where the two ends of a quote come
/// apart, so it is worth stating what each of them means rather than trusting
/// the loop above to have covered it.
#[test]
fn transfer_fees_move_the_ends_and_not_the_ladder() {
    let plain = load("plain_x_to_y");
    let plain_quote = quote(&plain);

    // A fee on the input: the wallet sends the same, the ladder trades less,
    // so less comes back.
    let on_input = load("transfer_fee_on_input");
    let input_quote = quote(&on_input);
    assert_eq!(input_quote.in_amount, plain_quote.in_amount);
    assert!(input_quote.out_amount < plain_quote.out_amount);

    // A fee on the output: the ladder trades the same and the wallet receives
    // less on the way home.
    let on_output = load("transfer_fee_on_output");
    let output_quote = quote(&on_output);
    assert!(output_quote.out_amount < plain_quote.out_amount);

    // Both at once is strictly worse than either alone.
    let on_both = load("transfer_fee_on_both");
    let both_quote = quote(&on_both);
    assert!(both_quote.out_amount < input_quote.out_amount);
    assert!(both_quote.out_amount < output_quote.out_amount);
}
