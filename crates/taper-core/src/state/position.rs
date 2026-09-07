//! LP positions.
//!
//! A position is a contiguous band of at most [`MAX_BIN_PER_POSITION`] bins
//! plus, per bin, a liquidity share and a fee checkpoint. Ownership is the
//! account itself — no LP token, no NFT — so a position is addressed by a PDA
//! over `(pool, owner, lower_bin_id, width)`.
//!
//! The consequence that drives every LP decision is the same as DLMM's: a
//! position only earns while the active bin sits inside its range.

use crate::constants::{BASIS_POINT_MAX, MAX_BIN_PER_POSITION};
use crate::errors::{CoreError, Result};
use crate::require;
use crate::math::u256::mul_div;
use crate::state::bin_array::Bin;

#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C, packed)]
pub struct PositionBinFee {
    /// Last per-share fee growth this position has been credited for.
    pub fee_x_per_share_checkpoint: u128,
    pub fee_y_per_share_checkpoint: u128,
    /// Accrued but unclaimed.
    pub fee_x_pending: u64,
    pub fee_y_pending: u64,
}

#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C, packed)]
pub struct Position {
    pub pool: [u8; 32],
    pub owner: [u8; 32],
    pub liquidity_shares: [u128; MAX_BIN_PER_POSITION],
    pub fee_infos: [PositionBinFee; MAX_BIN_PER_POSITION],
    pub last_updated_at: i64,
    pub total_claimed_fee_x: u64,
    pub total_claimed_fee_y: u64,
    pub lower_bin_id: i32,
    pub upper_bin_id: i32,
    pub bump: u8,
    pub _reserved: [u8; 31],
}

impl Position {
    pub const LEN: usize = 8 + core::mem::size_of::<Position>();

    pub fn width(&self) -> usize {
        (self.upper_bin_id - self.lower_bin_id + 1) as usize
    }

    pub fn contains(&self, bin_id: i32) -> bool {
        bin_id >= self.lower_bin_id && bin_id <= self.upper_bin_id
    }

    /// Slot for a bin id within this position's arrays.
    pub fn slot(&self, bin_id: i32) -> Result<usize> {
        require!(self.contains(bin_id), CoreError::BinIdOutsidePosition);
        Ok((bin_id - self.lower_bin_id) as usize)
    }

    /// Shares held in a slot.
    ///
    /// `liquidity_shares` is a `[u128; _]` inside a packed struct, so it can
    /// only be read by index — a reference to it would be unaligned. This
    /// accessor keeps that constraint in one place.
    pub fn share_at(&self, slot: usize) -> u128 {
        self.liquidity_shares[slot]
    }

    /// Shares held in a bin.
    pub fn share_of(&self, bin_id: i32) -> Result<u128> {
        Ok(self.liquidity_shares[self.slot(bin_id)?])
    }

    /// Moves any fee growth accrued since the last checkpoint into `pending`,
    /// then re-anchors the checkpoint.
    ///
    /// Must run before a bin's share balance changes, otherwise the new
    /// balance would be credited with growth it was not present for.
    pub fn sync_fees(&mut self, bin_id: i32, bin: &Bin) -> Result<()> {
        let slot = self.slot(bin_id)?;
        let share = self.liquidity_shares[slot];
        let info = &mut self.fee_infos[slot];

        let (owed_x, owed_y) = bin.fees_owed(
            share,
            info.fee_x_per_share_checkpoint,
            info.fee_y_per_share_checkpoint,
        )?;

        info.fee_x_pending = info
            .fee_x_pending
            .checked_add(owed_x)
            .ok_or_else(|| CoreError::MathOverflow)?;
        info.fee_y_pending = info
            .fee_y_pending
            .checked_add(owed_y)
            .ok_or_else(|| CoreError::MathOverflow)?;
        info.fee_x_per_share_checkpoint = bin.fee_x_per_share;
        info.fee_y_per_share_checkpoint = bin.fee_y_per_share;
        Ok(())
    }

    pub fn add_shares(&mut self, bin_id: i32, shares: u128) -> Result<()> {
        let slot = self.slot(bin_id)?;
        self.liquidity_shares[slot] = self.liquidity_shares[slot]
            .checked_add(shares)
            .ok_or_else(|| CoreError::MathOverflow)?;
        Ok(())
    }

