//! The failure modes of the ladder, the fee schedule and the state structs.
//!
//! Two enums are generated from one list. [`CoreError`] is what this crate
//! returns and carries no dependency on Anchor; `taper_amm::errors::TaperError`
//! is the `#[error_code]` enum the program returns, and it is what puts the
//! numbers and the messages on chain and in the IDL.
//!
//! They are generated from [`taper_error_table!`] rather than written twice.
//! The plan for this split called for the two to be bridged by a hand-written
//! match in the program crate, but that impl cannot exist there: `From` is
//! foreign, `anchor_lang::error::Error` is foreign, and `CoreError` would be
//! foreign too, so the orphan rule refuses it. The impl has to live beside
//! `CoreError`, which means this crate has to know the numbering — and a
//! second hand-maintained copy of thirty-two names, positions and messages is
//! exactly the drift this codebase is built to avoid. Hence one table, two
//! expansions, and `variant_order_is_the_error_numbering` to pin the invariant
//! that makes it sound.

/// The error list: name, then the message the client sees.
///
/// **Append, never reorder.** A variant's *position* is its error number —
/// `6000 + index`, as `#[error_code]` assigns them — so moving one renumbers
/// every error after it, and the numbers are ABI.
///
/// Expanded twice: once here into [`CoreError`], and once in
/// `taper_amm::errors` into the `#[error_code]` enum. Pass the name of a macro
/// that accepts `Name, "message";` repetitions.
#[macro_export]
macro_rules! taper_error_table {
    ($emit:ident) => {
        $emit! {
            MathOverflow, "Arithmetic overflow";
            DivideByZero, "Division by zero";
            PriceOutOfRange, "Price is outside the representable Q64.64 range";
            BinIdOutOfRange, "Bin id is outside the config's supported range";
            InvalidTaper, "Taper factor must be in (MIN_TAPER, 1.0]";
            InvalidBaseWidth, "Base bin width produces a step outside [0.01 bps, 400 bps]";
            InvalidBinRange, "Bin width at the range bounds is outside [0.01 bps, 400 bps]";
            InvalidFeeParameters, "Invalid fee parameters";
            InvalidProtocolShare, "Protocol share exceeds the 25% cap";
            InvalidMintOrder, "Token mints must be distinct and sorted";
            InvalidBinArrayIndex, "Bin array index does not match the bin ids it must cover";
            BinArrayPoolMismatch, "Bin array does not belong to this pool";
            MissingBinArray, "A bin array required by this operation was not supplied";
            PositionTooWide, "Position range is wider than a position can hold";
            BinIdOutsidePosition, "Bin id lies outside the position's range";
            InvalidDistribution, "Liquidity distribution must sum to at most 10_000 bps per side";
            DepositXBelowActiveBin, "Cannot deposit token X into a bin below the active bin";
            DepositYAboveActiveBin, "Cannot deposit token Y into a bin above the active bin";
            ZeroLiquidity, "Deposit produced zero liquidity shares";
            InsufficientLiquidity, "Insufficient liquidity to fill the swap";
            SlippageExceeded, "Swap output is below the caller's minimum";
            ZeroAmount, "Swap amount must be greater than zero";
            PositionNotEmpty, "Position still holds liquidity, fees or rewards";
            PoolDisabled, "Pool is disabled for this operation";
            UnauthorizedPositionOwner, "Caller is not the position owner";
            UnauthorizedAuthority, "Caller is not the config authority";
            SwapBinLimitExceeded, "Swap walked more bins than one instruction allows";
            BinArrayNotEmpty, "Bin array is not empty and cannot be closed";
            UnsupportedMintExtension, "Mint carries a Token-2022 extension this pool does not support";
            TokenProgramMismatch, "Token program does not own the mint it was passed for";
            BinRangeExceedsBitmap, "Config bin range reaches past the bin ids the pool bitmap can cover";
            BandMayOnlyWiden, "A config's bin range may only be widened, never narrowed";
        }
    };
}

macro_rules! define_core_error {
    ($($variant:ident, $message:literal;)*) => {
        /// What can go wrong below the instruction layer.
        ///
        /// `#[repr(u32)]` is load-bearing: `self as u32` is the variant's
        /// position, which is the error number Anchor assigns to the matching
        /// `TaperError` variant, offset by `ERROR_CODE_OFFSET`.
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        #[repr(u32)]
        pub enum CoreError {
            $($variant),*
        }

        impl CoreError {
            /// Every variant, in declaration order. Only tests need it.
            pub const ALL: &'static [CoreError] = &[$(CoreError::$variant),*];

            pub const fn name(self) -> &'static str {
                match self {
                    $(CoreError::$variant => stringify!($variant)),*
                }
            }

            /// The `#[msg(..)]` text of the matching `TaperError` variant.
            pub const fn message(self) -> &'static str {
                match self {
                    $(CoreError::$variant => $message),*
                }
            }
        }
    };
}

taper_error_table!(define_core_error);

impl core::fmt::Display for CoreError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.message())
    }
}

/// Lifts a [`CoreError`] into the numbered error the program returns.
///
/// This is what keeps `?` working unchanged throughout `taper_amm`'s
/// `instructions/` now that the math and the state live here. It reproduces
/// what `#[error_code]` generates for `TaperError` — the same name, the same
/// number, the same message, and so the same `Error Code / Error Number /
/// Error Message` line in the logs. Only the source location differs, since
/// this conversion has no `#[track_caller]` site to report.
#[cfg(feature = "anchor")]
impl From<CoreError> for anchor_lang::error::Error {
    fn from(error: CoreError) -> Self {
        anchor_lang::error::AnchorError {
            error_name: error.name().to_string(),
            error_code_number: error as u32 + anchor_lang::error::ERROR_CODE_OFFSET,
            error_msg: error.message().to_string(),
            error_origin: None,
            compared_values: None,
        }
        .into()
    }
}

/// The crate's result type.
///
/// Deliberately shaped like `anchor_lang::Result<T>`, so that every function
/// moved out of the program crate kept its signature verbatim rather than
/// growing a second type parameter at each of a hundred call sites.
pub type Result<T> = core::result::Result<T, CoreError>;

/// `require!(condition, CoreError::Variant)` — an early return when the
/// invariant does not hold.
///
/// The same shape as `anchor_lang::require!`, for the same reason [`Result`]
/// is: it is what let the ladder and the state structs move without their
/// bodies changing. It differs only in not attaching a source location, since
/// the location is logged by the program crate when the error crosses back
/// into Anchor.
#[macro_export]
macro_rules! require {
    ($invariant:expr, $error:expr $(,)?) => {
        if !($invariant) {
            return Err($error);
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `From` impl above turns a variant's position into its error number.
    /// That is only correct while the enum is a plain C-like `#[repr(u32)]`
    /// one whose first variant is zero — so this pins it rather than trusting
    /// it.
    #[test]
    fn variant_order_is_the_error_numbering() {
        for (index, error) in CoreError::ALL.iter().enumerate() {
            assert_eq!(*error as u32, index as u32, "{}", error.name());
        }
        assert_eq!(CoreError::MathOverflow as u32, 0);
        assert_eq!(CoreError::ALL.len(), 32);
    }

    #[test]
    fn every_variant_carries_a_name_and_a_message() {
        for error in CoreError::ALL {
            assert!(!error.name().is_empty());
            assert!(!error.message().is_empty(), "{}", error.name());
        }
    }
}
