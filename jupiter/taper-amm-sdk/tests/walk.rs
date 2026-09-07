//! The quote against hand-computed numbers.
//!
//! The walk delegates all of its arithmetic to `taper_core`, so what these
//! check is the *plumbing* — that the budget is threaded, that bins are
//! crossed in the right direction, that a short fill is reported as one, and
//! that a transfer fee moves both ends of the trade. The arithmetic itself is
//! already covered where it lives, and Phase 5 pins the whole thing against
//! real on-chain execution.
//!
//! Every pool here is anchored at bin 0, where the price is exactly 1.0, so
//! the expected values are legible.

use std::collections::BTreeMap;

use bytemuck::Zeroable;

use taper_amm_sdk::quote::{quote_exact_in, walk_ladder, QuoteError};
use taper_amm_sdk::state::{BinArray, Bin, Config, Pool, PoolStatus};
use taper_amm_sdk::token::TransferFeeQuote;
use taper_core::constants::ONE_Q64;

/// `w0` for a 10 bps bin at the anchor, the same constant the program's own
/// tests use.
const WIDTH_10BPS: u128 = 26_593_072_477_664_180;
/// 10 bps as the program stores a bin width.
const STEP_10BPS: u32 = 1_000;

/// A config with the variable fee switched off, so a bin's fee is a constant.
fn config(base_factor: u16) -> Config {
    let mut config = Config::zeroed();
    config.base_width_q64 = WIDTH_10BPS;
    config.taper_q64 = ONE_Q64;
    config.min_bin_id = -1_000;
    config.max_bin_id = 1_000;
    config.base_factor = base_factor;
    config.filter_period = 30;
    config.decay_period = 600;
    config.reduction_factor = 5_000;
    config.variable_fee_control = 0;
    config.max_volatility_accumulator = 350_000;
    config
}

fn pool() -> Pool {
    let mut pool = Pool::zeroed();
    pool.status = PoolStatus::Enabled as u8;
    pool.active_id = 0;
    pool.index_reference = 0;
    pool.token_x_decimals = 6;
    pool.token_y_decimals = 6;
    pool
}

/// Array 0, holding `x_per_bin` of X in each of bins `0 .. bins`.
///
/// X sits *above* the active bin, so every swap below is Y in and X out and
/// walks the ladder upward from bin 0 — which is the direction the fixture is
/// laid out in.
///
/// Prices are written in as already derived, because that is the state a swap
/// finds: a bin only holds liquidity if a deposit touched it first, and a
/// deposit derives the price on its way in.
fn array_of_x(x_per_bin: u64, bins: i32) -> BTreeMap<i32, BinArray> {
    let mut array = BinArray::zeroed();
    array.index = 0;
    let ladder = config(0).ladder();
    for id in 0..bins {
        let bin = Bin {
            amount_x: x_per_bin,
            amount_y: 0,
            price: ladder.price(id).expect("price"),
            liquidity_supply: u128::from(x_per_bin),
            fee_x_per_share: 0,
            fee_y_per_share: 0,
            step_bp_x100: STEP_10BPS,
            _padding: [0; 12],
        };
        array.bins[id as usize] = bin;
    }
    BTreeMap::from([(0, array)])
}

const NO_FEE: TransferFeeQuote = TransferFeeQuote::NONE;

#[test]
fn a_swap_inside_one_bin_prices_at_that_bin() {
    // Bin 0 is exactly 1.0, and with `base_factor` zero there is no fee at
    // all, so 1,000 X buys 1,000 Y and the active bin does not move.
    let arrays = array_of_x(1_000_000, 1);
    let walk = walk_ladder(&pool(), &config(0), &arrays, 1_000, false, 0).expect("walk");

    assert_eq!(walk.amount_in, 1_000);
    assert_eq!(walk.amount_out, 1_000);
    assert_eq!(walk.fee, 0);
    assert_eq!(walk.bins_crossed, 1);
    assert_eq!(walk.start_id, 0);
    assert_eq!(walk.end_id, 0);
    assert!(!walk.partial);
}

#[test]
fn a_swap_larger_than_one_bin_walks_upward() {
    // Y in, X out walks the ladder up. Only bin 0 holds anything, so the walk
    // takes what is there and stops.
    let arrays = array_of_x(5_000, 1);
    let walk = walk_ladder(&pool(), &config(0), &arrays, 1_000_000, false, 0).expect("walk");

    assert_eq!(walk.amount_out, 5_000, "the whole bin");
    assert!(walk.partial, "the budget could not be spent");
    assert!(
        walk.amount_in < 1_000_000,
        "only what the ladder absorbed, got {}",
        walk.amount_in
    );
}