    pub fn remove_shares(&mut self, bin_id: i32, shares: u128) -> Result<()> {
        let slot = self.slot(bin_id)?;
        require!(
            self.liquidity_shares[slot] >= shares,
            CoreError::InsufficientLiquidity
        );
        self.liquidity_shares[slot] -= shares;
        Ok(())
    }

    /// Shares to burn for a bps fraction of a bin's holding.
    ///
    /// Goes through the 256-bit `mul_div` rather than multiplying in `u128`:
    /// a share is a Q64.64 liquidity value, so a bin holding a few million
    /// whole tokens already puts `share * 10_000` past `u128::MAX` and the
    /// narrow product would abort the withdrawal outright.
    pub fn shares_for_bps(&self, bin_id: i32, bps: u16) -> Result<u128> {
        require!(bps as u128 <= BASIS_POINT_MAX, CoreError::InvalidDistribution);
        let slot = self.slot(bin_id)?;
        let share = self.liquidity_shares[slot];
        if bps as u128 == BASIS_POINT_MAX {
            // Exact, and it keeps a full withdrawal free of rounding.
            return Ok(share);
        }
        mul_div(share, bps as u128, BASIS_POINT_MAX)
    }

    /// Drains and reports all pending fees.
    pub fn take_pending_fees(&mut self) -> Result<(u64, u64)> {
        let (mut total_x, mut total_y) = (0u64, 0u64);
        for info in self.fee_infos.iter_mut() {
            total_x = total_x
                .checked_add(info.fee_x_pending)
                .ok_or_else(|| CoreError::MathOverflow)?;
            total_y = total_y
                .checked_add(info.fee_y_pending)
                .ok_or_else(|| CoreError::MathOverflow)?;
            info.fee_x_pending = 0;
            info.fee_y_pending = 0;
        }
        self.total_claimed_fee_x = self.total_claimed_fee_x.saturating_add(total_x);
        self.total_claimed_fee_y = self.total_claimed_fee_y.saturating_add(total_y);
        Ok((total_x, total_y))
    }

