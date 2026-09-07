//! Single-bin swap math.
//!
//! A bin is a fixed-price market: inside it, X and Y exchange at exactly the
//! bin's price with zero slippage, and the price only moves when the output
//! side of the bin runs dry. Taper changes *where* the next bin sits, not how
//! a bin fills, so this module is the same constant-sum math DLMM uses.
//!
//! Rounding always favours the pool: outputs floor, required inputs ceil.

use crate::constants::ONE_Q64;
use crate::errors::{CoreError, Result};
use crate::math::fee::{fee_from_amount, fee_on_amount};
use crate::math::u256::{div_q64_ceil, mul_div, mul_q64_ceil};

/// What one bin contributed to a swap.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BinSwap {
    /// Gross input taken from the trader. Includes the fee when the fee is
    /// charged on the input side.
    pub amount_in: u64,
    /// Net output delivered to the trader.
    pub amount_out: u64,
    /// Fee charged, denominated in the input token unless `fee_on_output`.
    pub fee: u64,
    /// Credited to the bin's input-token reserve.
    pub bin_in: u64,
    /// Debited from the bin's output-token reserve. Exceeds `amount_out` by
    /// the fee when the fee is charged on the output side.
    pub bin_out: u64,
}

impl BinSwap {
    /// A bin that contributed nothing — empty, or unable to absorb even the
    /// dust that is left.
    pub fn is_noop(&self) -> bool {
        self.amount_in == 0 && self.amount_out == 0
    }
}

/// Fill as much of `amount_in_left` as this bin can absorb.
///
/// `fee_on_output` selects quote-only fee collection: when the fee must land
/// in Y but Y is the *output* token, it is carved out of the output instead
/// of the input.
///
/// Returns a no-op result rather than consuming input it cannot pay for, so
/// a trader never loses dust to a bin that yields nothing.
pub fn swap_in_bin(
    bin_amount_x: u64,
    bin_amount_y: u64,
    price_q64: u128,
    amount_in_left: u64,
    swap_for_y: bool,
    fee_rate: u128,
    fee_on_output: bool,
) -> Result<BinSwap> {
    let max_bin_out = if swap_for_y { bin_amount_y } else { bin_amount_x };
    if max_bin_out == 0 || amount_in_left == 0 {
        return Ok(BinSwap::default());
    }

    // Input, net of any input-side fee, that would drain the bin. Saturating
    // is correct: a requirement past u64 simply cannot be met by `amount_in_left`.
    let max_net_in = if swap_for_y {
        // out_y = floor(in_x * P)  =>  in_x = ceil(out_y / P)
        div_q64_ceil(max_bin_out as u128, price_q64)?
    } else {
        // out_x = floor(in_y / P)  =>  in_y = ceil(out_x * P)
        mul_q64_ceil(max_bin_out as u128, price_q64)?
    };
    let max_net_in = u64::try_from(max_net_in).unwrap_or(u64::MAX);

    if fee_on_output {
        // Quote-only collection on an X -> Y swap. The whole input enters the
        // bin; the fee is taken out of the Y leaving it.
        let (amount_in, bin_out) = if amount_in_left >= max_net_in {
            (max_net_in, max_bin_out)
        } else {
            let out = output_for(amount_in_left, price_q64, swap_for_y)?.min(max_bin_out);
            (amount_in_left, out)
        };
        if bin_out == 0 {
            return Ok(BinSwap::default());
        }
        let fee = fee_from_amount(bin_out, fee_rate)?;
        return Ok(BinSwap {
            amount_in,
            amount_out: bin_out - fee,
            fee,
            bin_in: amount_in,
            bin_out,
        });
    }

    // Fee on the input side.
    let max_fee = fee_on_amount(max_net_in, fee_rate)?;
    let max_gross_in = max_net_in.checked_add(max_fee);

    match max_gross_in {
        Some(gross) if amount_in_left >= gross => Ok(BinSwap {
            amount_in: gross,
            amount_out: max_bin_out,
            fee: max_fee,
            bin_in: max_net_in,
            bin_out: max_bin_out,
        }),
        _ => {
            let fee = fee_from_amount(amount_in_left, fee_rate)?;
            let net = amount_in_left - fee;
            let out = output_for(net, price_q64, swap_for_y)?.min(max_bin_out);
            if out == 0 {
                return Ok(BinSwap::default());
            }
            Ok(BinSwap {
                amount_in: amount_in_left,
                amount_out: out,
                fee,
                bin_in: net,
                bin_out: out,
            })
        }
    }
}

