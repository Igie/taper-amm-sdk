//! Bins and the arrays that hold them.
//!
//! Bins are grouped 70 to an account so a pool can grow without a single
//! unbounded account, and so a swap only pays to load the stretch of the
//! ladder it actually crosses.
//!
//! A bin's `price` and `step_bp_x100` are derived purely from its id and the
//! config's ladder, so they are computed **once, lazily, on first touch** and
//! cached. A zero `price` is the "not yet computed" sentinel — no real bin
//! price is ever zero.

use crate::constants::MAX_BIN_PER_ARRAY;
use crate::errors::{CoreError, Result};
use crate::require;
use crate::math::fee::{accrued_fee, fee_growth_delta};
use crate::math::ladder::{bin_array_lower_bin_id, bin_array_upper_bin_id, Ladder};
use crate::math::liquidity::{bin_liquidity, deposit_shares, withdraw_amounts};

#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C, packed)]
pub struct Bin {
    /// LP-owned inventory. Excludes both protocol fees and unclaimed LP fees.
    pub amount_x: u64,
    pub amount_y: u64,
    /// Q64.64 price of this bin. Zero means "not yet derived".
    pub price: u128,
    pub liquidity_supply: u128,
    /// Cumulative fee per liquidity share, Q64.64.
    pub fee_x_per_share: u128,
    pub fee_y_per_share: u128,
    /// This bin's own width, in hundredths of a basis point. Under a taper
    /// this differs from bin to bin, which is why it is stored per bin.
    pub step_bp_x100: u32,
    pub _padding: [u8; 12],
}

impl Bin {
    pub fn is_derived(&self) -> bool {
        self.price != 0
    }

    /// `L = P * x + y`, in Q64.64.
    pub fn liquidity(&self) -> Result<u128> {
        bin_liquidity(self.amount_x, self.amount_y, self.price)
    }

    /// Adds tokens and mints shares against the bin's current liquidity.
    pub fn deposit(&mut self, amount_x: u64, amount_y: u64) -> Result<u128> {
        let incoming = bin_liquidity(amount_x, amount_y, self.price)?;
        let minted = deposit_shares(incoming, self.liquidity()?, self.liquidity_supply)?;

        self.amount_x = self
            .amount_x
            .checked_add(amount_x)
            .ok_or_else(|| CoreError::MathOverflow)?;
        self.amount_y = self
            .amount_y
            .checked_add(amount_y)
            .ok_or_else(|| CoreError::MathOverflow)?;
        self.liquidity_supply = self
            .liquidity_supply
            .checked_add(minted)
            .ok_or_else(|| CoreError::MathOverflow)?;
        Ok(minted)
    }

    /// Burns shares and returns the pro-rata token mix.
    pub fn withdraw(&mut self, share: u128) -> Result<(u64, u64)> {
        let (out_x, out_y) =
            withdraw_amounts(share, self.liquidity_supply, self.amount_x, self.amount_y)?;
        self.amount_x -= out_x;
        self.amount_y -= out_y;
        self.liquidity_supply -= share;
        Ok((out_x, out_y))
    }

    /// Books an LP fee as per-share growth. Dust that cannot be divided among
    /// the current shares stays in the reserve rather than being lost.
    pub fn accrue_lp_fee(&mut self, lp_fee_x: u64, lp_fee_y: u64) -> Result<()> {
        if lp_fee_x > 0 {
            let delta = fee_growth_delta(lp_fee_x, self.liquidity_supply)?;
            self.fee_x_per_share = self
                .fee_x_per_share
                .checked_add(delta)
                .ok_or_else(|| CoreError::MathOverflow)?;
        }
        if lp_fee_y > 0 {
            let delta = fee_growth_delta(lp_fee_y, self.liquidity_supply)?;
            self.fee_y_per_share = self
                .fee_y_per_share
                .checked_add(delta)
                .ok_or_else(|| CoreError::MathOverflow)?;
        }
        Ok(())
    }