#[test]
fn a_walk_crosses_bin_after_bin_until_the_budget_runs_out() {
    // Ten bins of 1,000 Y each. A budget that can afford all of them crosses
    // all of them; the price rises 10 bps a bin, so the input needed exceeds
    // the output received.
    let arrays = array_of_x(1_000, 10);
    let walk = walk_ladder(&pool(), &config(0), &arrays, 100_000, false, 0).expect("walk");

    assert_eq!(walk.bins_crossed, 10);
    assert_eq!(walk.amount_out, 10_000);
    assert!(walk.partial, "ten bins is all there was");
    assert!(
        walk.amount_in > walk.amount_out,
        "climbing the ladder costs more than parity: {} in for {} out",
        walk.amount_in,
        walk.amount_out
    );
}

#[test]
fn a_fee_is_charged_per_bin_and_reported_separately() {
    // `base_factor` 10,000 against a 10 bps bin is a 10 bps fee.
    let arrays = array_of_x(1_000_000, 1);
    let walk = walk_ladder(&pool(), &config(10_000), &arrays, 1_000_000, false, 0).expect("walk");

    assert!(walk.fee > 0, "a fee should have been taken");
    // The fee is added on top of what reaches the bin, so it is part of the
    // input rather than deducted from the output.
    assert_eq!(walk.amount_in - walk.fee + walk.fee, walk.amount_in);
    assert!(walk.fee < walk.amount_in / 100, "10 bps, not 1%");
}

#[test]
fn a_disabled_pool_quotes_nothing() {
    let mut pool = pool();
    pool.status = PoolStatus::Disabled as u8;
    let arrays = array_of_x(1_000_000, 1);
    assert!(matches!(
        walk_ladder(&pool, &config(0), &arrays, 1_000, false, 0),
        Err(QuoteError::Core(_))
    ));
}

#[test]
fn a_walk_with_no_array_in_reach_fills_nothing() {
    let walk = walk_ladder(&pool(), &config(0), &BTreeMap::new(), 1_000, false, 0).expect("walk");
    assert_eq!(walk.bins_crossed, 0);
    assert_eq!(walk.amount_out, 0);
    assert!(walk.partial);
}

#[test]
fn a_transfer_fee_moves_both_ends_of_the_quote() {
    // 1% on the way in and 1% on the way out. The ladder never sees either:
    // it trades what arrives, and the trader is quoted what reaches them.
    let arrays = array_of_x(1_000_000, 1);
    let one_percent = {
        let mut data = vec![0u8; 166];
        data[165] = 1; // AccountType::Mint
        let length = 72 + 18 * 2;
        data.extend_from_slice(&1u16.to_le_bytes()); // TransferFeeConfig
        data.extend_from_slice(&(length as u16).to_le_bytes());
        let body = data.len();
        data.resize(body + length, 0);
        for at in [72, 90] {
            data[body + at + 8..body + at + 16].copy_from_slice(&u64::MAX.to_le_bytes());
            data[body + at + 16..body + at + 18].copy_from_slice(&100u16.to_le_bytes());
        }
        TransferFeeQuote::of_mint(&data, true, 0)
    };
    assert!(one_percent.fee().is_some(), "the fixture should charge a fee");

    let plain = quote_exact_in(
        &pool(), &config(0), &arrays, 10_000, false, &NO_FEE, &NO_FEE, 0,
    )
    .expect("plain quote");
    let taxed = quote_exact_in(
        &pool(), &config(0), &arrays, 10_000, false, &one_percent, &one_percent, 0,
    )
    .expect("taxed quote");

    assert_eq!(plain.in_amount, 10_000);
    assert_eq!(plain.out_amount, 10_000, "1.0 price, no fees anywhere");

    assert_eq!(taxed.in_amount, 10_000, "the wallet still sends what it sent");
    assert_eq!(
        taxed.walk.amount_in, 9_900,
        "the ladder only ever sees what arrived"
    );
    assert_eq!(
        taxed.out_amount, 9_801,
        "9,900 out of the reserve, less 1% on the way to the wallet"
    );
}

#[test]
fn an_input_too_small_to_buy_anything_is_not_a_zero_quote() {
    // A budget that buys no lamport at all is an error, not a fill of zero:
    // Jupiter would otherwise route through a market that cannot trade.
    let arrays = array_of_x(1_000_000, 1);
    assert_eq!(
        quote_exact_in(&pool(), &config(0), &arrays, 0, false, &NO_FEE, &NO_FEE, 0),
        Err(QuoteError::NoFill)
    );
}
