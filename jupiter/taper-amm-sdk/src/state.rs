//! Reading the program's accounts.
//!
//! The structs are `taper_core`'s — the same bytes the program writes — so
//! this module is only the discriminator check and the cast. Those eight-byte
//! discriminators are Anchor's `sha256("account:<Name>")[..8]` and they are
//! ABI; they are written down here for the same reason
//! `crates/taper-core/src/anchor_support.rs` writes them down, and a test
//! re-derives them from the struct names.

use bytemuck::Pod;
use solana_pubkey::Pubkey;

use crate::key;
pub use taper_core::state::{
    Bin, BinArray, CollectFeeMode, Config, Pool, PoolStatus, Position, PositionBinFee,
    TokenProgramFlag,
};

pub const CONFIG_DISCRIMINATOR: [u8; 8] = [155, 12, 170, 224, 30, 250, 204, 130];
pub const POOL_DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
pub const BIN_ARRAY_DISCRIMINATOR: [u8; 8] = [92, 142, 92, 220, 5, 148, 70, 181];
pub const POSITION_DISCRIMINATOR: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// Fewer bytes than the struct needs, discriminator included.
    TooShort { expected: usize, got: usize },
    /// Some other account type, or not a Taper account at all.
    WrongDiscriminator,
}

impl core::fmt::Display for ParseError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            ParseError::TooShort { expected, got } => {
                write!(f, "account is {got} bytes, expected at least {expected}")
            }
            ParseError::WrongDiscriminator => f.write_str("account discriminator does not match"),
        }
    }
}

impl std::error::Error for ParseError {}

/// Reads an account body past its discriminator.
///
/// Returns an owned copy rather than a borrow: every state struct is
/// `#[repr(C, packed)]` and `Copy`, and an owned value is what a quote needs
/// anyway, since the walk mutates as it goes.
/// Reads one account's fixed header.
///
/// The length check is `<`, not `!=`, and that matters for exactly one of
/// these types: a `Position` is 4,616 bytes of fixed struct plus one 64-byte
/// record per bin past the inline 70, so a wide one is *longer* than its
/// struct. Everything this crate needs from a position lives in the header,
/// so reading it and ignoring the tail is correct rather than merely
/// tolerant.
fn parse<T: Pod>(data: &[u8], discriminator: [u8; 8]) -> Result<T, ParseError> {
    let expected = 8 + core::mem::size_of::<T>();
    if data.len() < expected {
        return Err(ParseError::TooShort {
            expected,
            got: data.len(),
        });
    }
    if data[..8] != discriminator {
        return Err(ParseError::WrongDiscriminator);
    }
    // Unaligned on purpose: an account's bytes land wherever the RPC put them.
    // Every one of these structs is align-1, so this is a plain copy.
    Ok(bytemuck::pod_read_unaligned(&data[8..expected]))
}

pub fn parse_config(data: &[u8]) -> Result<Config, ParseError> {
    parse(data, CONFIG_DISCRIMINATOR)
}
pub fn parse_pool(data: &[u8]) -> Result<Pool, ParseError> {
    parse(data, POOL_DISCRIMINATOR)
}
pub fn parse_bin_array(data: &[u8]) -> Result<BinArray, ParseError> {
    parse(data, BIN_ARRAY_DISCRIMINATOR)
}
pub fn parse_position(data: &[u8]) -> Result<Position, ParseError> {
    parse(data, POSITION_DISCRIMINATOR)
}

/// A pool's keys, as `Pubkey`.
///
/// Bundled rather than offered as six accessors because every caller wants
/// most of them at once: building the swap account metas needs all but one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolKeys {
    pub config: Pubkey,
    pub token_x_mint: Pubkey,
    pub token_y_mint: Pubkey,
    pub reserve_x: Pubkey,
    pub reserve_y: Pubkey,
    pub creator: Pubkey,
}