    /// Fees owed to `share` since the given checkpoints.
    pub fn fees_owed(&self, share: u128, checkpoint_x: u128, checkpoint_y: u128) -> Result<(u64, u64)> {
        let dx = self.fee_x_per_share.saturating_sub(checkpoint_x);
        let dy = self.fee_y_per_share.saturating_sub(checkpoint_y);
        Ok((accrued_fee(share, dx)?, accrued_fee(share, dy)?))
    }

    pub fn is_empty(&self) -> bool {
        self.liquidity_supply == 0 && self.amount_x == 0 && self.amount_y == 0
    }
}

#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C, packed)]
pub struct BinArray {
    pub pool: [u8; 32],
    pub index: i64,
    pub _reserved: [u8; 24],
    pub bins: [Bin; MAX_BIN_PER_ARRAY],
}

impl BinArray {
    pub const LEN: usize = 8 + core::mem::size_of::<BinArray>();

    pub fn lower_bin_id(&self) -> i32 {
        bin_array_lower_bin_id(self.index as i32)
    }

    pub fn upper_bin_id(&self) -> i32 {
        bin_array_upper_bin_id(self.index as i32)
    }

    pub fn contains(&self, bin_id: i32) -> bool {
        bin_id >= self.lower_bin_id() && bin_id <= self.upper_bin_id()
    }

    fn slot(&self, bin_id: i32) -> Result<usize> {
        require!(self.contains(bin_id), CoreError::InvalidBinArrayIndex);
        Ok((bin_id - self.lower_bin_id()) as usize)
    }

    pub fn bin(&self, bin_id: i32) -> Result<&Bin> {
        Ok(&self.bins[self.slot(bin_id)?])
    }

    /// Mutable access, deriving the bin's price and width on first touch.
    pub fn bin_mut(&mut self, bin_id: i32, ladder: &Ladder) -> Result<&mut Bin> {
        let slot = self.slot(bin_id)?;
        let bin = &mut self.bins[slot];
        if !bin.is_derived() {
            // One `derive` rather than a separate price and width: they share
            // the binary exponentiation, which dominates the cost.
            let (price, step) = ladder.derive(bin_id)?;
            bin.price = price;
            bin.step_bp_x100 = step;
        }
        Ok(bin)
    }