/// Output for a net input at a fixed bin price, rounded down.
fn output_for(net_in: u64, price_q64: u128, swap_for_y: bool) -> Result<u64> {
    let out = if swap_for_y {
        mul_div(net_in as u128, price_q64, ONE_Q64)?
    } else {
        mul_div(net_in as u128, ONE_Q64, price_q64)?
    };
    u64::try_from(out).map_err(|_| CoreError::MathOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NO_FEE: u128 = 0;
    const THIRTY_BPS: u128 = 3_000_000; // 0.3% against FEE_PRECISION

    /// Price 2.0: one X is worth two Y.
    const P2: u128 = 2 * ONE_Q64;

    #[test]
    fn empty_bin_is_a_noop() {
        let r = swap_in_bin(0, 0, P2, 1_000, true, THIRTY_BPS, false).unwrap();
        assert!(r.is_noop());
        let r = swap_in_bin(100, 0, P2, 1_000, true, THIRTY_BPS, false).unwrap();
        assert!(r.is_noop(), "no Y to give when swapping for Y");
    }

    #[test]
    fn zero_input_is_a_noop() {
        let r = swap_in_bin(1_000, 1_000, P2, 0, true, NO_FEE, false).unwrap();
        assert!(r.is_noop());
    }

    #[test]
    fn partial_fill_prices_at_the_bin() {
        // 100 X in at P=2 yields 200 Y, no fee.
        let r = swap_in_bin(0, 10_000, P2, 100, true, NO_FEE, false).unwrap();
        assert_eq!(r.amount_in, 100);
        assert_eq!(r.amount_out, 200);
        assert_eq!(r.fee, 0);
        assert_eq!(r.bin_in, 100);
        assert_eq!(r.bin_out, 200);
    }

    #[test]
    fn exact_fill_drains_the_bin_and_no_more() {
        // Bin holds 200 Y; draining it needs exactly 100 X.
        let r = swap_in_bin(0, 200, P2, 10_000, true, NO_FEE, false).unwrap();
        assert_eq!(r.amount_out, 200);
        assert_eq!(r.amount_in, 100);
        assert_eq!(r.bin_out, 200);
    }

    #[test]
    fn the_other_direction_inverts_the_price() {
        // 200 Y in at P=2 yields 100 X.
        let r = swap_in_bin(10_000, 0, P2, 200, false, NO_FEE, false).unwrap();
        assert_eq!(r.amount_out, 100);
        assert_eq!(r.amount_in, 200);
    }

    #[test]
    fn input_side_fee_is_added_on_top_when_the_bin_is_drained() {
        let r = swap_in_bin(0, 200, P2, 1_000_000, true, THIRTY_BPS, false).unwrap();
        // 100 X must reach the bin, so the trader pays 100 plus the fee.
        assert_eq!(r.bin_in, 100);
        assert_eq!(r.amount_in, 100 + r.fee);
        assert_eq!(r.amount_out, 200);
        assert!(r.fee >= 1);
    }

    #[test]
    fn input_side_fee_is_carved_out_when_the_bin_is_not_drained() {
        let r = swap_in_bin(0, 10_000_000, P2, 1_000, true, THIRTY_BPS, false).unwrap();
        assert_eq!(r.amount_in, 1_000);
        assert_eq!(r.bin_in + r.fee, 1_000, "fee comes out of the input");
        assert_eq!(r.amount_out, r.bin_in * 2);
    }

    #[test]
    fn output_side_fee_leaves_the_input_whole() {
        let r = swap_in_bin(0, 10_000_000, P2, 1_000, true, THIRTY_BPS, true).unwrap();
        assert_eq!(r.amount_in, 1_000);
        assert_eq!(r.bin_in, 1_000, "all input enters the bin");
        assert_eq!(r.bin_out, 2_000, "priced on the full input");
        assert_eq!(r.amount_out + r.fee, r.bin_out, "fee taken from the output");
        assert!(r.fee >= 1);
    }

    #[test]
    fn output_side_fee_still_respects_the_bins_inventory() {
        let r = swap_in_bin(0, 200, P2, 1_000_000, true, THIRTY_BPS, true).unwrap();
        assert_eq!(r.bin_out, 200);
        assert_eq!(r.amount_out + r.fee, 200);
        assert_eq!(r.amount_in, 100);
    }

    #[test]
    fn dust_that_buys_nothing_consumes_nothing() {
        // At P=2 swapping Y for X, 1 Y buys 0 X. The trader must keep it.
        let r = swap_in_bin(10_000, 0, P2, 1, false, NO_FEE, false).unwrap();
        assert!(r.is_noop(), "got {r:?}");
        // Same on the fee-on-output path.
        let tiny = ONE_Q64 / 1_000_000;
        let r = swap_in_bin(0, 10_000, tiny, 1, true, THIRTY_BPS, true).unwrap();
        assert!(r.is_noop(), "got {r:?}");
    }

    #[test]
    fn the_bin_never_pays_out_more_than_it_holds() {
        let cases = [
            (0u64, 1u64, ONE_Q64 / 3, u64::MAX, true),
            (1, 0, ONE_Q64 * 3, u64::MAX, false),
            (0, u64::MAX, ONE_Q64, u64::MAX, true),
        ];
        for (x, y, price, amt, for_y) in cases {
            let r = swap_in_bin(x, y, price, amt, for_y, THIRTY_BPS, false).unwrap();
            let held = if for_y { y } else { x };
            assert!(r.bin_out <= held, "{r:?} drained more than {held}");
            assert!(r.amount_out <= r.bin_out);
        }
    }

    #[test]
    fn rounding_never_favours_the_trader() {
        // Sweep awkward prices and amounts; the value the trader receives must
        // never exceed the value they paid in, at the bin's own price.
        for price_num in [1u128, 3, 7, 999] {
            for price_den in [1u128, 3, 7, 1_000] {
                let price = ONE_Q64 * price_num / price_den;
                if price == 0 {
                    continue;
                }
                for amt in [1u64, 2, 13, 1_000, 999_983] {
                    let r =
                        swap_in_bin(u64::MAX / 4, u64::MAX / 4, price, amt, true, NO_FEE, false)
                            .unwrap();
                    if r.is_noop() {
                        continue;
                    }
                    // out_y <= in_x * P
                    let paid_value = mul_div(r.bin_in as u128, price, ONE_Q64).unwrap();
                    assert!(
                        r.bin_out as u128 <= paid_value,
                        "price {price_num}/{price_den} amt {amt}: {r:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_drained_bin_costs_at_least_the_fair_input() {
        // Ceil on the required input means the trader can never drain a bin
        // for less than its contents are worth.
        for price_num in [1u128, 3, 7, 999] {
            for price_den in [1u128, 3, 7, 1_000] {
                let price = ONE_Q64 * price_num / price_den;
                if price == 0 {
                    continue;
                }
                let y = 12_345u64;
                let r = swap_in_bin(0, y, price, u64::MAX, true, NO_FEE, false).unwrap();
                assert_eq!(r.bin_out, y);
                let value_in = mul_div(r.bin_in as u128, price, ONE_Q64).unwrap();
                assert!(value_in >= y as u128, "price {price_num}/{price_den}: {r:?}");
            }
        }
    }
}
