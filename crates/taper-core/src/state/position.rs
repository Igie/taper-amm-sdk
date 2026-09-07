//! LP positions.
//!
//! A position is a contiguous band of bins plus, per bin, a liquidity share
//! and a fee checkpoint. Ownership is the account itself — no LP token, no
//! NFT — and the account is an ordinary keypair account, not a PDA: its
//! address encodes nothing, because there is nothing about a position that
//! stays still long enough to be encoded.
//!
//! The consequence that drives every LP decision is the same as DLMM's: a
//! position only earns while the active bin sits inside its range.
//!
//! # Why this file has two types
//!
//! A band may reach up to [`MAX_BIN_PER_POSITION`] bins, which is far more
//! than fits in a fixed `Pod` struct anyone would want to allocate up front.
//! So the account is **grown**, and it is grown at the tail:
//!
//! ```text
//!   [8] discriminator
//!   [ Position ]                        <- fixed, 4,608 bytes, 70 bins inline
//!   [ PositionBinData ] * (capacity-70) <- appended by `resize_position`
//! ```
//!
//! [`Position`] is that fixed header, and every byte offset inside it is
//! exactly where it was before growth existed — which is the whole point of
//! appending rather than re-laying-out. It carries the range and the totals,
//! and it owns the first [`INLINE_BINS_PER_POSITION`] bins.
//!
//! [`PositionMut`] is how anything reads or writes a *bin*. It borrows the
//! account's bytes once and indexes into them, so slot 12 and slot 900 are
//! reached the same way and no caller has to know which side of the boundary a
//! bin falls on. Bin-indexed state is only ever touched through it.
//!
//! **Capacity is the account's length, not a stored field.** `capacity =
//! 70 + (len - Position::LEN) / 64`. There is nothing to keep in step, nothing
//! to migrate, and a position cannot lie about how much room it has.
//!
//! # The band moves
//!
//! `lower_bin_id` and `upper_bin_id` are both mutable, and `resize_position`
//! is the one instruction that changes them — widening, narrowing, or sliding
//! the band whole. The invariant it maintains is `width <= capacity`: a
//! position never declares range it has no storage for, which is why nothing
//! outside this file has to reason about a half-grown band.
//!
//! Slot `k` means bin `lower_bin_id + k`, so moving the lower edge renumbers
//! every slot. [`PositionMut::rebase`] is where that happens, and it is the
//! only place — every other read and write in the program goes through
//! [`PositionMut::slot`], which is what keeps the cost of a mobile band
//! confined to one function.

use crate::constants::{
    BASIS_POINT_MAX, INLINE_BINS_PER_POSITION, MAX_BIN_PER_POSITION, POSITION_BIN_DATA_SIZE,
};
use crate::errors::{CoreError, Result};
use crate::require;
use crate::math::u256::mul_div;
use crate::state::bin_array::Bin;
use bytemuck::Zeroable;

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

/// One bin's worth of position state, for a bin past the inline block.
///
/// Laid out as share-then-fee so a record is the concatenation of the two
/// inline arrays' element types, in that order. 64 bytes, align 1.
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C, packed)]
pub struct PositionBinData {
    pub liquidity_share: u128,
    pub fee: PositionBinFee,
}

#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C, packed)]
pub struct Position {
    pub pool: [u8; 32],
    pub owner: [u8; 32],
    /// The first [`INLINE_BINS_PER_POSITION`] bins' shares. Reach these
    /// through [`PositionMut`], never directly: a wider position keeps the
    /// rest of its bins past the end of this struct.
    pub inline_shares: [u128; INLINE_BINS_PER_POSITION],
    /// The matching fee checkpoints. Same rule.
    pub inline_fees: [PositionBinFee; INLINE_BINS_PER_POSITION],
    pub last_updated_at: i64,
    pub total_claimed_fee_x: u64,
    pub total_claimed_fee_y: u64,
    pub lower_bin_id: i32,
    /// `lower_bin_id + width - 1`. Mutable, like the lower edge: see
    /// [`PositionMut::rebase`]. Never past what `capacity` can hold.
    pub upper_bin_id: i32,
    /// Vestigial. A position was a PDA once; the field stays because state
    /// offsets are ABI and are appended to, never moved.
    pub bump: u8,
    pub _reserved: [u8; 31],
}

impl Position {
    /// The account's size with no bins appended: the smallest a position can
    /// be, and the size `initialize_position` allocates.
    pub const LEN: usize = 8 + core::mem::size_of::<Position>();

