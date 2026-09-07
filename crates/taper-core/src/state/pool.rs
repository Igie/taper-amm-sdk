//! Pool state: reserves, the active bin, and the volatility tracker that
//! drives the variable fee.

use crate::constants::{
    BIN_ARRAY_BITMAP_WORDS, MAX_BIN_ARRAY_INDEX, MIN_BIN_ARRAY_INDEX, ONE_Q64,
};
use crate::errors::{CoreError, Result};
use crate::require;
use crate::math::fee::{base_fee_rate, total_fee_rate, variable_fee_rate};
use crate::state::config::Config;

#[cfg(feature = "anchor")]
use anchor_lang::prelude::borsh;

// Borsh, only when the program crate is the consumer. Nothing takes these
// as an instruction argument, but dropping a derive is an interface change
// and this refactor is not the place to make one.
#[cfg_attr(feature = "anchor", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PoolStatus {
    Enabled = 0,
    /// Withdraw-only. Swaps and deposits are rejected.
    Disabled = 1,
}

/// Which token program owns a mint.
///
/// Stored per side so a client can assemble an instruction from the pool
/// account alone, without fetching both mints to read their owners. A pool may
/// mix the two: X on SPL Token and Y on Token-2022 is a valid pair.
// Borsh, only when the program crate is the consumer. Nothing takes these
// as an instruction argument, but dropping a derive is an interface change
// and this refactor is not the place to make one.
#[cfg_attr(feature = "anchor", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TokenProgramFlag {
    SplToken = 0,
    Token2022 = 1,
}

#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C, packed)]
#[derive(Debug)]
pub struct Pool {
    pub config: [u8; 32],
    pub token_x_mint: [u8; 32],
    pub token_y_mint: [u8; 32],
    pub reserve_x: [u8; 32],
    pub reserve_y: [u8; 32],
    pub creator: [u8; 32],
    /// One bit per bin array in `MIN_BIN_ARRAY_INDEX..=MAX_BIN_ARRAY_INDEX`,
    /// set while that array holds liquidity. Clients use it to pick the
    /// arrays a swap needs; the program does not route on it.
    pub bin_array_bitmap: [u64; BIN_ARRAY_BITMAP_WORDS],
    /// Fees owed to the config authority, already excluded from bin amounts.
    pub protocol_fee_x: u64,
    pub protocol_fee_y: u64,
    pub last_update_timestamp: i64,
    /// The bin the market currently trades in.
    pub active_id: i32,
    /// Bin the volatility accumulator measures distance from.
    pub index_reference: i32,
    pub volatility_accumulator: u32,
    pub volatility_reference: u32,
    /// [`PoolStatus`] as a byte.
    pub status: u8,
    pub bump: u8,
    /// [`TokenProgramFlag`] for each side, as a byte.
    pub token_x_flag: u8,
    pub token_y_flag: u8,
    /// Cached mint decimals. `transfer_checked` needs them and clients need
    /// them to turn a Q64.64 lamport price into a displayable one.
    pub token_x_decimals: u8,
    pub token_y_decimals: u8,
    pub _reserved: [u8; 58],
}

impl Pool {
    pub const LEN: usize = 8 + core::mem::size_of::<Pool>();

    pub fn require_enabled(&self) -> Result<()> {
        require!(
            self.status == PoolStatus::Enabled as u8,
            CoreError::PoolDisabled
        );
        Ok(())
    }

    // ---- volatility tracking ----

    /// Decays the volatility reference according to how long the pool has been
    /// idle, then re-anchors it. Mirrors DLMM: inside `filter_period` the
    /// references are held steady, so a burst of trades in the same second
    /// does not repeatedly reset them.
    pub fn update_references(&mut self, config: &Config, now: i64) -> Result<()> {
        let elapsed = now
            .checked_sub(self.last_update_timestamp)
            .ok_or_else(|| CoreError::MathOverflow)?;

        if elapsed >= config.filter_period as i64 {
            self.index_reference = self.active_id;
            self.volatility_reference = if elapsed < config.decay_period as i64 {
                ((self.volatility_accumulator as u64 * config.reduction_factor as u64) / 10_000)
                    as u32
            } else {
                0
            };
        }
        self.last_update_timestamp = now;
        Ok(())
    }

