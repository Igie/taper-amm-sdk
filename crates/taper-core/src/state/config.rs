//! Pool presets.
//!
//! A `Config` is the analogue of DLMM's `PresetParameter`: it fixes the price
//! ladder and the fee schedule, and pools point at it. Anyone may create one,
//! but a config is namespaced by its creator, so the `index` space is per
//! authority and nobody can squat a global slot.

use crate::constants::{HARD_MAX_BIN_ID, HARD_MIN_BIN_ID, MAX_PROTOCOL_SHARE, ONE_Q64};
use crate::errors::{CoreError, Result};
use crate::require;
use crate::math::ladder::Ladder;

/// Where a swap's fee is denominated.
#[cfg(feature = "anchor")]
use anchor_lang::prelude::borsh;

// Borsh, only when the program crate is the consumer. Nothing takes these
// as an instruction argument, but dropping a derive is an interface change
// and this refactor is not the place to make one.
#[cfg_attr(feature = "anchor", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CollectFeeMode {
    /// Fee is taken from whichever token enters the swap, so LPs accrue both
    /// sides. This is the default and what "both token fee" means.
    InputToken = 0,
    /// Fee is always denominated in Y (the quote token), even when Y is the
    /// output. Launch-friendly when Y is SOL or USDC.
    QuoteOnly = 1,
}

impl CollectFeeMode {
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0 => Ok(CollectFeeMode::InputToken),
            1 => Ok(CollectFeeMode::QuoteOnly),
            _ => Err(CoreError::InvalidFeeParameters),
        }
    }

    /// Whether the fee should be carved out of the *output* for this swap
    /// direction. Only quote-only collection on an X -> Y swap qualifies.
    pub fn fee_on_output(&self, swap_for_y: bool) -> bool {
        matches!(self, CollectFeeMode::QuoteOnly) && swap_for_y
    }
}

#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C, packed)]
#[derive(Debug)]
pub struct Config {
    /// Creator; namespaces `index` and may withdraw protocol fees.
    pub authority: [u8; 32],
    /// `w0` — width of bin 0 in log2 price units, Q64.64.
    pub base_width_q64: u128,
    /// `tau` — per-bin decay of the width, Q64.64. `1.0` means a uniform,
    /// DLMM-equivalent ladder.
    pub taper_q64: u128,
    /// Usable bin band, proven sound by [`Ladder::validate_range`].
    pub min_bin_id: i32,
    pub max_bin_id: i32,
    /// Per-authority preset index.
    pub index: u16,
    /// Multiplies the bin's own width to give the base fee.
    pub base_factor: u16,
    /// Extra power of ten on the base fee.
    pub base_fee_power_factor: u8,
    /// Protocol's cut of the trading fee, in bps of the fee.
    pub protocol_share: u16,
    /// [`CollectFeeMode`] as a byte.
    pub collect_fee_mode: u8,
    /// Seconds below which volatility references are held steady.
    pub filter_period: u16,
    /// Seconds after which volatility references reset to zero.
    pub decay_period: u16,
    /// Bps of the accumulator carried across a decay window.
    pub reduction_factor: u16,
    /// Scales the squared-volatility term. Zero disables the variable fee.
    pub variable_fee_control: u32,
    /// Ceiling on the volatility accumulator.
    pub max_volatility_accumulator: u32,
    pub bump: u8,
    pub _reserved: [u8; 65],
}

impl Config {
    pub const LEN: usize = 8 + core::mem::size_of::<Config>();

    pub fn ladder(&self) -> Ladder {
        Ladder {
            base_width_q64: self.base_width_q64,
            taper_q64: self.taper_q64,
        }
    }

    pub fn collect_fee_mode(&self) -> Result<CollectFeeMode> {
        CollectFeeMode::from_u8(self.collect_fee_mode)
    }

    /// Checks every field that is not already implied by the ladder itself.
    pub fn validate(&self) -> Result<()> {
        let ladder = Ladder::new(self.base_width_q64, self.taper_q64)?;
        ladder.validate_range(self.min_bin_id, self.max_bin_id)?;

        // A sound ladder is not enough: a bin outside the pool's inline
        // bitmap has no `BinArray` that can ever be created for it, so a
        // position or a pool anchored there is stranded — and pool rent is
        // not recoverable. The ladder itself often reaches much further than
        // the bitmap does, which is exactly why this has to be checked
        // separately.
        require!(
            self.min_bin_id >= HARD_MIN_BIN_ID && self.max_bin_id <= HARD_MAX_BIN_ID,
            CoreError::BinRangeExceedsBitmap
        );

        require!(
            self.protocol_share <= MAX_PROTOCOL_SHARE,
            CoreError::InvalidProtocolShare
        );
        require!(self.base_factor > 0, CoreError::InvalidFeeParameters);
        require!(
            self.base_fee_power_factor <= 10,
            CoreError::InvalidFeeParameters
        );
        require!(
            self.reduction_factor <= 10_000,
            CoreError::InvalidFeeParameters
        );
        require!(
            self.filter_period <= self.decay_period,
            CoreError::InvalidFeeParameters
        );
        self.collect_fee_mode()?;

        // A variable fee that can never engage is a configuration mistake, not
        // a disabled feature; disabling is expressed by a zero control.
        if self.variable_fee_control > 0 {
            require!(
                self.max_volatility_accumulator > 0,
                CoreError::InvalidFeeParameters
            );
        }
        Ok(())
    }

    pub fn contains_bin(&self, bin_id: i32) -> bool {
        bin_id >= self.min_bin_id && bin_id <= self.max_bin_id
    }

    /// True when this config describes a uniform (classic DLMM) ladder.
    pub fn is_uniform(&self) -> bool {
        self.taper_q64 == ONE_Q64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytemuck::Zeroable;

    /// A uniform 10 bps ladder over a band the bitmap can actually cover.
    fn config(min_bin_id: i32, max_bin_id: i32) -> Config {
        let mut c = Config::zeroed();
        // w0 = log2(1.001), the width of a 10 bps bin.
        c.base_width_q64 = 26_593_072_477_664_180;
        c.taper_q64 = ONE_Q64;
        c.min_bin_id = min_bin_id;
        c.max_bin_id = max_bin_id;
        c.base_factor = 10_000;
        c.protocol_share = 1_000;
        c.filter_period = 30;
        c.decay_period = 600;
        c.reduction_factor = 5_000;
        c.variable_fee_control = 40_000;
        c.max_volatility_accumulator = 350_000;
        c
    }

    #[test]
    fn a_band_inside_the_bitmap_is_accepted() {
        assert!(config(HARD_MIN_BIN_ID, HARD_MAX_BIN_ID).validate().is_ok());
        assert!(config(-1_000, 1_000).validate().is_ok());
    }

    #[test]
    fn a_band_reaching_past_the_bitmap_is_rejected() {
        // The ladder is perfectly sound out here — `validate_range` passes —
        // but no `BinArray` can ever be created for these bins, so a pool or a
        // position anchored in them would be stranded and its rent lost.
        let over = config(HARD_MIN_BIN_ID, HARD_MAX_BIN_ID + 1);
        assert!(Ladder::new(over.base_width_q64, over.taper_q64)
            .unwrap()
            .validate_range(over.min_bin_id, over.max_bin_id)
            .is_ok());
        assert!(over.validate().is_err(), "band past the bitmap ceiling");

        let under = config(HARD_MIN_BIN_ID - 1, HARD_MAX_BIN_ID);
        assert!(under.validate().is_err(), "band past the bitmap floor");
    }
}
