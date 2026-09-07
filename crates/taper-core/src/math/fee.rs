//! Fee schedule.
//!
//! The shape is DLMM's — a base fee proportional to the bin's width plus a
//! variable fee driven by a volatility accumulator — with one adaptation
//! forced by the taper: **bin width is no longer a pool-wide constant**, so
//! both components key off *the bin being crossed* rather than off a single
//! `bin_step`.
//!
//! That falls straight out of DLMM's own rationale ("larger bin step ⇒ larger
//! base fee, by design: each bin is a bigger price move"). Under a taper the
//! same trade is charged more down where bins are wide and volatile, and less
//! up where they are tight. It also keeps the variable fee honest:
//! `volatility_accumulator` counts *bins crossed*, and multiplying by the
//! local `step_bp_x100` is what converts that count back into a price move.
//!
//! Substituting `step_bp_x100 = bin_step * 100` into any formula here
//! recovers the DLMM original exactly.

use crate::constants::{BASIS_POINT_MAX, FEE_PRECISION, MAX_FEE_RATE};
use crate::errors::{CoreError, Result};
use crate::require;
use crate::math::u256::{mul_div, mul_div_ceil, U256};

/// Denominator for the squared-volatility term. DLMM divides
/// `(va * bin_step)^2` by 1e11; expressing the step in hundredths of a bp
/// multiplies the square by 1e4, so the denominator grows to 1e15.
const VARIABLE_FEE_DENOMINATOR: u128 = 1_000_000_000_000_000;

/// `base_factor * step_bp_x100 * 10^power / 10`, against [`FEE_PRECISION`].
pub fn base_fee_rate(base_factor: u16, base_fee_power_factor: u8, step_bp_x100: u32) -> Result<u128> {
    let power = 10u128
        .checked_pow(base_fee_power_factor as u32)
        .ok_or_else(|| CoreError::InvalidFeeParameters)?;
    (base_factor as u128)
        .checked_mul(step_bp_x100 as u128)
        .and_then(|v| v.checked_mul(power))
        .map(|v| v / 10)
        .ok_or_else(|| CoreError::InvalidFeeParameters)
}

/// `ceil(variable_fee_control * (va * step_bp_x100)^2 / 1e15)`.
pub fn variable_fee_rate(
    variable_fee_control: u32,
    volatility_accumulator: u32,
    step_bp_x100: u32,
) -> Result<u128> {
    if variable_fee_control == 0 {
        return Ok(0);
    }
    let x = (volatility_accumulator as u128)
        .checked_mul(step_bp_x100 as u128)
        .ok_or_else(|| CoreError::MathOverflow)?;
    let squared = x.checked_mul(x).ok_or_else(|| CoreError::MathOverflow)?;
    U256::mul(squared, variable_fee_control as u128).div_u128_ceil(VARIABLE_FEE_DENOMINATOR)
}

/// Base plus variable, capped at [`MAX_FEE_RATE`] (10%).
pub fn total_fee_rate(base: u128, variable: u128) -> u128 {
    base.saturating_add(variable).min(MAX_FEE_RATE)
}

/// Fee carved *out of* an amount that already includes it.
pub fn fee_from_amount(amount: u64, fee_rate: u128) -> Result<u64> {
    let fee = mul_div_ceil(amount as u128, fee_rate, FEE_PRECISION)?;
    u64::try_from(fee).map_err(|_| CoreError::MathOverflow)
}

/// Fee added *on top of* an amount that excludes it.
pub fn fee_on_amount(amount: u64, fee_rate: u128) -> Result<u64> {
    require!(fee_rate < FEE_PRECISION, CoreError::InvalidFeeParameters);
    let fee = mul_div_ceil(amount as u128, fee_rate, FEE_PRECISION - fee_rate)?;
    u64::try_from(fee).map_err(|_| CoreError::MathOverflow)
}

/// Fee charged when a deposit into the active bin shifts its composition —
/// the deposit is doing the work of a swap, so it pays a swap's fee.
///
/// `ceil(amount * rate * (1e9 + rate) / 1e18)`
pub fn composition_fee(amount: u64, fee_rate: u128) -> Result<u64> {
    if amount == 0 || fee_rate == 0 {
        return Ok(0);
    }
    let scaled = (amount as u128)
        .checked_mul(fee_rate)
        .ok_or_else(|| CoreError::MathOverflow)?;
    let fee = mul_div_ceil(scaled, FEE_PRECISION + fee_rate, FEE_PRECISION * FEE_PRECISION)?;
    u64::try_from(fee).map_err(|_| CoreError::MathOverflow)
}

