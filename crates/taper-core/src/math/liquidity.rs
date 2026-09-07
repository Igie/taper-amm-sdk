//! Bin liquidity and share accounting.
//!
//! A bin is constant-*sum*: `L = P * x + y`, held in Q64.64. Shares are the
//! usual pro-rata claim on that `L`, minted against the bin's existing supply
//! and burned back into whatever mix of X and Y the bin currently holds.
//!
//! Every rounding decision here is made against the depositor and in favour of
//! the bin: shares round down on the way in, amounts round down on the way
//! out. That guarantees a deposit-then-withdraw round trip can never extract
//! more than it put in.

use crate::constants::ONE_Q64;
use crate::errors::{CoreError, Result};
use crate::require;
use crate::math::u256::{mul_div, U256};

/// `L = P * x + y`, in Q64.64.
pub fn bin_liquidity(amount_x: u64, amount_y: u64, price_q64: u128) -> Result<u128> {
    U256::mul(price_q64, amount_x as u128)
        .checked_add(U256::mul(amount_y as u128, ONE_Q64))?
        .to_u128()
}

/// Shares minted for a deposit contributing `liquidity_in` to a bin that
/// currently holds `bin_liquidity` against `supply` shares.
pub fn deposit_shares(liquidity_in: u128, bin_liquidity: u128, supply: u128) -> Result<u128> {
    if supply == 0 || bin_liquidity == 0 {
        // First deposit sets the exchange rate at 1:1 with liquidity.
        return Ok(liquidity_in);
    }
    if supply == bin_liquidity {
        // Exactly the same answer as the division below, without paying for
        // it. Shares are minted 1:1 with liquidity and only drift once a fee
        // or a swap moves the bin, so this is the common case — and the
        // division it skips is a full 256-bit one, since two Q64.64
        // liquidity values overflow `u128` when multiplied.
        return Ok(liquidity_in);
    }
    mul_div(liquidity_in, supply, bin_liquidity)
}

/// Tokens returned for burning `share` of `supply`, pro rata across whatever
/// the bin holds.
pub fn withdraw_amounts(
    share: u128,
    supply: u128,
    amount_x: u64,
    amount_y: u64,
) -> Result<(u64, u64)> {
    if share == 0 || supply == 0 {
        return Ok((0, 0));
    }
    require!(share <= supply, CoreError::MathOverflow);
    let out_x = mul_div(share, amount_x as u128, supply)?;
    let out_y = mul_div(share, amount_y as u128, supply)?;
    Ok((
        u64::try_from(out_x).map_err(|_| CoreError::MathOverflow)?,
        u64::try_from(out_y).map_err(|_| CoreError::MathOverflow)?,
    ))
}