    /// The band's width in bins. Never more than
    /// [`PositionMut::capacity`], which `resize_position` maintains.
    pub fn width(&self) -> usize {
        (self.upper_bin_id - self.lower_bin_id + 1) as usize
    }

    pub fn contains(&self, bin_id: i32) -> bool {
        bin_id >= self.lower_bin_id && bin_id <= self.upper_bin_id
    }

    /// Bins an account of this length has storage for.
    ///
    /// The inverse of [`len_for`](Self::len_for), and the reason capacity is
    /// never a stored field: the length is the fact, so the two cannot drift.
    pub const fn capacity_for(len: usize) -> usize {
        if len <= Self::LEN {
            INLINE_BINS_PER_POSITION
        } else {
            INLINE_BINS_PER_POSITION + (len - Self::LEN) / POSITION_BIN_DATA_SIZE
        }
    }

    /// Account length for a position whose storage covers `bins`.
    pub const fn len_for(bins: usize) -> usize {
        if bins <= INLINE_BINS_PER_POSITION {
            Self::LEN
        } else {
            Self::LEN + (bins - INLINE_BINS_PER_POSITION) * POSITION_BIN_DATA_SIZE
        }
    }
}

// ---------------------------------------------------------------- offsets

/// Where the inline share array starts, from the front of the account.
const SHARES_OFFSET: usize = 8 + 32 + 32;
/// Where the inline fee array starts.
const FEES_OFFSET: usize = SHARES_OFFSET + INLINE_BINS_PER_POSITION * SHARE_SIZE;
/// Where appended records start: immediately after the fixed header.
const EXTRA_OFFSET: usize = Position::LEN;

const SHARE_SIZE: usize = core::mem::size_of::<u128>();
const FEE_SIZE: usize = core::mem::size_of::<PositionBinFee>();

/// Byte offset of a slot's share, on either side of the inline boundary.
const fn share_offset(slot: usize) -> usize {
    if slot < INLINE_BINS_PER_POSITION {
        SHARES_OFFSET + slot * SHARE_SIZE
    } else {
        EXTRA_OFFSET + (slot - INLINE_BINS_PER_POSITION) * POSITION_BIN_DATA_SIZE
    }
}

/// Byte offset of a slot's fee record. In an appended record the fee follows
/// the share, which is why the two are not the same expression.
const fn fee_offset(slot: usize) -> usize {
    if slot < INLINE_BINS_PER_POSITION {
        FEES_OFFSET + slot * FEE_SIZE
    } else {
        EXTRA_OFFSET + (slot - INLINE_BINS_PER_POSITION) * POSITION_BIN_DATA_SIZE + SHARE_SIZE
    }
}

// ------------------------------------------------------------------ guard

/// A position's account bytes, with the header and every bin reachable
/// through one borrow.
///
/// Anchor's `AccountLoader` maps only `[8 .. 8 + size_of::<Position>()]`, so
/// it still works on a grown account — but it cannot see the appended records,
/// and a second borrow to reach them would panic. Hence this: borrow once,
/// index by slot, and copy the small `Pod` values in and out rather than hand
/// out references that would alias.
///
/// Every accessor takes a *bin id*, not a slot, so nothing outside this file
/// has to know where the inline block ends.
pub struct PositionMut<'a> {
    bytes: &'a mut [u8],
}

impl<'a> PositionMut<'a> {
    /// Wraps an account's whole data, discriminator included.
    ///
    /// Rejects a length that is not a header plus a whole number of records —
    /// a truncated trailing record would silently read a share out of another
    /// bin's fee checkpoint.
    pub fn new(bytes: &'a mut [u8]) -> Result<Self> {
        require!(bytes.len() >= Position::LEN, CoreError::PositionTooWide);
        require!(
            (bytes.len() - Position::LEN) % POSITION_BIN_DATA_SIZE == 0,
            CoreError::PositionTooWide
        );
        Ok(Self { bytes })
    }

    /// Bins this account currently has storage for. Derived from its length,
    /// so it cannot disagree with reality.
    pub fn capacity(&self) -> usize {
        Position::capacity_for(self.bytes.len())
    }

    /// Bins that are both declared and allocated — the ones that can hold
    /// anything. Equal to the width once extension has finished.
    pub fn usable(&self) -> usize {
        self.header().width().min(self.capacity())
    }

    pub fn header(&self) -> &Position {
        bytemuck::from_bytes(&self.bytes[8..Position::LEN])
    }

    pub fn header_mut(&mut self) -> &mut Position {
        bytemuck::from_bytes_mut(&mut self.bytes[8..Position::LEN])
    }

    pub fn contains(&self, bin_id: i32) -> bool {
        self.header().contains(bin_id)
    }