/// Splits a trading fee into the protocol's cut and the LPs' remainder.
pub fn split_protocol_fee(fee: u64, protocol_share: u16) -> Result<(u64, u64)> {
    let protocol = mul_div(fee as u128, protocol_share as u128, BASIS_POINT_MAX)?;
    let protocol = u64::try_from(protocol).map_err(|_| CoreError::MathOverflow)?;
    Ok((protocol, fee - protocol))
}

/// Per-share fee growth contributed by `lp_fee`.
///
/// The numerator is scaled by **2^128**, not 2^64. Liquidity shares are
/// themselves Q64.64 quantities, so a 2^64 numerator would leave the quotient
/// with no fractional bits at all: a 1000-lamport fee against a 3000-unit bin
/// would floor to zero growth and the fee would silently vanish. At 2^128 the
/// quotient keeps a full 64 fractional bits, and [`accrued_fee`] shifts the
/// matching 128 back out.
///
/// Rounds down, so the bin retains a sub-share dust remainder rather than
/// promising LPs more than it holds.
pub fn fee_growth_delta(lp_fee: u64, liquidity_supply: u128) -> Result<u128> {
    if lp_fee == 0 || liquidity_supply == 0 {
        return Ok(0);
    }
    // lp_fee << 128, exactly.
    U256 {
        hi: lp_fee as u128,
        lo: 0,
    }
    .div_u128(liquidity_supply)
}

