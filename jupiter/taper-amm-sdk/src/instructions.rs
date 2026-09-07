//! Building the swap instruction.
//!
//! The account order is ABI and mirrors `sdk/src/instructions.ts`. Two details
//! are easy to get wrong and are both deliberate:
//!
//! - the mints and the token programs are named **by side**, X then Y, not by
//!   direction. The program picks in and out itself, so the account list does
//!   not change when `swap_for_y` does;
//! - the bin arrays are `remaining_accounts`, in the order the walk will visit
//!   them. [`crate::pda::swap_array_indexes`] produces that order.

use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use crate::state::{Pool, PoolKeys};
use crate::TAPER_AMM_ID;

/// `sha256("global:swap")[..8]`.
pub const SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];
/// `sha256("global:swap_strict")[..8]`.
pub const SWAP_STRICT_DISCRIMINATOR: [u8; 8] = [15, 167, 210, 168, 62, 143, 10, 227];

/// Everything the swap accounts are built from.
#[derive(Debug, Clone, Copy)]
pub struct SwapAccounts {
    pub user: Pubkey,
    pub pool: Pubkey,
    pub user_token_in: Pubkey,
    pub user_token_out: Pubkey,
}

/// The 11 fixed metas, then one per bin array.
///
/// This is what `Amm::get_swap_and_account_metas` hands back, so it is kept
/// separate from [`swap_instruction`]: Jupiter builds the CPI itself and wants
/// the metas alone.
pub fn swap_account_metas(
    accounts: &SwapAccounts,
    pool: &Pool,
    bin_arrays: &[Pubkey],
) -> Vec<AccountMeta> {
    let keys = PoolKeys::of(pool);
    let (program_x, program_y) = crate::state::token_programs(pool);

    let mut metas = Vec::with_capacity(FIXED_ACCOUNTS + bin_arrays.len());
    metas.push(AccountMeta::new_readonly(accounts.user, true));
    metas.push(AccountMeta::new(accounts.pool, false));
    metas.push(AccountMeta::new_readonly(keys.config, false));
    metas.push(AccountMeta::new_readonly(keys.token_x_mint, false));
    metas.push(AccountMeta::new_readonly(keys.token_y_mint, false));
    metas.push(AccountMeta::new(accounts.user_token_in, false));
    metas.push(AccountMeta::new(accounts.user_token_out, false));
    metas.push(AccountMeta::new(keys.reserve_x, false));
    metas.push(AccountMeta::new(keys.reserve_y, false));
    metas.push(AccountMeta::new_readonly(program_x, false));
    metas.push(AccountMeta::new_readonly(program_y, false));
    metas.extend(
        bin_arrays
            .iter()
            .map(|array| AccountMeta::new(*array, false)),
    );
    metas
}

/// Accounts a swap names before the bin arrays.
pub const FIXED_ACCOUNTS: usize = 11;

fn swap_data(discriminator: [u8; 8], amount_in: u64, min_amount_out: u64, swap_for_y: bool) -> Vec<u8> {
    let mut data = Vec::with_capacity(8 + 8 + 8 + 1);
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_amount_out.to_le_bytes());
    data.push(swap_for_y as u8);
    data
}

/// A complete `swap`, for a caller that is not Jupiter.
///
/// `amount_in` and `min_amount_out` are both quoted at the caller's wallet:
/// what leaves it and what must reach it. On a transfer-fee mint neither
/// equals what the ladder trades.
pub fn swap_instruction(
    accounts: &SwapAccounts,
    pool: &Pool,
    bin_arrays: &[Pubkey],
    amount_in: u64,
    min_amount_out: u64,
    swap_for_y: bool,
) -> Instruction {
    Instruction {
        program_id: TAPER_AMM_ID,
        accounts: swap_account_metas(accounts, pool, bin_arrays),
        data: swap_data(SWAP_DISCRIMINATOR, amount_in, min_amount_out, swap_for_y),
    }
}

/// The same swap, all or nothing: it reverts rather than filling partially.
///
/// Byte for byte identical to [`swap_instruction`] but for the discriminator.
pub fn swap_strict_instruction(
    accounts: &SwapAccounts,
    pool: &Pool,
    bin_arrays: &[Pubkey],
    amount_in: u64,
    min_amount_out: u64,
    swap_for_y: bool,
) -> Instruction {
    Instruction {
        program_id: TAPER_AMM_ID,
        accounts: swap_account_metas(accounts, pool, bin_arrays),
        data: swap_data(
            SWAP_STRICT_DISCRIMINATOR,
            amount_in,
            min_amount_out,
            swap_for_y,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminators_are_the_anchor_derivation() {
        use sha2::{Digest, Sha256};
        for (name, actual) in [
            ("swap", SWAP_DISCRIMINATOR),
            ("swap_strict", SWAP_STRICT_DISCRIMINATOR),
        ] {
            let digest = Sha256::digest(format!("global:{name}").as_bytes());
            assert_eq!(actual, digest[..8], "{name}");
        }
    }

    #[test]
    fn the_two_instructions_differ_only_in_their_discriminator() {
        let loose = swap_data(SWAP_DISCRIMINATOR, 1_000, 900, true);
        let strict = swap_data(SWAP_STRICT_DISCRIMINATOR, 1_000, 900, true);
        assert_eq!(loose[8..], strict[8..]);
        assert_ne!(loose[..8], strict[..8]);
    }

    #[test]
    fn the_data_is_little_endian_and_seventeen_bytes_past_the_discriminator() {
        let data = swap_data(SWAP_DISCRIMINATOR, 1, 2, false);
        assert_eq!(data.len(), 8 + 17);
        assert_eq!(&data[8..16], &1u64.to_le_bytes());
        assert_eq!(&data[16..24], &2u64.to_le_bytes());
        assert_eq!(data[24], 0);
    }
}