    /// Slot for a bin id, checked against both the declared band and the
    /// storage that exists.
    ///
    /// The two failures are separate on purpose. A bin outside the band is a
    /// caller pointing at the wrong position. A bin inside the band but past
    /// `capacity` should be unreachable — `resize_position` moves the band and
    /// the storage together, so `width <= capacity` holds from the account's
    /// first byte — and it keeps its own error rather than being folded into
    /// the first, because the two would need different fixes if it ever did
    /// happen.
    pub fn slot(&self, bin_id: i32) -> Result<usize> {
        require!(self.contains(bin_id), CoreError::BinIdOutsidePosition);
        let slot = (bin_id - self.header().lower_bin_id) as usize;
        require!(slot < self.capacity(), CoreError::PositionNotExtended);
        Ok(slot)
    }

    // ---- per-slot primitives -------------------------------------------

    fn share_at(&self, slot: usize) -> u128 {
        let at = share_offset(slot);
        u128::from_le_bytes(self.bytes[at..at + SHARE_SIZE].try_into().unwrap())
    }

    fn set_share_at(&mut self, slot: usize, value: u128) {
        let at = share_offset(slot);
        self.bytes[at..at + SHARE_SIZE].copy_from_slice(&value.to_le_bytes());
    }

    /// Copied out rather than borrowed: 48 packed bytes, and a reference would
    /// keep the whole account borrowed for as long as it lived.
    fn fee_at(&self, slot: usize) -> PositionBinFee {
        let at = fee_offset(slot);
        *bytemuck::from_bytes(&self.bytes[at..at + FEE_SIZE])
    }

    fn set_fee_at(&mut self, slot: usize, fee: PositionBinFee) {
        let at = fee_offset(slot);
        self.bytes[at..at + FEE_SIZE].copy_from_slice(bytemuck::bytes_of(&fee));
    }

    // ---- the operations the instructions actually perform ----------------

    /// Shares held in a bin.
    pub fn share_of(&self, bin_id: i32) -> Result<u128> {
        Ok(self.share_at(self.slot(bin_id)?))
    }

    /// The fee record for a bin, for a caller that wants to inspect it.
    pub fn fee_of(&self, bin_id: i32) -> Result<PositionBinFee> {
        Ok(self.fee_at(self.slot(bin_id)?))
    }

    /// Moves any fee growth accrued since the last checkpoint into `pending`,
    /// then re-anchors the checkpoint.
    ///
    /// Must run before a bin's share balance changes, otherwise the new
    /// balance would be credited with growth it was not present for.
    pub fn sync_fees(&mut self, bin_id: i32, bin: &Bin) -> Result<()> {
        let slot = self.slot(bin_id)?;
        let share = self.share_at(slot);
        let mut info = self.fee_at(slot);

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
        self.set_fee_at(slot, info);
        Ok(())
    }

    /// Whether syncing this bin could credit anything.
    ///
    /// A slot holding no shares is owed nothing — `fees_owed` multiplies by
    /// the share — and its checkpoint is re-anchored by the next deposit
    /// before that deposit's shares exist, so skipping it loses nothing. What
    /// it saves is the caller loading the bin at all, and loading a bin nobody
    /// has touched *derives and permanently caches its price*, which is the
    /// most expensive thing this program does.
    pub fn earns_at(&self, bin_id: i32) -> bool {
        match self.slot(bin_id) {
            Ok(slot) => self.share_at(slot) != 0,
            Err(_) => false,
        }
    }

    pub fn add_shares(&mut self, bin_id: i32, shares: u128) -> Result<()> {
        let slot = self.slot(bin_id)?;
        let next = self
            .share_at(slot)
            .checked_add(shares)
            .ok_or_else(|| CoreError::MathOverflow)?;
        self.set_share_at(slot, next);
        Ok(())
    }

    pub fn remove_shares(&mut self, bin_id: i32, shares: u128) -> Result<()> {
        let slot = self.slot(bin_id)?;
        let held = self.share_at(slot);
        require!(held >= shares, CoreError::InsufficientLiquidity);
        self.set_share_at(slot, held - shares);
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
        let share = self.share_at(self.slot(bin_id)?);
        if bps as u128 == BASIS_POINT_MAX {
            // Exact, and it keeps a full withdrawal free of rounding.
            return Ok(share);
        }
        mul_div(share, bps as u128, BASIS_POINT_MAX)
    }

