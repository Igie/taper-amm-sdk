//! What a swap would do.
//!
//! This is `instructions::swap` with the token transfers taken out. Every
//! number it produces comes from `taper_core` — `swap_in_bin`, the ladder, the
//! fee schedule, the volatility accumulator — so the quote is not an
//! approximation of the program's arithmetic, it *is* the program's
//! arithmetic. The walk mutates its own copy of the bins as it goes, for the
//! same reason the program does: what the second bin can sell depends on what
//! the first one just bought.
//!
//! Two things a caller must not get wrong, both of which this module handles
//! rather than leaving to them:
//!
//! - **A quote is not a pure function of account state.** `update_references`
//!   decays the volatility reference off the wall clock, so a stale timestamp
//!   quotes a fee that is too high or too low. `now` is a parameter, not a
//!   read.
//! - **Transfer fees move both ends.** The ladder is budgeted in what
//!   *arrives*, so the input's fee comes off before the walk and the output's
//!   comes off after it. [`quote_exact_in`] reports the trade the way the
//!   trader's own wallet will see it.

use std::collections::BTreeMap;

use taper_core::constants::MAX_BINS_PER_SWAP;
use taper_core::math::ladder::bin_array_index;
use taper_core::math::swap::swap_in_bin;
use taper_core::state::{BinArray, Config, Pool};
use taper_core::CoreError;

use crate::token::TransferFeeQuote;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuoteError {
    /// The pool is disabled, or some arithmetic in the ladder gave up.
    Core(CoreError),
    /// A bin array the walk needed was not in the map it was handed.
    MissingBinArray(i32),
    /// The transfer-fee arithmetic overflowed a `u64`.
    TransferFeeOverflow,
    /// Nothing filled: no liquidity in reach, or an input too small to buy a
    /// single lamport.
    NoFill,
    /// The mints given are not this pool's pair.
    WrongMints,
}

impl From<CoreError> for QuoteError {
    fn from(error: CoreError) -> Self {
        QuoteError::Core(error)
    }
}

impl core::fmt::Display for QuoteError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            QuoteError::Core(e) => write!(f, "{e}"),
            QuoteError::MissingBinArray(i) => write!(f, "bin array {i} was not supplied"),
            QuoteError::TransferFeeOverflow => f.write_str("transfer fee arithmetic overflowed"),
            QuoteError::NoFill => f.write_str("no liquidity in reach filled this swap"),
            QuoteError::WrongMints => f.write_str("mints are not this pool's pair"),
        }
    }
}

impl std::error::Error for QuoteError {}

/// What the ladder itself did, in arrival units at both ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Walk {
    /// Consumed from the budget. Less than the budget on a partial fill.
    pub amount_in: u64,
    /// Taken out of the reserve, before the output mint's fee.
    pub amount_out: u64,
    /// The swap fee, in whichever token the collect mode denominates it.
    pub fee: u64,
    pub bins_crossed: u32,
    pub start_id: i32,
    pub end_id: i32,
    /// The ladder could not absorb the whole budget.
    pub partial: bool,
}

/// The same trade as the trader's wallet sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SwapQuote {
    /// Leaves the wallet, transfer fee included.
    pub in_amount: u64,
    /// Reaches the wallet, transfer fee already taken off.
    pub out_amount: u64,
    /// The pool's swap fee. Not the mints' transfer fees.
    pub fee_amount: u64,
    /// True when the swap fee is denominated in Y rather than X.
    pub fee_in_y: bool,
    pub walk: Walk,
}

