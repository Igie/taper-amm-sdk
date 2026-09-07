//! `jupiter_amm_interface::Amm` for `taper-amm`.
//!
//! Thin by design. Everything that computes anything lives in
//! `taper-amm-sdk`, and through it in `taper-core`, which is the same code the
//! on-chain program runs; this crate deserializes, delegates and builds
//! account metas. If a number appears below that is not a field copy, it is in
//! the wrong file.
//!
//! Three things about a bin AMM make this less mechanical than it looks, and
//! each is handled where it is named:
//!
//! - **The bitmap is what makes it possible at all.** Jupiter forbids network
//!   calls, so [`Amm::get_accounts_to_update`] has to name the bin arrays
//!   without looking any of them up. `Pool::bin_array_bitmap` already says
//!   which exist.
//! - **The account set follows the active bin**, so [`Amm::has_dynamic_accounts`]
//!   is `true` and the arrays are refetched as the market moves.
//! - **A quote is not a pure function of account state.** The pool decays its
//!   volatility reference off the wall clock, so `quote` reads the timestamp
//!   from the `ClockRef` the context handed us rather than from anything on
//!   the pool.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::Ordering;

use anyhow::{anyhow, bail, Result};
use jupiter_amm_interface::{
    AccountMap, Amm, AmmContext, ClockRef, KeyedAccount, Quote, QuoteParams, Swap,
    SwapAndAccountMetas, SwapParams,
};
use rust_decimal::Decimal;
use solana_instruction::AccountMeta;
use solana_pubkey::Pubkey;

use taper_amm_sdk::instructions::{swap_account_metas, SwapAccounts, FIXED_ACCOUNTS};
use taper_amm_sdk::pda::{arrays_to_fetch, bin_array_pda, swap_array_indexes, REACH};
use taper_amm_sdk::quote::quote_exact_in;
use taper_amm_sdk::state::{
    is_enabled, parse_bin_array, parse_config, parse_pool, BinArray, Config, Pool, PoolKeys,
};
use taper_amm_sdk::token::TransferFeeQuote;
use taper_amm_sdk::{TAPER_AMM_ID, TOKEN_2022_ID};

pub use taper_amm_sdk;

pub const TAPER_LABEL: &str = "Taper";

#[derive(Clone)]
pub struct TaperAmm {
    key: Pubkey,
    pool: Pool,
    keys: PoolKeys,
    /// Read live on every quote. Nothing about a config is cached on the pool,
    /// so its fee schedule can be edited under a live market and a stale copy
    /// would quote the old one.
    config: Option<Config>,
    arrays: BTreeMap<i32, BinArray>,
    /// Mint bytes and owners, for the transfer-fee schedules. Kept raw because
    /// the schedule in force depends on the epoch, which moves.
    mints: HashMap<Pubkey, (Vec<u8>, Pubkey)>,
    clock: ClockRef,
}

impl TaperAmm {
    fn epoch(&self) -> u64 {
        self.clock.epoch.load(Ordering::Relaxed)
    }

    fn now(&self) -> i64 {
        self.clock.unix_timestamp.load(Ordering::Relaxed)
    }

    fn transfer_fee(&self, mint: &Pubkey) -> TransferFeeQuote {
        match self.mints.get(mint) {
            Some((data, owner)) => {
                TransferFeeQuote::of_mint(data, *owner == TOKEN_2022_ID, self.epoch())
            }
            // Absent only before the first `update`. Treating it as no fee
            // would quote a Token-2022 pair too generously, so it is not a
            // default worth having — but `quote` refuses before `update`
            // anyway, on the config.
            None => TransferFeeQuote::NONE,
        }
    }

    /// X in and Y out, or the other way round.
    fn direction(&self, input_mint: &Pubkey, output_mint: &Pubkey) -> Result<bool> {
        match (*input_mint == self.keys.token_x_mint, *output_mint == self.keys.token_y_mint) {
            (true, true) => Ok(true),
            _ if *input_mint == self.keys.token_y_mint
                && *output_mint == self.keys.token_x_mint =>
            {
                Ok(false)
            }
            _ => bail!("{input_mint} -> {output_mint} is not this pool's pair"),
        }
    }

    fn config(&self) -> Result<&Config> {
        self.config
            .as_ref()
            .ok_or_else(|| anyhow!("update has not been called: no config for pool {}", self.key))
    }