    /// `va = min(v_ref + |index_ref - id| * 10_000, max)`.
    ///
    /// The accumulator counts *bins crossed*. Under a taper a bin is not a
    /// fixed price move, which is exactly why the fee formula multiplies this
    /// by the local bin width rather than by a pool-wide constant.
    pub fn update_volatility_accumulator(&mut self, config: &Config, bin_id: i32) -> Result<()> {
        let delta = bin_id.abs_diff(self.index_reference) as u64;
        let va = (self.volatility_reference as u64)
            .checked_add(delta.checked_mul(10_000).ok_or_else(|| CoreError::MathOverflow)?)
            .ok_or_else(|| CoreError::MathOverflow)?;
        self.volatility_accumulator = va.min(config.max_volatility_accumulator as u64) as u32;
        Ok(())
    }

    /// Total fee rate for a bin of the given width, against `FEE_PRECISION`.
    pub fn fee_rate_for_step(&self, config: &Config, step_bp_x100: u32) -> Result<u128> {
        let base = base_fee_rate(config.base_factor, config.base_fee_power_factor, step_bp_x100)?;
        let variable = variable_fee_rate(
            config.variable_fee_control,
            self.volatility_accumulator,
            step_bp_x100,
        )?;
        Ok(total_fee_rate(base, variable))
    }

    // ---- bin array bitmap ----

    fn bitmap_position(index: i32) -> Result<(usize, u32)> {
        require!(
            (MIN_BIN_ARRAY_INDEX..=MAX_BIN_ARRAY_INDEX).contains(&index),
            CoreError::InvalidBinArrayIndex
        );
        let offset = (index - MIN_BIN_ARRAY_INDEX) as usize;
        Ok((offset / 64, (offset % 64) as u32))
    }

    pub fn set_bin_array_occupied(&mut self, index: i32, occupied: bool) -> Result<()> {
        let (word, bit) = Self::bitmap_position(index)?;
        if occupied {
            self.bin_array_bitmap[word] |= 1u64 << bit;
        } else {
            self.bin_array_bitmap[word] &= !(1u64 << bit);
        }
        Ok(())
    }

    pub fn is_bin_array_occupied(&self, index: i32) -> Result<bool> {
        let (word, bit) = Self::bitmap_position(index)?;
        Ok(self.bin_array_bitmap[word] & (1u64 << bit) != 0)
    }

    /// Price of the active bin, for clients reading pool state.
    pub fn active_price(&self, config: &Config) -> Result<u128> {
        config.ladder().price(self.active_id)
    }
}

