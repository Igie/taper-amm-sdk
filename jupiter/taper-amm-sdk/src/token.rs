//! The transfer fee a mint charges, read straight from its account bytes.
//!
//! A `TransferFeeConfig` mint delivers less than it is sent, and the program
//! books it that way: reserves are credited with what *arrives* and a swap's
//! `min_amount_out` is checked against what *reaches* the trader. A quote that
//! ignored the fee would be wrong at both ends, and wrong by more than the
//! slippage tolerance that is supposed to absorb it.
//!
//! The extension is parsed by hand rather than by depending on
//! `spl-token-2022`. That crate pulls in a `solana-program` tree of its own,
//! which is the collision this whole crate exists to avoid — and the layout
//! being read is fifteen bytes of TLV that has been stable since the program
//! shipped. [`TransferFee`]'s arithmetic is ported from
//! `spl_token_2022::extension::transfer_fee`, and
//! `pre_fee_delivers_at_least_what_was_asked_for` is the check that the port
//! is faithful.

/// Basis-point denominator, as Token-2022 spells it.
const ONE_IN_BASIS_POINTS: u128 = 10_000;

/// Token-2022 lays a mint out as the 82-byte base, padding to 165, one byte of
/// account type, then TLV entries.
const ACCOUNT_TYPE_INDEX: usize = 165;
const TLV_START: usize = 166;
/// `AccountType::Mint`.
const ACCOUNT_TYPE_MINT: u8 = 1;
/// `ExtensionType::TransferFeeConfig`.
const EXTENSION_TRANSFER_FEE_CONFIG: u16 = 1;

/// `epoch: u64`, `maximum_fee: u64`, `transfer_fee_basis_points: u16`.
const TRANSFER_FEE_LEN: usize = 18;

/// One of a mint's two fee schedules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TransferFee {
    pub epoch: u64,
    pub maximum_fee: u64,
    pub transfer_fee_basis_points: u16,
}

impl TransferFee {
    fn ceil_div(numerator: u128, denominator: u128) -> Option<u128> {
        numerator
            .checked_add(denominator.checked_sub(1)?)?
            .checked_div(denominator)
    }

    /// The fee withheld from a transfer of `pre_fee_amount`.
    pub fn calculate_fee(&self, pre_fee_amount: u64) -> Option<u64> {
        let bps = self.transfer_fee_basis_points as u128;
        if bps == 0 || pre_fee_amount == 0 {
            return Some(0);
        }
        let numerator = (pre_fee_amount as u128).checked_mul(bps)?;
        let raw: u64 = Self::ceil_div(numerator, ONE_IN_BASIS_POINTS)?
            .try_into()
            .ok()?;
        Some(raw.min(self.maximum_fee))
    }

    /// What arrives when `pre_fee_amount` is sent.
    pub fn calculate_post_fee_amount(&self, pre_fee_amount: u64) -> Option<u64> {
        pre_fee_amount.checked_sub(self.calculate_fee(pre_fee_amount)?)
    }

    /// What must be sent for `post_fee_amount` to arrive.
    ///
    /// Not a clean inverse: rounding makes several inputs land on the same
    /// output, and this picks the smallest of them — which is what Token-2022
    /// does, and therefore what the program's `to_send` does.
    pub fn calculate_pre_fee_amount(&self, post_fee_amount: u64) -> Option<u64> {
        let bps = self.transfer_fee_basis_points as u128;
        match (bps, post_fee_amount) {
            (0, _) => Some(post_fee_amount),
            (_, 0) => Some(0),
            (ONE_IN_BASIS_POINTS, _) => self.maximum_fee.checked_add(post_fee_amount),
            _ => {
                let numerator = (post_fee_amount as u128).checked_mul(ONE_IN_BASIS_POINTS)?;
                let denominator = ONE_IN_BASIS_POINTS.checked_sub(bps)?;
                let raw = Self::ceil_div(numerator, denominator)?;
                if raw.checked_sub(post_fee_amount as u128)? >= self.maximum_fee as u128 {
                    post_fee_amount.checked_add(self.maximum_fee)
                } else {
                    u64::try_from(raw).ok()
                }
            }
        }
    }
}

/// The fee in force for a given epoch, or none at all.
///
/// `None` covers an SPL Token mint and a Token-2022 mint without the
/// extension alike, and makes every method the identity — so a caller never
/// branches on the token program, exactly as `instructions/token.rs` does not.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TransferFeeQuote(Option<TransferFee>);

impl TransferFeeQuote {
    pub const NONE: Self = Self(None);