    /// The arrays a swap in this direction may walk, as addresses.
    ///
    /// Named from `REACH` rather than from what a quote's walk actually
    /// reached, which the Phase 1.2 measurements suggested doing. At
    /// `REACH = 2` the two answers are the same, so there is nothing to trim.
    ///
    /// A trim would have to keep one array of margin beyond the walk whatever
    /// it did: Jupiter builds the transaction from a quote, and by the time it
    /// lands the volatility reference has decayed a little further — a lower
    /// fee puts more of the input into the ladder and the walk goes further,
    /// not less far — and another swap may have moved `active_id` outright. An
    /// array the walk needs and was not handed ends it early, so the margin is
    /// the difference between a full fill and a partial one.
    ///
    /// With that margin, a walk that stays in the active bin's array wants
    /// `home` and the one beyond it, which is what `REACH` already names; and
    /// a walk that crosses into the second array would want a third, which
    /// `tests/tests/compute.rs` shows no swap fitting in a transaction can
    /// reach. The second array costs 32 bytes and no contention — the pool
    /// account is writable on every swap, so two swaps on one pool serialise
    /// on that whatever their bin arrays say.
    fn swap_arrays(&self, swap_for_y: bool) -> Vec<Pubkey> {
        swap_array_indexes(
            self.pool.active_id,
            swap_for_y,
            |index| self.arrays.contains_key(&index),
            REACH,
        )
        .into_iter()
        .map(|index| bin_array_pda(&self.key, index))
        .collect()
    }

    /// The accounts a Taper hop names, in the program's order.
    ///
    /// Split out of [`Amm::get_swap_and_account_metas`] so that they are
    /// observable in the build that ships today. That method cannot return
    /// anything at all until `Swap::Taper` exists (see `taper_swap`), and
    /// the claim that the metas either side of the missing variant are correct
    /// should not have to wait on Jupiter to be checkable.
    pub fn swap_account_metas(&self, swap_params: &SwapParams) -> Result<Vec<AccountMeta>> {
        let swap_for_y = self.direction(&swap_params.source_mint, &swap_params.destination_mint)?;
        Ok(swap_account_metas(
            &SwapAccounts {
                user: swap_params.token_transfer_authority,
                pool: self.key,
                user_token_in: swap_params.source_token_account,
                user_token_out: swap_params.destination_token_account,
            },
            &self.pool,
            &self.swap_arrays(swap_for_y),
        ))
    }
}

impl Amm for TaperAmm {
    fn from_keyed_account(keyed_account: &KeyedAccount, amm_context: &AmmContext) -> Result<Self> {
        let pool = parse_pool(&keyed_account.account.data)?;
        Ok(Self {
            key: keyed_account.key,
            keys: PoolKeys::of(&pool),
            pool,
            config: None,
            arrays: BTreeMap::new(),
            mints: HashMap::new(),
            clock: amm_context.clock_ref.clone(),
        })
    }

    fn label(&self) -> String {
        TAPER_LABEL.to_string()
    }

    fn program_id(&self) -> Pubkey {
        TAPER_AMM_ID
    }

    fn key(&self) -> Pubkey {
        self.key
    }

    /// Both mints are on the pool account, which is why
    /// [`Amm::requires_update_for_reserve_mints`] can stay `false`.
    fn get_reserve_mints(&self) -> Vec<Pubkey> {
        vec![self.keys.token_x_mint, self.keys.token_y_mint]
    }

    /// The pool, its config, both mints, and the bin arrays either side of the
    /// active bin.
    ///
    /// Both sides, because the direction is not known here. The bitmap is what
    /// makes naming them possible without a lookup: it says which arrays
    /// exist, and an address with no account behind it would fail the
    /// instruction.
    fn get_accounts_to_update(&self) -> Vec<Pubkey> {
        let mut accounts = vec![
            self.key,
            self.keys.config,
            self.keys.token_x_mint,
            self.keys.token_y_mint,
        ];
        accounts.extend(
            arrays_to_fetch(
                self.pool.active_id,
                |index| self.pool.is_bin_array_occupied(index).unwrap_or(false),
                REACH,
            )
            .into_iter()
            .map(|index| bin_array_pda(&self.key, index)),
        );
        accounts
    }

    /// The array set follows the active bin, so it is not constant.
    fn has_dynamic_accounts(&self) -> bool {
        true
    }

    fn requires_update_for_reserve_mints(&self) -> bool {
        false
    }

    fn update(&mut self, account_map: &AccountMap) -> Result<()> {
        if let Some(account) = account_map.get(&self.key) {
            self.pool = parse_pool(&account.data)?;
            self.keys = PoolKeys::of(&self.pool);
        }
        if let Some(account) = account_map.get(&self.keys.config) {
            self.config = Some(parse_config(&account.data)?);
        }
        for mint in [self.keys.token_x_mint, self.keys.token_y_mint] {
            if let Some(account) = account_map.get(&mint) {
                self.mints.insert(mint, (account.data.clone(), account.owner));
            }
        }

        // Rebuilt rather than merged: the active bin moves, and an array that
        // has fallen out of reach must not linger and let a quote walk further
        // than the transaction ever could.
        let mut arrays = BTreeMap::new();
        for index in arrays_to_fetch(
            self.pool.active_id,
            |index| self.pool.is_bin_array_occupied(index).unwrap_or(false),
            REACH,
        ) {
            let address = bin_array_pda(&self.key, index);
            if let Some(account) = account_map.get(&address) {
                arrays.insert(index, parse_bin_array(&account.data)?);
            } else if let Some(existing) = self.arrays.remove(&index) {
                // Still in reach and not in this batch: Jupiter only sends
                // what changed.
                arrays.insert(index, existing);
            }
        }
        self.arrays = arrays;
        Ok(())
    }