    /// Drains and reports all pending fees, across every allocated bin.
    pub fn take_pending_fees(&mut self) -> Result<(u64, u64)> {
        let (mut total_x, mut total_y) = (0u64, 0u64);
        for slot in 0..self.usable() {
            let mut info = self.fee_at(slot);
            if info.fee_x_pending == 0 && info.fee_y_pending == 0 {
                continue;
            }
            total_x = total_x
                .checked_add(info.fee_x_pending)
                .ok_or_else(|| CoreError::MathOverflow)?;
            total_y = total_y
                .checked_add(info.fee_y_pending)
                .ok_or_else(|| CoreError::MathOverflow)?;
            info.fee_x_pending = 0;
            info.fee_y_pending = 0;
            self.set_fee_at(slot, info);
        }
        let header = self.header_mut();
        header.total_claimed_fee_x = header.total_claimed_fee_x.saturating_add(total_x);
        header.total_claimed_fee_y = header.total_claimed_fee_y.saturating_add(total_y);
        Ok((total_x, total_y))
    }

    /// A position may only be closed once it holds nothing at all.
    pub fn is_empty(&self) -> bool {
        for slot in 0..self.usable() {
            if self.share_at(slot) != 0 {
                return false;
            }
            let info = self.fee_at(slot);
            if info.fee_x_pending != 0 || info.fee_y_pending != 0 {
                return false;
            }
        }
        true
    }

    /// Whether every bin the position holds *outside* `[keep_lower,
    /// keep_upper]` is free of shares and pending fees.
    ///
    /// The question `resize_position` has to answer before it moves anything:
    /// a bin dropped from the band while it still held shares would burn the
    /// owner's liquidity and strand the matching tokens in the reserve with
    /// nobody able to claim them.
    ///
    /// Only the two ends are scanned, never the whole band — trimming forty
    /// bins off a full-width position should not cost fourteen hundred slot
    /// reads.
    pub fn is_empty_outside(&self, keep_lower: i32, keep_upper: i32) -> bool {
        let lower = self.header().lower_bin_id;
        let usable = self.usable() as i32;
        let head = (keep_lower - lower).clamp(0, usable) as usize;
        let tail = (keep_upper - lower + 1).clamp(0, usable) as usize;
        (0..head)
            .chain(tail..usable as usize)
            .all(|slot| self.slot_is_empty(slot))
    }

    fn slot_is_empty(&self, slot: usize) -> bool {
        let fee = self.fee_at(slot);
        self.share_at(slot) == 0 && fee.fee_x_pending == 0 && fee.fee_y_pending == 0
    }

    fn copy_slot(&mut self, from: usize, to: usize) {
        let share = self.share_at(from);
        let fee = self.fee_at(from);
        self.set_share_at(to, share);
        self.set_fee_at(to, fee);
    }

    /// Moves `count` consecutive slots, handling the overlap in whichever
    /// direction keeps unread source slots intact: forward when the
    /// destination is lower, backward when it is higher.
    fn move_slots(&mut self, src: usize, dst: usize, count: usize) {
        if src == dst {
            return;
        }
        if dst < src {
            for i in 0..count {
                self.copy_slot(src + i, dst + i);
            }
        } else {
            for i in (0..count).rev() {
                self.copy_slot(src + i, dst + i);
            }
        }
    }

    fn zero_slots(&mut self, from: usize, count: usize) {
        for slot in from..from + count {
            self.set_share_at(slot, 0);
            self.set_fee_at(slot, PositionBinFee::zeroed());
        }
    }

    /// Re-anchors every bin the position keeps onto a new band, in place.
    ///
    /// Slot `k` means bin `lower_bin_id + k`, so moving either end of the band
    /// renumbers slots — and because every read and write already goes through
    /// [`slot`](Self::slot), getting this one function right is the whole of
    /// what a mobile band costs. The bins the two bands share are moved to
    /// where the new band expects them; everything else in the new band is
    /// zeroed, including the slots the move vacated.
    ///
    /// **The caller grows the account first when the band widens.** Only the
    /// program can `realloc`, so this refuses a band wider than the storage
    /// that exists rather than reaching past the end of it.
    pub fn rebase(&mut self, new_lower: i32, new_upper: i32) -> Result<()> {
        require!(new_lower <= new_upper, CoreError::InvalidBinRange);
        let width = (new_upper as i64 - new_lower as i64 + 1) as usize;
        require!(width <= MAX_BIN_PER_POSITION, CoreError::PositionTooWide);
        require!(width <= self.capacity(), CoreError::PositionNotExtended);

        let old_lower = self.header().lower_bin_id;
        let old_upper = self.header().upper_bin_id;

        // The bins both bands contain. Everything else in the new band is a
        // bin this position did not hold a moment ago.
        let lo = old_lower.max(new_lower);
        let hi = old_upper.min(new_upper);
        if lo <= hi {
            let count = (hi - lo + 1) as usize;
            let dst = (lo - new_lower) as usize;
            self.move_slots((lo - old_lower) as usize, dst, count);
            self.zero_slots(0, dst);
            self.zero_slots(dst + count, width - dst - count);
        } else {
            // The bands are disjoint, so nothing survives the move. Only
            // reachable when every bin was empty, which `is_empty_outside`
            // has already established.
            self.zero_slots(0, width);
        }

        let header = self.header_mut();
        header.lower_bin_id = new_lower;
        header.upper_bin_id = new_upper;
        Ok(())
    }