    /// Reads the schedule in force at `epoch` from a mint account's bytes.
    ///
    /// A `TransferFeeConfig` carries *two* schedules and switches between them
    /// at an epoch boundary, which is why the epoch is a parameter and why
    /// this cannot be resolved once and cached on the pool.
    pub fn of_mint(data: &[u8], owner_is_token_2022: bool, epoch: u64) -> Self {
        if !owner_is_token_2022 {
            return Self::NONE;
        }
        match transfer_fee_config(data) {
            Some((older, newer)) => Self(Some(if epoch >= newer.epoch { newer } else { older })),
            None => Self::NONE,
        }
    }

    pub fn fee(&self) -> Option<TransferFee> {
        self.0
    }

    /// What actually arrives when `amount` is sent.
    pub fn received(&self, amount: u64) -> Option<u64> {
        match self.0 {
            None => Some(amount),
            Some(fee) => fee.calculate_post_fee_amount(amount),
        }
    }

    /// What must be sent for `amount` to arrive.
    pub fn to_send(&self, amount: u64) -> Option<u64> {
        match self.0 {
            None => Some(amount),
            Some(fee) => fee.calculate_pre_fee_amount(amount),
        }
    }
}

fn read_u64(data: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(data[at..at + 8].try_into().expect("8 bytes"))
}

fn read_u16(data: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(data[at..at + 2].try_into().expect("2 bytes"))
}

fn read_transfer_fee(data: &[u8], at: usize) -> TransferFee {
    TransferFee {
        epoch: read_u64(data, at),
        maximum_fee: read_u64(data, at + 8),
        transfer_fee_basis_points: read_u16(data, at + 16),
    }
}

