//! # `taper-core` — the ladder, the fee schedule, and the account layouts
//!
//! Everything `taper-amm` computes, with none of what it needs to be a Solana
//! program. There is exactly one non-dev dependency, `bytemuck`, and no
//! `anchor-lang`, `solana-program` or `solana-pubkey` unless the optional
//! `anchor` feature is on.
//!
//! That is the whole point of the crate. A Jupiter AMM implementation pins its
//! own Agave tree, and `anchor-lang` 0.31 pins a different one; a crate that
//! depends on neither can be shared by both. So the swap walk, the price
//! ladder and the byte layouts live here and are **moved, not copied** —
//! `taper-amm` re-exports every one of them, and there is still only one
//! `Ladder::price` in existence.
//!
//! ```text
//!   w(i) = w0 * tau^i                     bin width, in log2 price
//!   v(i) = w0 * (1 - tau^i) / (1 - tau)   log2 price of bin i
//!   P(i) = 2^v(i)                         Q64.64, anchored at P(0) = 1.0
//! ```
//!
//! Two things differ from the program crate they came from, and nothing else:
//!
//! - errors are [`CoreError`], which carries names but no numbers — the
//!   discriminants are ABI and stay in `taper_amm::errors::TaperError`;
//! - public keys are `[u8; 32]`. `Pubkey` is `#[repr(transparent)]` over
//!   exactly that, so no byte of any account moved.
//!
//! The `anchor` feature adds the `ZeroCopy`, `Owner` and `Discriminator` impls
//! that `AccountLoader` needs. They live here rather than in `taper-amm`
//! because the orphan rule puts them here: the trait and the type would
//! otherwise both be foreign.

#![allow(unexpected_cfgs)]

pub mod constants;
pub mod errors;
pub mod math;
pub mod state;

pub use errors::{CoreError, Result};

#[cfg(feature = "anchor")]
pub mod anchor_support;

/// `taper-amm`'s program id, which the `Owner` impls answer with.
///
/// It is a second place the address is pinned, so
/// `scripts/set-program-id.ps1` names this file and
/// `taper_amm::errors::tests::core_agrees_with_this_program_id` asserts the
/// two agree.
#[cfg(feature = "anchor")]
pub use anchor_support::ID;