/// How much of a deposit sits *outside* the bin's current X/Y ratio.
///
/// The excess is the part that behaves like a swap against the bin, and is
/// what the composition fee is charged on. An empty bin has no ratio to
/// violate, so nothing is in excess.
pub fn composition_excess(
    deposit_x: u64,
    deposit_y: u64,
    bin_x: u64,
    bin_y: u64,
    supply: u128,
    minted: u128,
) -> Result<(u64, u64)> {
    if supply == 0 || minted == 0 {
        return Ok((0, 0));
    }
    let owed_x = u64::try_from(mul_div(minted, bin_x as u128, supply)?)
        .map_err(|_| CoreError::MathOverflow)?;
    let owed_y = u64::try_from(mul_div(minted, bin_y as u128, supply)?)
        .map_err(|_| CoreError::MathOverflow)?;
    Ok((
        deposit_x.saturating_sub(owed_x),
        deposit_y.saturating_sub(owed_y),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const P2: u128 = 2 * ONE_Q64;

    #[test]
    fn liquidity_is_constant_sum() {
        // 100 X at price 2 plus 50 Y == 250, in Q64.64.
        assert_eq!(bin_liquidity(100, 50, P2).unwrap(), 250 * ONE_Q64);
        assert_eq!(bin_liquidity(0, 0, P2).unwrap(), 0);
        assert_eq!(bin_liquidity(0, 7, P2).unwrap(), 7 * ONE_Q64);
    }

    #[test]
    fn liquidity_overflow_is_caught_not_wrapped() {
        assert!(bin_liquidity(u64::MAX, u64::MAX, u128::MAX).is_err());
    }

    #[test]
    fn first_deposit_mints_liquidity_one_for_one() {
        let l = bin_liquidity(100, 50, P2).unwrap();
        assert_eq!(deposit_shares(l, 0, 0).unwrap(), l);
        assert_eq!(deposit_shares(l, 0, 12345).unwrap(), l);
    }

    #[test]
    fn second_deposit_mints_pro_rata() {
        let bin = bin_liquidity(100, 0, P2).unwrap(); // 200
        let supply = bin;
        let incoming = bin_liquidity(50, 0, P2).unwrap(); // 100
        assert_eq!(deposit_shares(incoming, bin, supply).unwrap(), incoming);
        // Half the shares outstanding for half the liquidity.
        assert_eq!(deposit_shares(bin / 2, bin, supply).unwrap(), supply / 2);
    }

    #[test]
    fn withdrawing_everything_returns_everything() {
        let (x, y) = (1_000u64, 2_000u64);
        let l = bin_liquidity(x, y, P2).unwrap();
        assert_eq!(withdraw_amounts(l, l, x, y).unwrap(), (x, y));
    }

    #[test]
    fn withdrawing_nothing_returns_nothing() {
        assert_eq!(withdraw_amounts(0, 100, 5, 5).unwrap(), (0, 0));
        assert_eq!(withdraw_amounts(10, 0, 5, 5).unwrap(), (0, 0));
    }

    #[test]
    fn withdrawing_more_than_the_supply_is_rejected() {
        assert!(withdraw_amounts(101, 100, 5, 5).is_err());
    }

    #[test]
    fn round_trip_never_extracts_more_value_than_it_deposited() {
        // The invariant that matters: deposit into a populated bin, withdraw
        // the shares straight back, and come out no better off *by value*.
        // The token mix legitimately changes — that is the free swap the
        // composition fee exists to price — so only value is asserted here.
        let cases = [
            (1_000u64, 0u64, 7_777u64, 3_333u64),
            (0, 1_000, 7_777, 3_333),
            (13, 17, 1, 1),
            (999_983, 999_979, 12_345_678, 87_654_321),
        ];
        for (dx, dy, bx, by) in cases {
            for price in [ONE_Q64 / 3, ONE_Q64, P2, ONE_Q64 * 997] {
                let bin = bin_liquidity(bx, by, price).unwrap();
                let supply = bin;
                let incoming = bin_liquidity(dx, dy, price).unwrap();
                let minted = deposit_shares(incoming, bin, supply).unwrap();

                let (out_x, out_y) =
                    withdraw_amounts(minted, supply + minted, bx + dx, by + dy).unwrap();
                let value_in = incoming;
                let value_out = bin_liquidity(out_x, out_y, price).unwrap();
                assert!(
                    value_out <= value_in,
                    "deposit ({dx},{dy}) into ({bx},{by}) at {price}: \
                     extracted {value_out} from {value_in}"
                );
                // And the shortfall is only rounding dust: at most one whole
                // unit of each token, floored out of the two withdrawals.
                let dust = price + ONE_Q64;
                assert!(
                    value_in - value_out <= dust,
                    "deposit ({dx},{dy}) into ({bx},{by}) at {price}: \
                     lost {} which exceeds dust {dust}",
                    value_in - value_out
                );
            }
        }
    }

    #[test]
    fn a_one_sided_round_trip_silently_performs_a_swap() {
        // Deposit pure X into a mixed bin, withdraw the shares straight back,
        // and some of that X has become Y at the bin price without paying a
        // swap fee. This is exactly the hole `composition_excess` plugs.
        let (bx, by) = (7_777u64, 3_333u64);
        let price = ONE_Q64 / 3;
        let bin = bin_liquidity(bx, by, price).unwrap();
        let minted = deposit_shares(bin_liquidity(1_000, 0, price).unwrap(), bin, bin).unwrap();
        let (out_x, out_y) = withdraw_amounts(minted, bin + minted, bx + 1_000, by).unwrap();
        assert!(out_x < 1_000, "kept all the X: {out_x}");
        assert!(out_y > 0, "no X was converted to Y");
    }

    #[test]
    fn a_balanced_deposit_has_no_composition_excess() {
        // Depositing in the bin's exact ratio is not a disguised swap.
        let (bx, by) = (1_000u64, 2_000u64);
        let bin = bin_liquidity(bx, by, P2).unwrap();
        let supply = bin;
        let (dx, dy) = (100u64, 200u64); // same 1:2 ratio
        let incoming = bin_liquidity(dx, dy, P2).unwrap();
        let minted = deposit_shares(incoming, bin, supply).unwrap();
        let (ex, ey) = composition_excess(dx, dy, bx, by, supply, minted).unwrap();
        assert_eq!((ex, ey), (0, 0), "balanced deposit flagged as lopsided");
    }

    #[test]
    fn a_one_sided_deposit_is_almost_entirely_excess() {
        let (bx, by) = (1_000u64, 2_000u64);
        let bin = bin_liquidity(bx, by, P2).unwrap();
        let supply = bin;
        let (dx, dy) = (0u64, 1_000u64); // pure Y into a mixed bin
        let incoming = bin_liquidity(dx, dy, P2).unwrap();
        let minted = deposit_shares(incoming, bin, supply).unwrap();
        let (ex, ey) = composition_excess(dx, dy, bx, by, supply, minted).unwrap();
        assert_eq!(ex, 0, "deposited no X, so no X can be in excess");
        // The bin is half Y by value, so half the deposit is a disguised swap.
        assert_eq!(ey, 500, "expected half the Y to be excess");
    }

    #[test]
    fn an_empty_bin_has_no_composition_excess() {
        let incoming = bin_liquidity(500, 0, P2).unwrap();
        let minted = deposit_shares(incoming, 0, 0).unwrap();
        assert_eq!(
            composition_excess(500, 0, 0, 0, 0, minted).unwrap(),
            (0, 0)
        );
    }
}
