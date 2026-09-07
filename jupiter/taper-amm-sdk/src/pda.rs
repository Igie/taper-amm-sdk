//! Every address the program derives, and which bin arrays a swap needs.
//!
//! Mirrors `sdk/src/pda.ts` seed for seed. The seeds are ABI: an address
//! derived from the wrong ones is not a wrong answer, it is an account that
//! does not exist.

use solana_pubkey::Pubkey;

use crate::TAPER_AMM_ID;
use taper_core::constants::{MAX_BIN_ARRAY_INDEX, MAX_BIN_PER_ARRAY, MIN_BIN_ARRAY_INDEX};

pub use taper_core::math::ladder::{
    bin_array_index, bin_array_lower_bin_id, bin_array_upper_bin_id,
};

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &TAPER_AMM_ID).0
}

pub fn config_pda(authority: &Pubkey, index: u16) -> Pubkey {
    pda(&[b"config", authority.as_ref(), &index.to_le_bytes()])
}

/// The pool PDA is seeded with both mints in order, so X must sort below Y or
/// the same pair would be creatable at two addresses.
pub fn pool_pda(config: &Pubkey, mint_x: &Pubkey, mint_y: &Pubkey) -> Pubkey {
    pda(&[b"pool", config.as_ref(), mint_x.as_ref(), mint_y.as_ref()])
}

pub fn reserve_pda(pool: &Pubkey, mint: &Pubkey) -> Pubkey {
    pda(&[b"reserve", pool.as_ref(), mint.as_ref()])
}

/// Note the `i64` seed: the index is an `i32` everywhere else, but the seed
/// the program derives with is eight bytes.
pub fn bin_array_pda(pool: &Pubkey, index: i32) -> Pubkey {
    pda(&[b"bin_array", pool.as_ref(), &(index as i64).to_le_bytes()])
}

// A position has no PDA: it is a plain keypair account, because its band moves
// and an address derived from a band would be stale the moment it did. Nothing
// here needs one anyway — a quote reads pools and bin arrays, never positions.

/// How many bin arrays to carry either side of the active one.
///
/// Two: the active bin's array, and one in the direction of travel. Measured
/// in `tests/tests/compute.rs`, a hop costs about 12,200 CU per funded bin it
/// crosses against a 1.4M transaction ceiling, which caps *any* Taper hop at
/// 113 bins — and two arrays cover between 71 and 140 of them, depending on
/// where the active bin sits inside its own array.
///
/// So the third array is not unreachable in principle: with the active bin at
/// the bottom of its own array, two cover only 71 and the budget would stretch
/// to 113. It is unreachable in practice, which is the weaker claim this
/// constant actually needs. A hop crossing 71 funded bins is ~7% of price
/// impact on a 10 bps ladder, which no router quotes, and under the 300k a
/// router really budgets the walk stops at 23 bins — inside the first array in
/// the great majority of cases. Raising this to 3 would buy reach only for
/// hops nothing would route, at 394 CU and 6,792 bytes of account per swap.
pub const REACH: usize = 2;

/// Bins per array, so a caller need not reach into `taper-core` for it.
pub const BINS_PER_ARRAY: usize = MAX_BIN_PER_ARRAY;

fn in_bitmap(index: i32) -> bool {
    (MIN_BIN_ARRAY_INDEX..=MAX_BIN_ARRAY_INDEX).contains(&index)
}

/// The bin arrays a swap may walk, in the order it will walk them.
///
/// `exists` is the pool's own bitmap — `Pool::is_bin_array_occupied` — which
/// is what makes this answerable without a network call. Only arrays that
/// exist are named: an address with no account behind it fails the
/// instruction outright.
///
/// A missing array ends the list rather than being skipped. The program breaks
/// its walk the moment it needs an index it was not handed, so nothing past a
/// gap can trade in this swap and naming it would only cost transaction space.
pub fn swap_array_indexes(
    active_id: i32,
    swap_for_y: bool,
    exists: impl Fn(i32) -> bool,
    reach: usize,
) -> Vec<i32> {
    let home = bin_array_index(active_id);
    let step = if swap_for_y { -1 } else { 1 };
    let mut out = Vec::with_capacity(reach);
    for i in 0..reach as i32 {
        let index = home + step * i;
        if !in_bitmap(index) || !exists(index) {
            break;
        }
        out.push(index);
    }
    out
}

/// Every array a quote might need, in *either* direction.
///
/// `Amm::get_accounts_to_update` runs before the swap direction is known, so
/// it has to fetch both ways: `home - (reach - 1) ..= home + (reach - 1)`.
pub fn arrays_to_fetch(active_id: i32, exists: impl Fn(i32) -> bool, reach: usize) -> Vec<i32> {
    let home = bin_array_index(active_id);
    let span = reach as i32 - 1;
    (home - span..=home + span)
        .filter(|index| in_bitmap(*index) && exists(*index))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_walk_stops_at_the_first_gap() {
        // Arrays 0 and -2 exist, -1 does not. A downward walk from bin 0 can
        // only ever reach array 0.
        let exists = |i: i32| i == 0 || i == -2;
        assert_eq!(swap_array_indexes(0, true, exists, 3), vec![0]);
        // Upward from the same bin there is nothing past the home array.
        assert_eq!(swap_array_indexes(0, false, exists, 3), vec![0]);
    }

    #[test]
    fn a_walk_carries_the_arrays_in_travel_order() {
        let exists = |_: i32| true;
        assert_eq!(swap_array_indexes(0, true, exists, REACH), vec![0, -1]);
        assert_eq!(swap_array_indexes(0, false, exists, REACH), vec![0, 1]);
    }

    #[test]
    fn fetching_covers_both_directions() {
        assert_eq!(arrays_to_fetch(0, |_| true, REACH), vec![-1, 0, 1]);
        // A gap is skipped here rather than ending the list: which side the
        // swap will travel is not known yet, so both are collected.
        assert_eq!(arrays_to_fetch(0, |i| i != -1, REACH), vec![0, 1]);
    }

    #[test]
    fn the_bitmap_bounds_the_reach() {
        let last = MAX_BIN_ARRAY_INDEX;
        let top_bin = bin_array_lower_bin_id(last);
        assert_eq!(
            swap_array_indexes(top_bin, false, |_| true, 3),
            vec![last],
            "nothing exists above the bitmap"
        );
    }
}