    pub fn touch(&mut self, now: i64) {
        self.header_mut().last_updated_at = now;
    }

    /// Checks a width a position may be *resized* to.
    pub fn validate_width(width: usize) -> Result<()> {
        require!(
            width >= 1 && width <= MAX_BIN_PER_POSITION,
            CoreError::PositionTooWide
        );
        Ok(())
    }

    /// Checks a width a position may be *opened* at.
    ///
    /// Tighter than [`validate_width`] by exactly the inline block: an account
    /// is created at [`Position::LEN`] and nothing may declare a band it has
    /// no storage for, so a wider one is reached through `resize_position`.
    /// That is what keeps `width <= capacity` true from the account's first
    /// byte, and it is why no client ever has to recover from a position that
    /// promised more range than it can hold.
    pub fn validate_initial_width(width: usize) -> Result<()> {
        require!(
            width >= 1 && width <= INLINE_BINS_PER_POSITION,
            CoreError::PositionTooWide
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::ONE_Q64;
    use crate::math::liquidity::bin_liquidity;

    const P2: u128 = 2 * ONE_Q64;

    /// A position account of `width` bins, with storage for `capacity` of them.
    fn account(lower: i32, width: i32, capacity: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; Position::len_for(capacity)];
        {
            let mut p = PositionMut::new(&mut bytes).unwrap();
            let header = p.header_mut();
            header.lower_bin_id = lower;
            header.upper_bin_id = lower + width - 1;
        }
        bytes
    }

    /// The common case: everything the band declares is allocated.
    fn whole(lower: i32, width: i32) -> Vec<u8> {
        account(lower, width, (width as usize).max(INLINE_BINS_PER_POSITION))
    }

    fn bin(amount_x: u64, amount_y: u64) -> Bin {
        let mut b = Bin::zeroed();
        b.price = P2;
        b.amount_x = amount_x;
        b.amount_y = amount_y;
        b.liquidity_supply = bin_liquidity(amount_x, amount_y, P2).unwrap();
        b
    }

    use bytemuck::Zeroable;

    #[test]
    fn range_maps_to_slots() {
        let mut bytes = whole(-10, 5);
        let p = PositionMut::new(&mut bytes).unwrap();
        assert_eq!(p.header().width(), 5);
        assert_eq!(p.slot(-10).unwrap(), 0);
        assert_eq!(p.slot(-6).unwrap(), 4);
        assert!(p.slot(-11).is_err());
        assert!(p.slot(-5).is_err());
    }

    #[test]
    fn shares_add_and_remove() {
        let mut bytes = whole(0, 3);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        p.add_shares(1, 500).unwrap();
        p.add_shares(1, 250).unwrap();
        assert_eq!(p.share_of(1).unwrap(), 750);
        p.remove_shares(1, 750).unwrap();
        assert_eq!(p.share_of(1).unwrap(), 0);
    }

    #[test]
    fn removing_more_shares_than_held_is_rejected() {
        let mut bytes = whole(0, 3);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        p.add_shares(0, 100).unwrap();
        assert!(p.remove_shares(0, 101).is_err());
        assert!(p.remove_shares(2, 1).is_err());
    }

    #[test]
    fn bps_fractions_of_a_holding() {
        let mut bytes = whole(0, 2);
        let mut p = PositionMut::new(&mut bytes).unwrap();
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
        let mut bytes = whole(0, 1);
        let mut p = PositionMut::new(&mut bytes).unwrap();
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
        let mut bytes = whole(0, 1);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        p.add_shares(0, 999_999_999_999_999_999_999u128).unwrap();
        let all = p.shares_for_bps(0, 10_000).unwrap();
        assert_eq!(all, p.share_of(0).unwrap(), "must not lose a share to rounding");
    }

    #[test]
    fn syncing_credits_growth_that_accrued_while_present() {
        let mut bytes = whole(0, 2);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        let mut b = bin(1_000, 1_000);
        let supply = b.liquidity_supply;

        p.add_shares(0, supply).unwrap();
        b.accrue_lp_fee(1_000, 400).unwrap();
        p.sync_fees(0, &b).unwrap();

        let info = p.fee_of(0).unwrap();
        let (px, py) = (info.fee_x_pending, info.fee_y_pending);
        assert!(px >= 999 && px <= 1_000, "got {px}");
        assert!(py >= 399 && py <= 400, "got {py}");
    }

    #[test]
    fn syncing_twice_does_not_double_credit() {
        let mut bytes = whole(0, 2);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        let mut b = bin(1_000, 1_000);
        p.add_shares(0, b.liquidity_supply).unwrap();
        b.accrue_lp_fee(1_000, 0).unwrap();

        p.sync_fees(0, &b).unwrap();
        let once = p.fee_of(0).unwrap().fee_x_pending;
        p.sync_fees(0, &b).unwrap();
        let twice = p.fee_of(0).unwrap().fee_x_pending;
        assert_eq!(once, twice, "second sync credited growth again");
    }

    #[test]
    fn a_position_joining_late_earns_nothing_retroactively() {
        let mut bytes = whole(0, 2);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        let mut b = bin(1_000, 1_000);
        b.accrue_lp_fee(5_000, 5_000).unwrap();

        // Join after the fee accrued: sync first (checkpointing at the current
        // growth), then take shares.
        p.sync_fees(0, &b).unwrap();
        p.add_shares(0, b.liquidity_supply).unwrap();
        p.sync_fees(0, &b).unwrap();

        let info = p.fee_of(0).unwrap();
        let (px, py) = (info.fee_x_pending, info.fee_y_pending);
        assert_eq!((px, py), (0, 0), "credited fees from before joining");
    }

    #[test]
    fn taking_fees_clears_pending_and_totals_up() {
        let mut bytes = whole(0, 3);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        let mut b = bin(1_000, 1_000);
        p.add_shares(0, b.liquidity_supply).unwrap();
        b.accrue_lp_fee(600, 300).unwrap();
        p.sync_fees(0, &b).unwrap();

        let (x, y) = p.take_pending_fees().unwrap();
        assert!(x > 0 && y > 0);
        assert_eq!(p.take_pending_fees().unwrap(), (0, 0), "not drained");
        let header = p.header();
        let (tx, ty) = (header.total_claimed_fee_x, header.total_claimed_fee_y);
        assert_eq!((tx, ty), (x, y));
    }

    #[test]
    fn emptiness_requires_both_shares_and_fees_to_be_zero() {
        let mut bytes = whole(0, 3);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        assert!(p.is_empty());

        p.add_shares(1, 10).unwrap();
        assert!(!p.is_empty(), "holds shares");
        p.remove_shares(1, 10).unwrap();
        assert!(p.is_empty());

        let mut fee = p.fee_of(2).unwrap();
        fee.fee_y_pending = 1;
        let slot = p.slot(2).unwrap();
        p.set_fee_at(slot, fee);
        assert!(!p.is_empty(), "holds unclaimed fees");
    }

    // ---- growth ---------------------------------------------------------

    #[test]
    fn length_and_capacity_are_inverses() {
        for bins in [1usize, 69, 70, 71, 140, 157, 1_400] {
            let len = Position::len_for(bins);
            assert_eq!(
                Position::capacity_for(len),
                bins.max(INLINE_BINS_PER_POSITION),
                "{bins} bins"
            );
        }
    }

    #[test]
    fn capacity_is_the_accounts_length() {
        let mut bytes = account(0, 200, INLINE_BINS_PER_POSITION);
        assert_eq!(PositionMut::new(&mut bytes).unwrap().capacity(), 70);

        let mut bytes = account(0, 200, 200);
        let p = PositionMut::new(&mut bytes).unwrap();
        assert_eq!(p.capacity(), 200);
        assert_eq!(p.usable(), 200);
        assert_eq!(bytes.len(), Position::LEN + 130 * POSITION_BIN_DATA_SIZE);
    }

    #[test]
    fn a_bin_past_the_allocated_part_is_a_distinct_failure() {
        // Declared 200 wide, only the inline 70 allocated. Bin 100 is inside
        // the band and has nowhere to live yet; bin 500 is simply not ours.
        let mut bytes = account(0, 200, INLINE_BINS_PER_POSITION);
        let p = PositionMut::new(&mut bytes).unwrap();
        assert_eq!(p.slot(69).unwrap(), 69);
        assert_eq!(p.slot(100).unwrap_err(), CoreError::PositionNotExtended);
        assert_eq!(p.slot(500).unwrap_err(), CoreError::BinIdOutsidePosition);
    }

    #[test]
    fn appended_bins_hold_shares_and_fees_like_inline_ones() {
        let mut bytes = whole(0, 300);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        let mut b = bin(1_000, 1_000);

        // Packed field: bind before comparing, or the assert takes a
        // misaligned reference to it.
        let supply = b.liquidity_supply;

        // One either side of the inline boundary, and one far past it.
        for bin_id in [0i32, 69, 70, 71, 299] {
            p.add_shares(bin_id, supply).unwrap();
        }
        b.accrue_lp_fee(5_000, 5_000).unwrap();
        for bin_id in [0i32, 69, 70, 71, 299] {
            p.sync_fees(bin_id, &b).unwrap();
            assert_eq!(p.share_of(bin_id).unwrap(), supply, "bin {bin_id}");
            let pending = p.fee_of(bin_id).unwrap().fee_x_pending;
            assert!(pending > 0, "bin {bin_id}");
        }

        let (x, y) = p.take_pending_fees().unwrap();
        assert!(x > 0 && y > 0);
        assert!(!p.is_empty(), "still holds shares");
    }

    #[test]
    fn slots_do_not_overlap_across_the_inline_boundary() {
        // Writing every slot a distinct value and reading them all back is the
        // check that `share_offset` and `fee_offset` never alias — an
        // off-by-one in the appended-record arithmetic would show up as one
        // bin's share landing in another bin's fee checkpoint.
        let mut bytes = whole(0, 140);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        for slot in 0..140u128 {
            p.add_shares(slot as i32, slot + 1).unwrap();
        }
        for slot in 0..140u128 {
            assert_eq!(p.share_of(slot as i32).unwrap(), slot + 1, "slot {slot}");
            let fee = p.fee_of(slot as i32).unwrap();
            let (cx, cy) = (fee.fee_x_per_share_checkpoint, fee.fee_y_per_share_checkpoint);
            assert_eq!((cx, cy), (0, 0), "slot {slot} checkpoint was overwritten");
        }
    }

    #[test]
    fn a_length_that_is_not_a_whole_number_of_records_is_rejected() {
        let mut short = vec![0u8; Position::LEN - 1];
        assert!(PositionMut::new(&mut short).is_err());
        let mut ragged = vec![0u8; Position::LEN + POSITION_BIN_DATA_SIZE + 1];
        assert!(PositionMut::new(&mut ragged).is_err());
    }

    #[test]
    fn the_inline_offsets_are_where_the_struct_puts_them() {
        // The appended layout is only sound if these agree with the struct,
        // and a client reads the inline block at exactly these offsets.
        assert_eq!(SHARES_OFFSET, 72);
        assert_eq!(FEES_OFFSET, 1_192);
        assert_eq!(EXTRA_OFFSET, 4_616);
        assert_eq!(share_offset(0), SHARES_OFFSET);
        assert_eq!(share_offset(69), SHARES_OFFSET + 69 * 16);
        assert_eq!(share_offset(70), EXTRA_OFFSET);
        assert_eq!(fee_offset(70), EXTRA_OFFSET + 16);
        assert_eq!(share_offset(71), EXTRA_OFFSET + 64);
    }

    #[test]
    fn widths_are_bounded_by_the_ceiling() {
        assert!(PositionMut::validate_width(1).is_ok());
        assert!(PositionMut::validate_width(MAX_BIN_PER_POSITION).is_ok());
        assert!(PositionMut::validate_width(0).is_err());
        assert!(PositionMut::validate_width(MAX_BIN_PER_POSITION + 1).is_err());
    }

    // ------------------------------------------------------------- rebase
    //
    // Slot `k` means bin `lower_bin_id + k`, so moving the lower edge
    // renumbers every slot. These pin the one function where that happens.

    #[test]
    fn rebasing_moves_a_bin_to_its_new_slot_and_leaves_it_the_same_bin() {
        let mut bytes = whole(100, 10);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        p.add_shares(105, 7).unwrap();
        assert_eq!(p.share_at(5), 7, "bin 105 is slot 5 of a band based at 100");

        p.rebase(103, 112).unwrap();

        assert_eq!(p.share_at(2), 7, "and slot 2 of one based at 103");
        assert_eq!(p.share_of(105).unwrap(), 7, "but it is still bin 105's");
        let (lower, upper) = (p.header().lower_bin_id, p.header().upper_bin_id);
        assert_eq!(lower, 103);
        assert_eq!(upper, 112);
    }

    #[test]
    fn widening_at_the_bottom_shifts_bins_up_and_zeroes_what_arrives() {
        let mut bytes = whole(100, 10);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        p.add_shares(100, 11).unwrap();
        p.add_shares(109, 22).unwrap();

        p.rebase(90, 109).unwrap();

        assert_eq!(p.share_at(10), 11, "bin 100 moved from slot 0 to slot 10");
        assert_eq!(p.share_of(100).unwrap(), 11);
        assert_eq!(p.share_of(109).unwrap(), 22);
        for bin in 90..100 {
            assert_eq!(p.share_of(bin).unwrap(), 0, "bin {bin} is new");
        }
    }

    /// The regression that matters: a shift downward leaves a copy of every
    /// moved slot behind it, and those slots are inside the new band. A stale
    /// share left there would be liquidity the position never deposited.
    #[test]
    fn a_downward_shift_zeroes_the_slots_it_vacated() {
        let mut bytes = whole(100, 10);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        p.add_shares(105, 9).unwrap();

        // Same width, higher floor: 100..=104 leave, 110..=114 arrive.
        p.rebase(105, 114).unwrap();

        assert_eq!(p.share_of(105).unwrap(), 9);
        assert_eq!(p.share_at(0), 9);
        assert_eq!(p.share_at(5), 0, "slot 5 is bin 110 now, not a copy of 105");
        assert_eq!(p.share_of(110).unwrap(), 0);
    }

    #[test]
    fn a_rebase_carries_the_fee_checkpoint_with_the_share() {
        let mut bytes = whole(100, 10);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        p.add_shares(107, 5).unwrap();
        let mut fee = PositionBinFee::zeroed();
        fee.fee_x_pending = 41;
        fee.fee_y_per_share_checkpoint = 99;
        p.set_fee_at(7, fee);

        p.rebase(104, 113).unwrap();

        let moved = p.fee_of(107).unwrap();
        let pending = moved.fee_x_pending;
        let checkpoint = moved.fee_y_per_share_checkpoint;
        assert_eq!(pending, 41);
        assert_eq!(checkpoint, 99);
        assert_eq!(p.share_of(107).unwrap(), 5);
    }

    #[test]
    fn a_band_that_clears_the_old_one_keeps_nothing() {
        let mut bytes = whole(100, 10);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        p.add_shares(105, 3).unwrap();

        p.rebase(200, 209).unwrap();

        for bin in 200..210 {
            assert_eq!(p.share_of(bin).unwrap(), 0, "bin {bin}");
        }
    }

    #[test]
    fn rebasing_to_the_band_it_already_has_changes_nothing() {
        let mut bytes = whole(100, 10);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        p.add_shares(103, 17).unwrap();

        p.rebase(100, 109).unwrap();
        p.rebase(100, 109).unwrap();

        assert_eq!(p.share_of(103).unwrap(), 17);
        let (lower, upper) = (p.header().lower_bin_id, p.header().upper_bin_id);
        assert_eq!(lower, 100);
        assert_eq!(upper, 109);
    }

    #[test]
    fn a_rebase_may_not_declare_more_than_the_account_holds() {
        let mut bytes = account(100, 10, INLINE_BINS_PER_POSITION);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        assert!(
            p.rebase(100, 100 + INLINE_BINS_PER_POSITION as i32).is_err(),
            "71 bins do not fit an account holding 70"
        );
        assert!(p.rebase(100, 100 + INLINE_BINS_PER_POSITION as i32 - 1).is_ok());
    }

    #[test]
    fn emptiness_is_asked_only_of_the_bins_leaving_the_band() {
        let mut bytes = whole(100, 10);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        p.add_shares(105, 1).unwrap();

        assert!(p.is_empty_outside(100, 109), "keeping everything drops nothing");
        assert!(p.is_empty_outside(105, 105), "the only held bin is kept");
        assert!(!p.is_empty_outside(106, 109), "dropping it from below is refused");
        assert!(!p.is_empty_outside(100, 104), "and from above");
    }

    #[test]
    fn a_bin_owed_a_fee_is_not_empty_enough_to_drop() {
        let mut bytes = whole(100, 10);
        let mut p = PositionMut::new(&mut bytes).unwrap();
        let mut fee = PositionBinFee::zeroed();
        fee.fee_y_pending = 1;
        p.set_fee_at(9, fee);

        assert!(
            !p.is_empty_outside(100, 108),
            "bin 109 holds no shares but is owed a fee, which closing would strand"
        );
    }
}