/// Walks the mint's TLV for `TransferFeeConfig`, returning `(older, newer)`.
///
/// Everything about the walk fails closed: a mint with no extensions, a
/// truncated entry, or a length that does not cover the struct all read as "no
/// transfer fee", which is the same answer a plain SPL Token mint gives.
fn transfer_fee_config(data: &[u8]) -> Option<(TransferFee, TransferFee)> {
    if data.len() <= TLV_START || data[ACCOUNT_TYPE_INDEX] != ACCOUNT_TYPE_MINT {
        return None;
    }
    let mut cursor = TLV_START;
    while cursor + 4 <= data.len() {
        let extension = read_u16(data, cursor);
        let length = read_u16(data, cursor + 2) as usize;
        let body = cursor + 4;
        if body + length > data.len() {
            return None;
        }
        if extension == EXTENSION_TRANSFER_FEE_CONFIG {
            // 32 authority, 32 authority, 8 withheld, then the two schedules.
            let older = 72;
            let newer = older + TRANSFER_FEE_LEN;
            if length < newer + TRANSFER_FEE_LEN {
                return None;
            }
            let extension_data = &data[body..body + length];
            return Some((
                read_transfer_fee(extension_data, older),
                read_transfer_fee(extension_data, newer),
            ));
        }
        cursor = body + length;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fee(bps: u16, maximum_fee: u64) -> TransferFee {
        TransferFee {
            epoch: 0,
            maximum_fee,
            transfer_fee_basis_points: bps,
        }
    }

    #[test]
    fn no_fee_is_the_identity() {
        let none = TransferFeeQuote::NONE;
        assert_eq!(none.received(1_000), Some(1_000));
        assert_eq!(none.to_send(1_000), Some(1_000));
    }

    #[test]
    fn a_fee_rounds_up_against_the_sender() {
        // 1 bp of 1,001 is 0.1001, and Token-2022 takes the ceiling.
        assert_eq!(fee(1, u64::MAX).calculate_fee(1_001), Some(1));
        assert_eq!(fee(100, u64::MAX).calculate_post_fee_amount(1_000), Some(990));
    }

    #[test]
    fn the_maximum_caps_the_fee() {
        assert_eq!(fee(10_000, 5).calculate_fee(1_000), Some(5));
        assert_eq!(fee(10_000, 5).calculate_post_fee_amount(1_000), Some(995));
    }

    /// The property the program leans on: send what `to_send` says and at
    /// least the requested amount arrives. Never less — a shortfall would be
    /// owed by the reserve rather than by the trader.
    #[test]
    fn pre_fee_delivers_at_least_what_was_asked_for() {
        let mut checked = 0;
        for bps in [0u16, 1, 30, 250, 5_000, 9_999, 10_000] {
            for maximum_fee in [0u64, 1, 1_000, u64::MAX] {
                let f = fee(bps, maximum_fee);
                for wanted in [1u64, 7, 999, 1_000, 123_456, 1_000_000_000] {
                    // `None` is a real answer, not a failure: no `u64` grosses
                    // up to `wanted` under this schedule. Token-2022 says so
                    // too, and the program propagates it as an overflow.
                    let Some(send) = f.calculate_pre_fee_amount(wanted) else {
                        continue;
                    };
                    let arrives = f.calculate_post_fee_amount(send).expect("post fee");
                    assert!(
                        arrives >= wanted,
                        "bps {bps} max {maximum_fee}: sending {send} for {wanted} delivered {arrives}"
                    );
                    checked += 1;
                }
            }
        }
        assert!(checked > 100, "the sweep should mostly have real answers");
    }

    /// The one case that has no answer, pinned so the `None` above is a known
    /// shape and not a silently widening hole: at a 100% fee the sender must
    /// cover the maximum on top, and that can overflow.
    #[test]
    fn a_full_fee_with_no_headroom_has_no_pre_fee_amount() {
        assert_eq!(fee(10_000, u64::MAX).calculate_pre_fee_amount(1), None);
        assert_eq!(fee(10_000, 1_000).calculate_pre_fee_amount(1), Some(1_001));
    }

    /// A mint account with a `TransferFeeConfig`, laid out the way Token-2022
    /// writes one.
    fn mint_with_transfer_fee(older: TransferFee, newer: TransferFee) -> Vec<u8> {
        let mut data = vec![0u8; TLV_START];
        data[ACCOUNT_TYPE_INDEX] = ACCOUNT_TYPE_MINT;
        let length = 72 + TRANSFER_FEE_LEN * 2;
        data.extend_from_slice(&EXTENSION_TRANSFER_FEE_CONFIG.to_le_bytes());
        data.extend_from_slice(&(length as u16).to_le_bytes());
        let body = data.len();
        data.resize(body + length, 0);
        for (at, f) in [(72, older), (72 + TRANSFER_FEE_LEN, newer)] {
            data[body + at..body + at + 8].copy_from_slice(&f.epoch.to_le_bytes());
            data[body + at + 8..body + at + 16].copy_from_slice(&f.maximum_fee.to_le_bytes());
            data[body + at + 16..body + at + 18]
                .copy_from_slice(&f.transfer_fee_basis_points.to_le_bytes());
        }
        data
    }

    #[test]
    fn the_epoch_picks_the_schedule() {
        let older = TransferFee {
            epoch: 0,
            maximum_fee: u64::MAX,
            transfer_fee_basis_points: 100,
        };
        let newer = TransferFee {
            epoch: 500,
            maximum_fee: u64::MAX,
            transfer_fee_basis_points: 200,
        };
        let data = mint_with_transfer_fee(older, newer);

        assert_eq!(
            TransferFeeQuote::of_mint(&data, true, 499).fee(),
            Some(older),
            "before the switch"
        );
        assert_eq!(
            TransferFeeQuote::of_mint(&data, true, 500).fee(),
            Some(newer),
            "on the switch"
        );
    }

    #[test]
    fn an_spl_token_mint_never_charges_a_fee() {
        // Even handed bytes that would parse as a fee config, the owner
        // decides: only Token-2022 has extensions at all.
        let data = mint_with_transfer_fee(fee(100, u64::MAX), fee(100, u64::MAX));
        assert_eq!(TransferFeeQuote::of_mint(&data, false, 0), TransferFeeQuote::NONE);
    }

    #[test]
    fn a_mint_without_the_extension_reads_as_no_fee() {
        assert_eq!(
            TransferFeeQuote::of_mint(&[0u8; 82], true, 0),
            TransferFeeQuote::NONE,
            "a bare mint has no TLV at all"
        );
        let mut only_metadata = vec![0u8; TLV_START];
        only_metadata[ACCOUNT_TYPE_INDEX] = ACCOUNT_TYPE_MINT;
        only_metadata.extend_from_slice(&18u16.to_le_bytes()); // MetadataPointer
        only_metadata.extend_from_slice(&64u16.to_le_bytes());
        only_metadata.resize(only_metadata.len() + 64, 0);
        assert_eq!(
            TransferFeeQuote::of_mint(&only_metadata, true, 0),
            TransferFeeQuote::NONE,
            "an unrelated extension is walked past"
        );
    }

    #[test]
    fn a_truncated_extension_reads_as_no_fee() {
        let mut data = mint_with_transfer_fee(fee(100, u64::MAX), fee(100, u64::MAX));
        data.truncate(data.len() - 4);
        assert_eq!(TransferFeeQuote::of_mint(&data, true, 0), TransferFeeQuote::NONE);
    }
}