/// A price of exactly 1.0 sits at bin 0 in every ladder; handy for tests and
/// for clients converting between price and bin id.
pub const ANCHOR_PRICE_Q64: u128 = ONE_Q64;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::BIN_ARRAY_BITMAP_WORDS;

    fn pool() -> Pool {
        Pool {
            config: [0u8; 32],
            token_x_mint: [0u8; 32],
            token_y_mint: [0u8; 32],
            reserve_x: [0u8; 32],
            reserve_y: [0u8; 32],
            creator: [0u8; 32],
            bin_array_bitmap: [0; BIN_ARRAY_BITMAP_WORDS],
            protocol_fee_x: 0,
            protocol_fee_y: 0,
            last_update_timestamp: 0,
            active_id: 0,
            index_reference: 0,
            volatility_accumulator: 0,
            volatility_reference: 0,
            status: PoolStatus::Enabled as u8,
            bump: 0,
            token_x_flag: TokenProgramFlag::SplToken as u8,
            token_y_flag: TokenProgramFlag::SplToken as u8,
            token_x_decimals: 6,
            token_y_decimals: 6,
            _reserved: [0; 58],
        }
    }

    fn config() -> Config {
        Config {
            authority: [0u8; 32],
            base_width_q64: 0,
            taper_q64: ONE_Q64,
            min_bin_id: -1000,
            max_bin_id: 1000,
            index: 0,
            base_factor: 10_000,
            base_fee_power_factor: 0,
            protocol_share: 1_000,
            collect_fee_mode: 0,
            filter_period: 30,
            decay_period: 600,
            reduction_factor: 5_000,
            variable_fee_control: 40_000,
            max_volatility_accumulator: 350_000,
            bump: 0,
            _reserved: [0; 65],
        }
    }

    #[test]
    fn bitmap_round_trips_across_the_whole_range() {
        let mut p = pool();
        for idx in [MIN_BIN_ARRAY_INDEX, -513 + 1, -1, 0, 1, 511, MAX_BIN_ARRAY_INDEX] {
            assert!(!p.is_bin_array_occupied(idx).unwrap());
            p.set_bin_array_occupied(idx, true).unwrap();
            assert!(p.is_bin_array_occupied(idx).unwrap(), "idx {idx}");
            p.set_bin_array_occupied(idx, false).unwrap();
            assert!(!p.is_bin_array_occupied(idx).unwrap(), "idx {idx}");
        }
    }

    #[test]
    fn bitmap_bits_do_not_alias() {
        let mut p = pool();
        p.set_bin_array_occupied(0, true).unwrap();
        assert!(!p.is_bin_array_occupied(1).unwrap());
        assert!(!p.is_bin_array_occupied(-1).unwrap());
        assert!(!p.is_bin_array_occupied(64).unwrap());
    }

    #[test]
    fn bitmap_rejects_indexes_outside_its_coverage() {
        let mut p = pool();
        assert!(p.set_bin_array_occupied(MIN_BIN_ARRAY_INDEX - 1, true).is_err());
        assert!(p.set_bin_array_occupied(MAX_BIN_ARRAY_INDEX + 1, true).is_err());
    }

    // Packed fields cannot be referenced, so assertions read them into locals.
    #[test]
    fn volatility_accumulates_with_distance_from_the_reference() {
        let (mut p, c) = (pool(), config());
        p.index_reference = 100;
        p.update_volatility_accumulator(&c, 105).unwrap();
        let up = p.volatility_accumulator;
        assert_eq!(up, 50_000);
        // Direction does not matter, only distance.
        p.update_volatility_accumulator(&c, 95).unwrap();
        let down = p.volatility_accumulator;
        assert_eq!(down, 50_000);
    }

    #[test]
    fn volatility_is_capped() {
        let (mut p, c) = (pool(), config());
        p.update_volatility_accumulator(&c, 10_000).unwrap();
        let (got, cap) = (p.volatility_accumulator, c.max_volatility_accumulator);
        assert_eq!(got, cap);
    }

    #[test]
    fn a_quiet_gap_shorter_than_the_filter_holds_the_reference() {
        let (mut p, c) = (pool(), config());
        p.volatility_accumulator = 100_000;
        p.index_reference = 7;
        p.active_id = 42;
        let now = (c.filter_period - 1) as i64;
        p.update_references(&c, now).unwrap();
        let (idx, vref, ts) = (p.index_reference, p.volatility_reference, p.last_update_timestamp);
        assert_eq!(idx, 7, "reference must not move yet");
        assert_eq!(vref, 0);
        assert_eq!(ts, now, "the clock still advances");
    }

    #[test]
    fn a_medium_gap_decays_the_reference_by_the_reduction_factor() {
        let (mut p, c) = (pool(), config());
        p.volatility_accumulator = 100_000;
        p.active_id = 42;
        p.update_references(&c, c.filter_period as i64).unwrap();
        let (idx, vref) = (p.index_reference, p.volatility_reference);
        assert_eq!(idx, 42);
        assert_eq!(vref, 50_000, "5_000 bps of 100_000");
    }

    #[test]
    fn a_long_gap_resets_the_reference() {
        let (mut p, c) = (pool(), config());
        p.volatility_accumulator = 100_000;
        p.active_id = 42;
        p.update_references(&c, c.decay_period as i64).unwrap();
        let (idx, vref) = (p.index_reference, p.volatility_reference);
        assert_eq!(vref, 0);
        assert_eq!(idx, 42);
    }

    #[test]
    fn fee_rate_rises_with_both_width_and_volatility() {
        let (mut p, c) = (pool(), config());
        let calm_narrow = p.fee_rate_for_step(&c, 500).unwrap();
        let calm_wide = p.fee_rate_for_step(&c, 2_000).unwrap();
        assert!(calm_wide > calm_narrow);

        p.volatility_accumulator = 200_000;
        let wild_narrow = p.fee_rate_for_step(&c, 500).unwrap();
        assert!(wild_narrow > calm_narrow);
    }

    #[test]
    fn disabled_pools_are_rejected() {
        let mut p = pool();
        assert!(p.require_enabled().is_ok());
        p.status = PoolStatus::Disabled as u8;
        assert!(p.require_enabled().is_err());
    }
}
