//! Protocol-wide constants.
//!
//! Everything price-related is Q64.64 (`u128`, 64 fractional bits). Log2
//! prices are *signed* Q64.64 (`i128`), because bins below the anchor have a
//! negative log price.

/// Number of fractional bits in the fixed-point representation.
pub const SCALE_OFFSET: u32 = 64;
/// 1.0 in Q64.64.
pub const ONE_Q64: u128 = 1u128 << SCALE_OFFSET;

/// Bins per `BinArray` account.
pub const MAX_BIN_PER_ARRAY: usize = 70;

/// Bins whose per-bin data sits *inline* in the `Position` struct.
///
/// The struct is a fixed-size `Pod` and this is the length of its two arrays,
/// so it is also the minimum a position account can be. Bins past it live in
/// `PositionBinData` records appended to the same account, which is what
/// leaves every byte offset below this point unchanged.
pub const INLINE_BINS_PER_POSITION: usize = 70;

/// Widest band a single `Position` may declare.
///
/// At [`POSITION_BIN_DATA_SIZE`] a bin, a full-width position is about 89 KB
/// and 0.63 SOL of rent, so this is a ceiling rather than a target. It is
/// DLMM's number, which is a useful thing for a client that supports both.
pub const MAX_BIN_PER_POSITION: usize = 1_400;

/// Bytes one bin past the inline block costs: a `u128` share plus a
/// `PositionBinFee`.
pub const POSITION_BIN_DATA_SIZE: usize = 64;

/// Bins one `resize_position` may add. Shrinking is uncapped.
///
/// The runtime caps an account's growth at 10,240 bytes per transaction,
/// measured against its length when the transaction began — so this is a
/// *per transaction* limit, and two extends in one transaction still add at
/// most this many bins between them.
pub const MAX_BINS_PER_EXTEND: usize = 160;

/// Basis-point denominator.
pub const BASIS_POINT_MAX: u128 = 10_000;
/// Fee rates are expressed against this denominator: 10_000_000 == 1%.
pub const FEE_PRECISION: u128 = 1_000_000_000;
/// Hard ceiling on the total swap fee: 10%.
pub const MAX_FEE_RATE: u128 = 100_000_000;
/// Ceiling on the protocol's cut of the trading fee: 25%.
pub const MAX_PROTOCOL_SHARE: u16 = 2_500;

/// Bin widths are stored in hundredths of a basis point (1 unit == 1e-6).
pub const STEP_UNITS_PER_ONE: u128 = 1_000_000;
/// Narrowest bin the ladder may produce: 0.01 bps.
pub const MIN_STEP_BP_X100: u32 = 1;
/// Widest bin the ladder may produce: 400 bps, matching DLMM's `bin_step` cap.
pub const MAX_STEP_BP_X100: u32 = 40_000;

/// The pool bitmap covers bin-array indexes in `-512..512`.
pub const BIN_ARRAY_BITMAP_BITS: i32 = 1024;
pub const BIN_ARRAY_BITMAP_WORDS: usize = 16;
/// Bin-array index bounds implied by the bitmap.
pub const MIN_BIN_ARRAY_INDEX: i32 = -(BIN_ARRAY_BITMAP_BITS / 2);
pub const MAX_BIN_ARRAY_INDEX: i32 = BIN_ARRAY_BITMAP_BITS / 2 - 1;

/// Bin ids reachable through the bitmap. Configs narrow this further.
pub const HARD_MIN_BIN_ID: i32 = MIN_BIN_ARRAY_INDEX * MAX_BIN_PER_ARRAY as i32;
pub const HARD_MAX_BIN_ID: i32 = (MAX_BIN_ARRAY_INDEX + 1) * MAX_BIN_PER_ARRAY as i32 - 1;

/// Most bins one swap may walk before giving up, to bound compute.
pub const MAX_BINS_PER_SWAP: usize = 200;

// ---- PDA seeds ----
pub const CONFIG_SEED: &[u8] = b"config";
pub const POOL_SEED: &[u8] = b"pool";
pub const BIN_ARRAY_SEED: &[u8] = b"bin_array";
// A position has no seed: it is a plain keypair account, because its band
// moves and there is nothing else about it worth encoding in an address.
pub const RESERVE_SEED: &[u8] = b"reserve";
