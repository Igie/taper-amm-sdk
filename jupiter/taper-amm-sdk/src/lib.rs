//! Taper, from the outside.
//!
//! Everything a client needs to read a Taper pool and trade against it: the
//! PDAs, the account parsers, the swap quote and the instruction builders.
//! What it deliberately is *not* is a second implementation of the AMM — the
//! ladder, the fee schedule and the swap arithmetic all come from
//! [`taper_core`], the same code the on-chain program runs. There is one
//! `Ladder::price` in this repository and this crate calls it.
//!
//! That is the difference between this and a typical integration SDK, and it
//! is the reason [`quote`] can promise exactness rather than approximation:
//! the walk below is `instructions::swap` with the token transfers removed.
//!
//! No Anchor, and no dependency on the program crate. `cargo tree` for this
//! crate is `taper-core`, `bytemuck`, and the two `solana-*` crates that
//! define `Pubkey` and `Instruction`.

pub mod instructions;
pub mod pda;
pub mod quote;
pub mod state;
pub mod token;

pub use taper_core;

use solana_pubkey::Pubkey;

/// The `taper-amm` program.
pub const TAPER_AMM_ID: Pubkey =
    Pubkey::from_str_const("taperAJP7yuCyqnFUW3Xa3byvQ2YRY29w73NJrjYRUd");

/// SPL Token.
pub const SPL_TOKEN_ID: Pubkey =
    Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// Token-2022.
pub const TOKEN_2022_ID: Pubkey =
    Pubkey::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// A key stored in account state, as a `Pubkey`.
///
/// State holds `[u8; 32]` because `taper-core` has no `Pubkey` to hold;
/// `Pubkey` is `#[repr(transparent)]` over exactly those bytes, so this is a
/// rename and not a conversion.
pub const fn key(bytes: [u8; 32]) -> Pubkey {
    Pubkey::new_from_array(bytes)
}