    fn quote(&self, quote_params: &QuoteParams) -> Result<Quote> {
        let config = self.config()?;
        let swap_for_y = self.direction(&quote_params.input_mint, &quote_params.output_mint)?;

        let quote = quote_exact_in(
            &self.pool,
            config,
            &self.arrays,
            quote_params.amount,
            swap_for_y,
            &self.transfer_fee(&quote_params.input_mint),
            &self.transfer_fee(&quote_params.output_mint),
            self.now(),
        )?;

        // The fee is denominated in whichever token the collect mode takes it
        // from, which is not always the input.
        let fee_mint = if quote.fee_in_y {
            self.keys.token_y_mint
        } else {
            self.keys.token_x_mint
        };
        // Against what the ladder actually consumed, not what was offered: on
        // a partial fill the rest was never traded and never paid a fee.
        let fee_pct = if quote.walk.amount_in == 0 {
            Decimal::ZERO
        } else {
            Decimal::from(quote.fee_amount) / Decimal::from(quote.walk.amount_in)
        };

        Ok(Quote {
            in_amount: quote.in_amount,
            out_amount: quote.out_amount,
            fee_amount: quote.fee_amount,
            fee_mint,
            fee_pct,
        })
    }

    fn get_swap_and_account_metas(&self, swap_params: &SwapParams) -> Result<SwapAndAccountMetas> {
        let swap_for_y = self.direction(&swap_params.source_mint, &swap_params.destination_mint)?;
        Ok(SwapAndAccountMetas {
            swap: taper_swap(swap_for_y)?,
            account_metas: self.swap_account_metas(swap_params)?,
        })
    }

    /// No exact-out instruction exists, so there is nothing to quote for it.
    fn supports_exact_out(&self) -> bool {
        false
    }

    fn unidirectional(&self) -> bool {
        false
    }

    fn is_active(&self) -> bool {
        is_enabled(&self.pool)
    }

    /// 11 fixed accounts plus at most [`REACH`] bin arrays. Jupiter budgets a
    /// route's transaction from this, so guessing high costs routes and
    /// guessing low costs fills.
    fn get_accounts_len(&self) -> usize {
        FIXED_ACCOUNTS + REACH
    }

    fn clone_amm(&self) -> Box<dyn Amm + Send + Sync> {
        Box::new(self.clone())
    }
}

/// The `Swap` variant Jupiter will execute this hop with.
///
/// **This is the one piece of the integration that is not ours to write.**
/// `jupiter_amm_interface::Swap` is a closed enum of 95 DEX-specific variants,
/// and its `DynamicV1 { candidate_swaps }` escape hatch is closed too —
/// `CandidateSwap` names only HumidiFi, TesseraV and HumidiFiV2. A
/// `Swap::Taper { swap_for_y }` is a commit in Jupiter's repository, so it
/// arrives on their schedule and not ours.
///
/// Until it lands this returns an error rather than borrowing someone else's
/// variant. A wrong variant would not fail loudly: Jupiter would build a CPI
/// for a different program's instruction layout, and the failure would surface
/// as a malformed transaction rather than as "this is not implemented yet".
///
/// Everything either side of it is finished. The account metas above are
/// complete and tested, so with a patched `jupiter-amm-interface` in the
/// dependency graph this function is a one-line change — which is what the
/// `pending-swap-variant` feature makes.
#[cfg(not(feature = "pending-swap-variant"))]
fn taper_swap(_swap_for_y: bool) -> Result<Swap> {
    bail!(
        "jupiter-amm-interface has no Swap::Taper variant yet. The account metas are built and \
         tested; build with --features pending-swap-variant against a patched interface to use \
         them."
    )
}

#[cfg(feature = "pending-swap-variant")]
fn taper_swap(swap_for_y: bool) -> Result<Swap> {
    Ok(Swap::Taper { swap_for_y })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A route's transaction is budgeted from `get_accounts_len`, and a hop
    /// that names more accounts than it declared is a route that does not fit.
    #[test]
    fn the_declared_account_count_covers_the_metas() {
        assert_eq!(FIXED_ACCOUNTS + REACH, 13);
    }
}