/// Fee owed to a holder of `share` for a `growth_delta` of per-share growth.
pub fn accrued_fee(share: u128, growth_delta: u128) -> Result<u64> {
    if share == 0 || growth_delta == 0 {
        return Ok(0);
    }
    let owed = U256::mul(share, growth_delta).shr(128).to_u128()?;
    u64::try_from(owed).map_err(|_| CoreError::MathOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The DLMM originals, for equivalence checks.
    fn dlmm_base_fee(base_factor: u16, bin_step: u32, power: u8) -> u128 {
        base_factor as u128 * bin_step as u128 * 10 * 10u128.pow(power as u32)
    }
    fn dlmm_variable_fee(vfc: u32, va: u32, bin_step: u32) -> u128 {
        let x = va as u128 * bin_step as u128;
        (x * x * vfc as u128).div_ceil(100_000_000_000)
    }

    #[test]
    fn base_fee_matches_dlmm_for_a_uniform_ladder() {
        for bin_step in [1u32, 10, 25, 100, 400] {
            for base_factor in [1u16, 5_000, 10_000] {
                for power in [0u8, 1] {
                    assert_eq!(
                        base_fee_rate(base_factor, power, bin_step * 100).unwrap(),
                        dlmm_base_fee(base_factor, bin_step, power),
                        "bin_step={bin_step} base_factor={base_factor} power={power}"
                    );
                }
            }
        }
    }

    #[test]
    fn base_fee_of_ten_bps_is_ten_bps() {
        // base_factor 10_000 over a 10 bps bin: 0.1% == 1e6 / 1e9.
        assert_eq!(base_fee_rate(10_000, 0, 1_000).unwrap(), 1_000_000);
    }

    #[test]
    fn variable_fee_matches_dlmm_for_a_uniform_ladder() {
        for bin_step in [1u32, 10, 100, 400] {
            for va in [0u32, 10_000, 350_000] {
                for vfc in [0u32, 40_000, 2_000_000] {
                    assert_eq!(
                        variable_fee_rate(vfc, va, bin_step * 100).unwrap(),
                        dlmm_variable_fee(vfc, va, bin_step),
                        "bin_step={bin_step} va={va} vfc={vfc}"
                    );
                }
            }
        }
    }

    #[test]
    fn variable_fee_is_disabled_by_a_zero_control() {
        assert_eq!(variable_fee_rate(0, 350_000, 40_000).unwrap(), 0);
    }

    #[test]
    fn wider_bins_charge_more_at_equal_volatility() {
        // The taper's fee consequence: same bins crossed, wider bins, more fee.
        let narrow = variable_fee_rate(40_000, 100_000, 500).unwrap();
        let wide = variable_fee_rate(40_000, 100_000, 2_000).unwrap();
        assert_eq!(wide, narrow * 16, "quadratic in the step");
        assert!(base_fee_rate(10_000, 0, 2_000).unwrap() > base_fee_rate(10_000, 0, 500).unwrap());
    }

    #[test]
    fn total_fee_is_capped_at_ten_percent() {
        assert_eq!(total_fee_rate(MAX_FEE_RATE, MAX_FEE_RATE), MAX_FEE_RATE);
        assert_eq!(total_fee_rate(1_000_000, 500_000), 1_500_000);
        assert_eq!(total_fee_rate(u128::MAX, u128::MAX), MAX_FEE_RATE);
    }

    #[test]
    fn the_two_fee_directions_are_consistent() {
        // Charging on top of a net amount, then carving the fee back out of
        // the gross, must land on the same fee.
        let rate = 3_000_000u128; // 0.3%
        for net in [1_000u64, 1_000_000, 10_000_000_000] {
            let added = fee_on_amount(net, rate).unwrap();
            let gross = net + added;
            let carved = fee_from_amount(gross, rate).unwrap();
            assert!(
                carved.abs_diff(added) <= 1,
                "net={net}: added {added}, carved {carved}"
            );
        }
    }

    #[test]
    fn fees_round_up_in_the_pools_favour() {
        // Any non-zero amount at a non-zero rate must yield at least 1.
        assert_eq!(fee_from_amount(1, 1).unwrap(), 1);
        assert_eq!(fee_on_amount(1, 1).unwrap(), 1);
        assert_eq!(fee_from_amount(0, 5_000_000).unwrap(), 0);
    }

    #[test]
    fn protocol_split_never_exceeds_the_fee() {
        for fee in [0u64, 1, 7, 1_000_000] {
            for share in [0u16, 1_000, 2_500] {
                let (protocol, lp) = split_protocol_fee(fee, share).unwrap();
                assert_eq!(protocol + lp, fee, "fee={fee} share={share}");
                assert!(protocol <= fee);
            }
        }
    }

    #[test]
    fn fee_growth_round_trips_through_a_single_lp() {
        // A sole LP holding every share should be able to claim back
        // essentially the whole LP fee.
        let supply = 12_345_678_901_234u128;
        let lp_fee = 1_000_000u64;
        let delta = fee_growth_delta(lp_fee, supply).unwrap();
        let owed = accrued_fee(supply, delta).unwrap();
        assert!(owed <= lp_fee, "must never over-promise");
        assert!(lp_fee - owed <= 1, "lost {} to rounding", lp_fee - owed);
    }

    #[test]
    fn fee_growth_splits_pro_rata_without_over_promising() {
        let supply = 1_000_000u128;
        let lp_fee = 999u64;
        let delta = fee_growth_delta(lp_fee, supply).unwrap();
        let a = accrued_fee(supply / 4, delta).unwrap();
        let b = accrued_fee(supply / 4 * 3, delta).unwrap();
        assert!(a + b <= lp_fee, "{a} + {b} exceeds {lp_fee}");
    }

    #[test]
    fn fee_growth_survives_a_realistically_scaled_supply() {
        // Regression: liquidity shares are Q64.64, so a 2^64 numerator left
        // the quotient with no fractional bits and small fees floored to zero.
        // Bin holding 1000 X + 1000 Y at price 2.0 => supply of 3000 << 64.
        let supply = 3_000u128 << 64;
        for lp_fee in [1u64, 7, 1_000, 1_000_000] {
            let delta = fee_growth_delta(lp_fee, supply).unwrap();
            assert!(delta > 0, "fee of {lp_fee} produced no growth");
            let owed = accrued_fee(supply, delta).unwrap();
            assert!(owed <= lp_fee);
            assert!(
                lp_fee - owed <= 1,
                "fee of {lp_fee} paid back only {owed}"
            );
        }
    }

    #[test]
    fn fee_growth_is_zero_for_an_empty_bin() {
        assert_eq!(fee_growth_delta(100, 0).unwrap(), 0);
        assert_eq!(accrued_fee(0, 12345).unwrap(), 0);
    }

    #[test]
    fn composition_fee_exceeds_a_plain_swap_fee() {
        // It must not be cheaper to "swap" by depositing lopsidedly.
        let rate = 5_000_000u128; // 0.5%
        let amount = 1_000_000_000u64;
        let comp = composition_fee(amount, rate).unwrap();
        let plain = fee_from_amount(amount, rate).unwrap();
        assert!(comp >= plain, "composition {comp} < swap {plain}");
        assert_eq!(composition_fee(0, rate).unwrap(), 0);
        assert_eq!(composition_fee(amount, 0).unwrap(), 0);
    }
}
