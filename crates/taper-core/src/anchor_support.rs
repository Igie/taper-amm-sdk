//! The Anchor traits `AccountLoader` needs, for the four account structs.
//!
//! These live here and not in `taper-amm` because of the orphan rule: with the
//! types moved into this crate, an impl in the program crate would have both
//! the trait and the type foreign. The `anchor` feature is what `taper-amm`
//! turns on; a Jupiter build takes the crate with default features and never
//! links `anchor-lang` at all.
//!
//! Two things are hand-written that the `#[account(zero_copy)]` macro used to
//! generate, and both are ABI:
//!
//! - the 8-byte discriminator, `sha256("account:<Name>")[..8]`. Spelling it
//!   out is the same choice `tests/src/lib.rs` and `sdk/src/constants.ts`
//!   already make for the instruction discriminators — the bytes are the
//!   interface, so they are written down rather than re-derived.
//! - the owner, which the macro read from `crate::ID`. This crate declares
//!   the same id, which makes the program address pinned in one more place
//!   than it was; `scripts/set-program-id.ps1` names this file, and
//!   `taper_amm::errors` asserts the two agree.
//!
//! What is *not* generated any more is the IDL entry for each account. The
//! generated IDL keeps its address, instructions, errors and every
//! instruction-argument type, but the four accounts and their nested types are
//! gone from it. Nothing in this repository reads the IDL — `sdk/` and
//! `tests/` both parse by byte offset — so the cost falls on an outside
//! Anchor client, which can still build every instruction but can no longer
//! decode an account with `program.account.pool.fetch()`.

use anchor_lang::prelude::{declare_id, Pubkey};
use anchor_lang::{Discriminator, Owner, ZeroCopy};

use crate::state::{BinArray, Config, Pool, Position};

declare_id!("taperAJP7yuCyqnFUW3Xa3byvQ2YRY29w73NJrjYRUd");

macro_rules! anchor_account {
    ($ty:ty, $disc:expr) => {
        impl Discriminator for $ty {
            const DISCRIMINATOR: &'static [u8] = &$disc;
        }
        impl Owner for $ty {
            fn owner() -> Pubkey {
                self::ID
            }
        }
        impl ZeroCopy for $ty {}
    };
}

anchor_account!(Config, [155, 12, 170, 224, 30, 250, 204, 130]);
anchor_account!(Pool, [241, 154, 109, 4, 17, 177, 109, 188]);
anchor_account!(BinArray, [92, 142, 92, 220, 5, 148, 70, 181]);
anchor_account!(Position, [170, 188, 143, 228, 122, 64, 247, 208]);

/// `#[derive(Accounts)]` requires this of every account type when the program
/// crate is built for IDL generation, and the build fails to compile without
/// it. The default methods are the whole implementation: they let the build
/// through and leave the type out of the IDL, which is the documented way to
/// say "this type has no IDL entry".
#[cfg(feature = "idl-build")]
mod idl {
    use super::*;
    use anchor_lang::IdlBuild;

    impl IdlBuild for Config {}
    impl IdlBuild for Pool {}
    impl IdlBuild for BinArray {}
    impl IdlBuild for Position {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::hash::hash;

    /// The discriminators above are what `#[account(zero_copy)]` used to
    /// derive. Re-deriving them here is the guard that transcribing them did
    /// not go wrong — and that nobody renames a struct without noticing the
    /// account type on chain is named too.
    #[test]
    fn discriminators_match_the_anchor_derivation() {
        for (name, actual) in [
            ("Config", Config::DISCRIMINATOR),
            ("Pool", Pool::DISCRIMINATOR),
            ("BinArray", BinArray::DISCRIMINATOR),
            ("Position", Position::DISCRIMINATOR),
        ] {
            let expected = &hash(format!("account:{name}").as_bytes()).to_bytes()[..8];
            assert_eq!(actual, expected, "{name}");
        }
    }
}