/// Walks the ladder exactly as `instructions::swap` does.
///
/// `arrays` is what a client fetched; the walk copies each one it enters and
/// leaves the caller's untouched, so the same map can serve many quotes. That
/// copy is why this takes `&BTreeMap` and not `&mut`: `Amm::quote` has only
/// `&self`.
///
/// `budget` is in *arrival* units — the input mint's transfer fee has already
/// come off. Use [`quote_exact_in`] to start from a wallet amount instead.
pub fn walk_ladder(
    pool: &Pool,
    config: &Config,
    arrays: &BTreeMap<i32, BinArray>,
    budget: u64,
    swap_for_y: bool,
    now: i64,
) -> Result<Walk, QuoteError> {
    pool.require_enabled()?;

    let mut pool = *pool;
    pool.update_references(config, now)?;

    let ladder = config.ladder();
    let fee_on_output = config.collect_fee_mode()?.fee_on_output(swap_for_y);
    let step: i32 = if swap_for_y { -1 } else { 1 };
    let start_id = pool.active_id;

    // Copied on first touch rather than up front: a walk that stays in one
    // array should not pay to clone the two beside it.
    let mut touched: BTreeMap<i32, BinArray> = BTreeMap::new();

    let (mut amount_left, mut total_in, mut total_out, mut total_fee) = (budget, 0u64, 0u64, 0u64);
    let mut crossed = 0u32;

    for _ in 0..MAX_BINS_PER_SWAP {
        if amount_left == 0 {
            break;
        }
        let bin_id = pool.active_id;
        if !config.contains_bin(bin_id) {
            break;
        }
        let index = bin_array_index(bin_id);
        // A gap ends the walk, exactly as `BinArrays::get` does on chain.
        if !touched.contains_key(&index) {
            let Some(array) = arrays.get(&index) else {
                break;
            };
            touched.insert(index, *array);
        }
        let array = touched.get_mut(&index).expect("just inserted");

        let (filled, exhausted) = {
            let bin = array.bin_mut(bin_id, &ladder)?;
            let available = if swap_for_y { bin.amount_y } else { bin.amount_x };
            if available == 0 {
                (false, true)
            } else {
                pool.update_volatility_accumulator(config, bin_id)?;
                let fee_rate = pool.fee_rate_for_step(config, bin.step_bp_x100)?;

                let result = swap_in_bin(
                    bin.amount_x,
                    bin.amount_y,
                    bin.price,
                    amount_left,
                    swap_for_y,
                    fee_rate,
                    fee_on_output,
                )?;

                if result.is_noop() {
                    // Inventory the remaining input cannot buy a lamport of.
                    (false, false)
                } else {
                    if swap_for_y {
                        bin.amount_x = bin
                            .amount_x
                            .checked_add(result.bin_in)
                            .ok_or(CoreError::MathOverflow)?;
                        bin.amount_y -= result.bin_out;
                    } else {
                        bin.amount_y = bin
                            .amount_y
                            .checked_add(result.bin_in)
                            .ok_or(CoreError::MathOverflow)?;
                        bin.amount_x -= result.bin_out;
                    }
                    amount_left -= result.amount_in;
                    total_in += result.amount_in;
                    total_out += result.amount_out;
                    total_fee += result.fee;
                    crossed += 1;
                    (true, false)
                }
            }
        };

        if !filled && !exhausted {
            break; // dust
        }
        if amount_left == 0 {
            break;
        }
        let next = bin_id.checked_add(step).ok_or(CoreError::BinIdOutOfRange)?;
        if !config.contains_bin(next) {
            break;
        }
        pool.active_id = next;
    }

    Ok(Walk {
        amount_in: total_in,
        amount_out: total_out,
        fee: total_fee,
        bins_crossed: crossed,
        start_id,
        end_id: pool.active_id,
        partial: total_in < budget,
    })
}

/// A quote denominated at the trader's wallet on both ends.
///
/// `in_amount` is what leaves it and `out_amount` what reaches it, which is
/// where Jupiter measures and where the program's own `min_amount_out` guard
/// applies. Between them sits the ladder, which never sees either number.
///
/// The `min(amount_in)` on the way out is not defensive: `to_send` rounds
/// towards the reserve and can name one lamport more than the trader offered,
/// and the program caps it the same way for the same reason.
#[allow(clippy::too_many_arguments)]
pub fn quote_exact_in(
    pool: &Pool,
    config: &Config,
    arrays: &BTreeMap<i32, BinArray>,
    amount_in: u64,
    swap_for_y: bool,
    in_fee: &TransferFeeQuote,
    out_fee: &TransferFeeQuote,
    now: i64,
) -> Result<SwapQuote, QuoteError> {
    let budget = in_fee
        .received(amount_in)
        .ok_or(QuoteError::TransferFeeOverflow)?;
    if budget == 0 {
        return Err(QuoteError::NoFill);
    }

    let walk = walk_ladder(pool, config, arrays, budget, swap_for_y, now)?;
    if walk.amount_out == 0 {
        return Err(QuoteError::NoFill);
    }

    let in_amount = in_fee
        .to_send(walk.amount_in)
        .ok_or(QuoteError::TransferFeeOverflow)?
        .min(amount_in);
    let out_amount = out_fee
        .received(walk.amount_out)
        .ok_or(QuoteError::TransferFeeOverflow)?;

    // The fee lands in Y unless it was taken from an X input — the same
    // condition `instructions::swap` calls `fee_is_y`.
    let fee_on_output = config.collect_fee_mode()?.fee_on_output(swap_for_y);
    Ok(SwapQuote {
        in_amount,
        out_amount,
        fee_amount: walk.fee,
        fee_in_y: fee_on_output || !swap_for_y,
        walk,
    })
}