    /// True when no bin in the array holds anything.
    pub fn is_empty(&self) -> bool {
        self.bins.iter().all(|b| b.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::ONE_Q64;
    use crate::math::fixed::f64_to_q64;
    use bytemuck::Zeroable;

    const P2: u128 = 2 * ONE_Q64;

    fn bin(amount_x: u64, amount_y: u64) -> Bin {
        let mut b = Bin::zeroed();
        b.price = P2;
        b.amount_x = amount_x;
        b.amount_y = amount_y;
        b.liquidity_supply = bin_liquidity(amount_x, amount_y, P2).unwrap();
        b
    }

    fn ladder() -> Ladder {
        Ladder {
            base_width_q64: f64_to_q64((1.0f64 + 10.0 / 10_000.0).log2()),
            taper_q64: f64_to_q64(2f64.powf(-1.0 / 20_000.0)),
        }
    }

    fn empty_array(index: i64) -> BinArray {
        let mut a = BinArray::zeroed();
        a.index = index;
        a
    }

    #[test]
    fn deposit_then_withdraw_returns_the_stake() {
        let mut b = bin(1_000, 1_000);
        let minted = b.deposit(500, 500).unwrap();
        let (x, y) = b.withdraw(minted).unwrap();
        assert_eq!((x, y), (500, 500));
        let (supply, ax, ay) = (b.liquidity_supply, b.amount_x, b.amount_y);
        assert_eq!(ax, 1_000);
        assert_eq!(ay, 1_000);
        assert_eq!(supply, bin_liquidity(1_000, 1_000, P2).unwrap());
    }

    #[test]
    fn first_deposit_into_an_empty_bin_sets_the_rate() {
        let mut b = Bin::zeroed();
        b.price = P2;
        let minted = b.deposit(100, 0).unwrap();
        let supply = b.liquidity_supply;
        assert_eq!(minted, 200 * ONE_Q64);
        assert_eq!(supply, minted);
    }

    #[test]
    fn withdrawing_the_whole_supply_empties_the_bin() {
        let mut b = bin(1_000, 2_000);
        let supply = b.liquidity_supply;
        let (x, y) = b.withdraw(supply).unwrap();
        assert_eq!((x, y), (1_000, 2_000));
        assert!(b.is_empty());
    }

    #[test]
    fn fee_growth_is_claimable_by_the_holder() {
        let mut b = bin(1_000, 1_000);
        let supply = b.liquidity_supply;
        b.accrue_lp_fee(1_000, 500).unwrap();
        let (fx, fy) = b.fees_owed(supply, 0, 0).unwrap();
        assert!(fx <= 1_000 && fx >= 999, "got {fx}");
        assert!(fy <= 500 && fy >= 499, "got {fy}");
    }

    #[test]
    fn fee_growth_before_a_checkpoint_is_not_claimable() {
        let mut b = bin(1_000, 1_000);
        b.accrue_lp_fee(1_000, 0).unwrap();
        let checkpoint = b.fee_x_per_share;
        let supply = b.liquidity_supply;
        // Joining at the current checkpoint earns nothing retroactively.
        let (fx, _) = b.fees_owed(supply, checkpoint, 0).unwrap();
        assert_eq!(fx, 0);
    }

    #[test]
    fn fees_on_an_empty_bin_do_not_explode() {
        let mut b = Bin::zeroed();
        b.price = P2;
        b.accrue_lp_fee(1_000, 1_000).unwrap();
        let growth = b.fee_x_per_share;
        assert_eq!(growth, 0, "nothing to divide the fee among");
    }

    #[test]
    fn bin_array_maps_ids_to_slots() {
        let a = empty_array(0);
        assert_eq!(a.lower_bin_id(), 0);
        assert_eq!(a.upper_bin_id(), 69);
        assert!(a.contains(0) && a.contains(69));
        assert!(!a.contains(70) && !a.contains(-1));

        let neg = empty_array(-1);
        assert_eq!(neg.lower_bin_id(), -70);
        assert_eq!(neg.upper_bin_id(), -1);
        assert!(neg.contains(-70) && neg.contains(-1));
    }

    #[test]
    fn out_of_range_bin_ids_are_rejected() {
        let mut a = empty_array(0);
        assert!(a.bin(70).is_err());
        assert!(a.bin(-1).is_err());
        assert!(a.bin_mut(70, &ladder()).is_err());
    }

    #[test]
    fn price_is_derived_once_and_then_cached() {
        let l = ladder();
        let mut a = empty_array(0);
        let expected = l.price(5).unwrap();

        let b = a.bin_mut(5, &l).unwrap();
        let (price, step) = (b.price, b.step_bp_x100);
        assert_eq!(price, expected);
        assert!(step > 0);

        // Poison the ladder; a derived bin must not be recomputed.
        let other = Ladder {
            base_width_q64: l.base_width_q64 * 2,
            taper_q64: l.taper_q64,
        };
        let b = a.bin_mut(5, &other).unwrap();
        let price_again = b.price;
        assert_eq!(price_again, expected, "cached price was recomputed");
    }

    #[test]
    fn neighbouring_bins_derive_different_prices_and_widths() {
        let l = ladder();
        let mut a = empty_array(0);
        let lo = { let b = a.bin_mut(10, &l).unwrap(); (b.price, b.step_bp_x100) };
        let hi = { let b = a.bin_mut(11, &l).unwrap(); (b.price, b.step_bp_x100) };
        assert!(hi.0 > lo.0, "price must rise with bin id");
        assert!(hi.1 <= lo.1, "width must not grow with bin id under a taper");
    }

    #[test]
    fn emptiness_tracks_the_bins() {
        let l = ladder();
        let mut a = empty_array(0);
        assert!(a.is_empty());
        a.bin_mut(3, &l).unwrap().deposit(100, 0).unwrap();
        assert!(!a.is_empty());
        let supply = a.bin(3).unwrap().liquidity_supply;
        a.bin_mut(3, &l).unwrap().withdraw(supply).unwrap();
        assert!(a.is_empty());
    }
}