impl PoolKeys {
    pub fn of(pool: &Pool) -> Self {
        Self {
            config: key(pool.config),
            token_x_mint: key(pool.token_x_mint),
            token_y_mint: key(pool.token_y_mint),
            reserve_x: key(pool.reserve_x),
            reserve_y: key(pool.reserve_y),
            creator: key(pool.creator),
        }
    }
}

/// Which token program owns each side, X then Y.
///
/// Cached on the pool precisely so a client can assemble an instruction from
/// the pool account alone, rather than fetching both mints to read their
/// owners. A pool may mix the two.
pub fn token_programs(pool: &Pool) -> (Pubkey, Pubkey) {
    let program = |flag: u8| {
        if flag == TokenProgramFlag::Token2022 as u8 {
            crate::TOKEN_2022_ID
        } else {
            crate::SPL_TOKEN_ID
        }
    };
    (program(pool.token_x_flag), program(pool.token_y_flag))
}

/// True when the pool accepts swaps. A disabled pool stays withdrawable.
pub fn is_enabled(pool: &Pool) -> bool {
    pool.status == PoolStatus::Enabled as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Anchor derives an account discriminator from the struct name. Deriving
    /// them again here is the guard that transcription did not go wrong — and
    /// that nobody renames a struct without noticing it is named on chain.
    #[test]
    fn discriminators_are_the_anchor_derivation() {
        use sha2::{Digest, Sha256};
        for (name, actual) in [
            ("Config", CONFIG_DISCRIMINATOR),
            ("Pool", POOL_DISCRIMINATOR),
            ("BinArray", BIN_ARRAY_DISCRIMINATOR),
            ("Position", POSITION_DISCRIMINATOR),
        ] {
            let digest = Sha256::digest(format!("account:{name}").as_bytes());
            assert_eq!(actual, digest[..8], "{name}");
        }
    }

    #[test]
    fn a_wrong_discriminator_is_an_error_not_a_misparse() {
        let mut data = vec![0u8; 8 + core::mem::size_of::<Pool>()];
        data[..8].copy_from_slice(&CONFIG_DISCRIMINATOR);
        // `matches!` rather than `assert_eq!`: `Pool` is a packed struct
        // with no `PartialEq`, so the `Result` cannot be compared whole.
        assert!(matches!(
            parse_pool(&data),
            Err(ParseError::WrongDiscriminator)
        ));
    }

    #[test]
    fn a_short_account_is_an_error_not_a_panic() {
        assert!(matches!(
            parse_pool(&[0u8; 16]),
            Err(ParseError::TooShort { .. })
        ));
    }

    /// The sizes clients read by offset. Frozen in the program by
    /// `account_sizes_are_frozen`; asserted again here because this crate is
    /// the one that will be forked out into its own repository.
    #[test]
    fn account_sizes_are_what_clients_expect() {
        assert_eq!(8 + core::mem::size_of::<Config>(), 168);
        assert_eq!(8 + core::mem::size_of::<Pool>(), 432);
        assert_eq!(8 + core::mem::size_of::<BinArray>(), 6792);
        // A *minimum* for this one: a position grows past its struct.
        assert_eq!(8 + core::mem::size_of::<Position>(), 4616);
    }

    /// A position wider than its inline block still parses.
    ///
    /// It is longer than the struct, which a length check written as `!=`
    /// would reject - and the whole point of appending rather than
    /// re-laying-out is that a client reading the header does not have to
    /// care.
    #[test]
    fn a_grown_position_parses_from_its_header() {
        let mut data = vec![0u8; 4616 + 130 * 64];
        data[..8].copy_from_slice(&POSITION_DISCRIMINATOR);
        data[4576..4580].copy_from_slice(&7i32.to_le_bytes());
        data[4580..4584].copy_from_slice(&206i32.to_le_bytes());

        let position = parse_position(&data).expect("a grown position");
        let (lower, upper) = (position.lower_bin_id, position.upper_bin_id);
        assert_eq!((lower, upper), (7, 206));
    }
}