    /// A position may only be closed once it holds nothing at all.
    pub fn is_empty(&self) -> bool {
        for slot in 0..MAX_BIN_PER_POSITION {
            if self.liquidity_shares[slot] != 0 {
                return false;
            }
        }
        self.fee_infos
            .iter()
            .all(|f| f.fee_x_pending == 0 && f.fee_y_pending == 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::ONE_Q64;
    use crate::math::liquidity::bin_liquidity;
    use bytemuck::Zeroable;

    const P2: u128 = 2 * ONE_Q64;

    fn position(lower: i32, width: i32) -> Position {
        let mut p = Position::zeroed();
        p.lower_bin_id = lower;
        p.upper_bin_id = lower + width - 1;
        p
    }

    fn bin(amount_x: u64, amount_y: u64) -> Bin {
        let mut b = Bin::zeroed();
        b.price = P2;
        b.amount_x = amount_x;
        b.amount_y = amount_y;
        b.liquidity_supply = bin_liquidity(amount_x, amount_y, P2).unwrap();
        b
    }

    #[test]
    fn range_maps_to_slots() {
        let p = position(-10, 5);
        assert_eq!(p.width(), 5);
        assert_eq!(p.slot(-10).unwrap(), 0);
        assert_eq!(p.slot(-6).unwrap(), 4);
        assert!(p.slot(-11).is_err());
        assert!(p.slot(-5).is_err());
    }

    #[test]
    fn shares_add_and_remove() {
        let mut p = position(0, 3);
        p.add_shares(1, 500).unwrap();
        p.add_shares(1, 250).unwrap();
        assert_eq!(p.share_at(1), 750);
        p.remove_shares(1, 750).unwrap();
        assert_eq!(p.share_at(1), 0);
    }

    #[test]
    fn removing_more_shares_than_held_is_rejected() {
        let mut p = position(0, 3);
        p.add_shares(0, 100).unwrap();
        assert!(p.remove_shares(0, 101).is_err());
        assert!(p.remove_shares(2, 1).is_err());
    }

    #[test]
    fn bps_fractions_of_a_holding() {
        let mut p = position(0, 2);
        p.add_shares(0, 1_000).unwrap();
        assert_eq!(p.shares_for_bps(0, 10_000).unwrap(), 1_000);
        assert_eq!(p.shares_for_bps(0, 5_000).unwrap(), 500);
        assert_eq!(p.shares_for_bps(0, 1).unwrap(), 0, "rounds down");
        assert!(p.shares_for_bps(0, 10_001).is_err());
    }

    #[test]
    fn a_partial_fraction_survives_a_realistically_large_share() {
        // Regression: `share * bps` in `u128` aborts the whole withdrawal once
        // a bin holds a few million whole tokens. A bin with 2e15 raw units at
        // price 1.0 carries a Q64.64 share of ~3.7e34, and 9_999 of that is
        // past `u128::MAX`.
        let mut p = position(0, 1);
        let share = bin_liquidity(0, 2_000_000_000_000_000, ONE_Q64).unwrap();
        assert!(share.checked_mul(9_999).is_none(), "test no longer overflows");

        p.add_shares(0, share).unwrap();
        let half = p.shares_for_bps(0, 5_000).unwrap();
        assert_eq!(half, share / 2);
        let almost_all = p.shares_for_bps(0, 9_999).unwrap();
        assert!(almost_all < share && almost_all > share / 2);
        assert_eq!(p.shares_for_bps(0, 10_000).unwrap(), share);
    }

    #[test]
    fn full_bps_withdrawal_is_exact_even_with_odd_shares() {
        let mut p = position(0, 1);
        p.add_shares(0, 999_999_999_999_999_999_999u128).unwrap();
        let all = p.shares_for_bps(0, 10_000).unwrap();
        assert_eq!(all, p.share_at(0), "must not lose a share to rounding");
    }

    #[test]
    fn syncing_credits_growth_that_accrued_while_present() {
        let mut p = position(0, 2);
        let mut b = bin(1_000, 1_000);
        let supply = b.liquidity_supply;

        p.add_shares(0, supply).unwrap();
        b.accrue_lp_fee(1_000, 400).unwrap();
        p.sync_fees(0, &b).unwrap();

        let info = &p.fee_infos[0];
        let (px, py) = (info.fee_x_pending, info.fee_y_pending);
        assert!(px >= 999 && px <= 1_000, "got {px}");
        assert!(py >= 399 && py <= 400, "got {py}");
    }

    #[test]
    fn syncing_twice_does_not_double_credit() {
        let mut p = position(0, 2);
        let mut b = bin(1_000, 1_000);
        p.add_shares(0, b.liquidity_supply).unwrap();
        b.accrue_lp_fee(1_000, 0).unwrap();

        p.sync_fees(0, &b).unwrap();
        let once = p.fee_infos[0].fee_x_pending;
        p.sync_fees(0, &b).unwrap();
        let twice = p.fee_infos[0].fee_x_pending;
        assert_eq!(once, twice, "second sync credited growth again");
    }

    #[test]
    fn a_position_joining_late_earns_nothing_retroactively() {
        let mut p = position(0, 2);
        let mut b = bin(1_000, 1_000);
        b.accrue_lp_fee(5_000, 5_000).unwrap();

        // Join after the fee accrued: sync first (checkpointing at the current
        // growth), then take shares.
        p.sync_fees(0, &b).unwrap();
        p.add_shares(0, b.liquidity_supply).unwrap();
        p.sync_fees(0, &b).unwrap();

        let info = &p.fee_infos[0];
        let (px, py) = (info.fee_x_pending, info.fee_y_pending);
        assert_eq!((px, py), (0, 0), "credited fees from before joining");
    }

    #[test]
    fn taking_fees_clears_pending_and_totals_up() {
        let mut p = position(0, 3);
        let mut b = bin(1_000, 1_000);
        p.add_shares(0, b.liquidity_supply).unwrap();
        b.accrue_lp_fee(600, 300).unwrap();
        p.sync_fees(0, &b).unwrap();

        let (x, y) = p.take_pending_fees().unwrap();
        assert!(x > 0 && y > 0);
        assert_eq!(p.take_pending_fees().unwrap(), (0, 0), "not drained");
        let (tx, ty) = (p.total_claimed_fee_x, p.total_claimed_fee_y);
        assert_eq!((tx, ty), (x, y));
    }

    #[test]
    fn emptiness_requires_both_shares_and_fees_to_be_zero() {
        let mut p = position(0, 3);
        assert!(p.is_empty());

        p.add_shares(1, 10).unwrap();
        assert!(!p.is_empty(), "holds shares");
        p.remove_shares(1, 10).unwrap();
        assert!(p.is_empty());

        p.fee_infos[2].fee_y_pending = 1;
        assert!(!p.is_empty(), "holds unclaimed fees");
    }
}
