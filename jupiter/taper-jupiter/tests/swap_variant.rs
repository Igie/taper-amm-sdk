//! `get_swap_and_account_metas`, on both sides of the gate.
//!
//! The metas are the half of it that is ours, and they are checked in every
//! build. The `Swap` variant is the half that is not: `Swap::Taper` is a commit
//! in Jupiter's repository, so the default build asserts that its absence is
//! reported honestly, and `--features pending-swap-variant` asserts that with
//! the variant present the right one comes back carrying the right direction.
//!
//! `./scripts/verify-swap-variant.ps1` runs the second half against a local
//! copy of `jupiter-amm-interface` with `jupiter/upstream/`'s patch applied,
//! which is what makes "one line to change" a tested claim rather than a
//! promise.

mod common;

use jupiter_amm_interface::{Amm, SwapMode, SwapParams};
use solana_instruction::AccountMeta;
use solana_pubkey::Pubkey;
use taper_amm_sdk::instructions::FIXED_ACCOUNTS;
use taper_amm_sdk::pda::{bin_array_index, bin_array_pda};
use taper_amm_sdk::state::{parse_pool, PoolKeys};

/// The wallet side of a hop. None of these addresses are derived by the
/// program, so they are only ever copied through — which is why it is worth
/// checking that they land in the slots the instruction reads them from.
struct Wallet {
    authority: Pubkey,
    source: Pubkey,
    destination: Pubkey,
    jupiter: Pubkey,
}

impl Wallet {
    fn new() -> Self {
        Self {
            authority: Pubkey::new_unique(),
            source: Pubkey::new_unique(),
            destination: Pubkey::new_unique(),
            jupiter: Pubkey::new_unique(),
        }
    }

    fn params<'a>(&'a self, fixture: &common::Fixture) -> SwapParams<'static, 'a> {
        SwapParams {
            swap_mode: SwapMode::ExactIn,
            in_amount: fixture.amount,
            out_amount: 0,
            source_mint: fixture.input_mint,
            destination_mint: fixture.output_mint,
            source_token_account: self.source,
            destination_token_account: self.destination,
            token_transfer_authority: self.authority,
            user: self.authority,
            payer: self.authority,
            quote_mint_to_referrer: None,
            jupiter_program_id: &self.jupiter,
            missing_dynamic_accounts_as_default: false,
        }
    }
}

fn active_array(fixture: &common::Fixture) -> i32 {
    let pool = parse_pool(&fixture.accounts[&fixture.pool].data).expect("pool");
    bin_array_index(pool.active_id)
}

/// A route's transaction is budgeted from `get_accounts_len`, so a hop that
/// names more accounts than it declared is a route that does not fit. Every
/// fixture, because the count follows the bitmap.
#[test]
fn no_hop_names_more_accounts_than_it_declared() {
    for name in common::names() {
        let fixture = common::load(&name);
        let amm = common::amm(&fixture);
        let wallet = Wallet::new();
        let metas = amm.swap_account_metas(&wallet.params(&fixture)).expect("metas");

        assert!(
            metas.len() >= FIXED_ACCOUNTS,
            "{name}: {} metas is fewer than the fixed accounts",
            metas.len()
        );
        assert!(
            metas.len() <= amm.get_accounts_len(),
            "{name}: {} metas against a declared {}",
            metas.len(),
            amm.get_accounts_len()
        );
    }
}

/// The fixed metas are the pool's own accounts, and the program reads them
/// positionally: a pair transposed here is a swap against the wrong reserve.
#[test]
fn the_fixed_metas_are_the_pools_accounts_in_the_programs_order() {
    let fixture = common::load("plain_x_to_y");
    let amm = common::amm(&fixture);
    let wallet = Wallet::new();
    let metas = amm.swap_account_metas(&wallet.params(&fixture)).expect("metas");

    let pool = parse_pool(&fixture.accounts[&fixture.pool].data).expect("pool");
    let keys = PoolKeys::of(&pool);
    let (program_x, program_y) = taper_amm_sdk::state::token_programs(&pool);

    // (address, writable, signer)
    let expected: [(Pubkey, bool, bool); FIXED_ACCOUNTS] = [
        (wallet.authority, false, true),
        (fixture.pool, true, false),
        (keys.config, false, false),
        (keys.token_x_mint, false, false),
        (keys.token_y_mint, false, false),
        (wallet.source, true, false),
        (wallet.destination, true, false),
        (keys.reserve_x, true, false),
        (keys.reserve_y, true, false),
        (program_x, false, false),
        (program_y, false, false),
    ];

    for (i, (pubkey, is_writable, is_signer)) in expected.into_iter().enumerate() {
        assert_eq!(metas[i], AccountMeta { pubkey, is_writable, is_signer }, "meta {i}");
    }
}

/// The mints and the token programs are named by side, X then Y, never by
/// direction — so the shape of the account list does not change when the
/// direction does. Only the user's two token accounts and the arrays move.
#[test]
fn the_pool_side_accounts_are_named_by_side_and_not_by_direction() {
    let fixture = common::load("plain_x_to_y");
    let amm = common::amm(&fixture);
    let pool = parse_pool(&fixture.accounts[&fixture.pool].data).expect("pool");
    let keys = PoolKeys::of(&pool);

    let wallet = Wallet::new();
    let forward = amm.swap_account_metas(&wallet.params(&fixture)).expect("metas");

    // The same pool, quoted the other way: input and output mints swapped.
    let mut reversed = wallet.params(&fixture);
    reversed.source_mint = fixture.output_mint;
    reversed.destination_mint = fixture.input_mint;
    let back = amm.swap_account_metas(&reversed).expect("metas");

    for (i, expected) in [(3, keys.token_x_mint), (4, keys.token_y_mint)] {
        assert_eq!(forward[i].pubkey, expected, "meta {i} forward");
        assert_eq!(back[i].pubkey, expected, "meta {i} reversed");
    }
    for i in [0, 1, 2, 5, 6, 7, 8, 9, 10] {
        assert_eq!(forward[i], back[i], "meta {i} moved with the direction");
    }
}

/// The trailing metas are bin arrays, writable, in the order the walk will
/// visit them: down from the active bin's array when X is going in, up when Y
/// is. Handing them in the wrong order is a walk that stops at the first bin
/// it cannot find.
#[test]
fn the_arrays_trail_the_fixed_accounts_in_travel_order() {
    let fixture = common::load("plain_x_to_y");
    let amm = common::amm(&fixture);
    let home = active_array(&fixture);
    let wallet = Wallet::new();

    let mut reversed = wallet.params(&fixture);
    reversed.source_mint = fixture.output_mint;
    reversed.destination_mint = fixture.input_mint;

    for (params, swap_for_y) in [(wallet.params(&fixture), true), (reversed, false)] {
        let metas = amm.swap_account_metas(&params).expect("metas");
        let arrays = &metas[FIXED_ACCOUNTS..];
        assert!(!arrays.is_empty(), "a hop must name the active bin's array");

        let step = if swap_for_y { -1 } else { 1 };
        for (i, meta) in arrays.iter().enumerate() {
            assert!(meta.is_writable, "array {i} must be writable");
            assert!(!meta.is_signer, "array {i} must not sign");
            assert_eq!(
                meta.pubkey,
                bin_array_pda(&fixture.pool, home + step * i as i32),
                "swap_for_y={swap_for_y}: array {i} is not the one the walk reaches next"
            );
        }
    }
}

/// Until `Swap::Taper` exists there is no honest variant to return, and
/// borrowing another DEX's would not fail loudly: Jupiter would build a CPI
/// against a different program's instruction layout, and the failure would
/// surface as a malformed transaction. So the error has to name what is
/// missing and how to build against it.
#[cfg(not(feature = "pending-swap-variant"))]
#[test]
fn the_gate_refuses_rather_than_borrowing_another_dexs_variant() {
    let fixture = common::load("plain_x_to_y");
    let amm = common::amm(&fixture);
    let wallet = Wallet::new();

    // `.err()` rather than `expect_err`: `SwapAndAccountMetas` is not `Debug`.
    let error = amm
        .get_swap_and_account_metas(&wallet.params(&fixture))
        .err()
        .expect("a published jupiter-amm-interface has no Swap::Taper")
        .to_string();

    assert!(error.contains("Swap::Taper"), "{error}");
    assert!(error.contains("pending-swap-variant"), "{error}");
}

/// With the variant present the method comes together: the metas checked
/// above, and a variant carrying the direction the mints imply.
#[cfg(feature = "pending-swap-variant")]
#[test]
fn the_variant_carries_the_direction_and_the_metas_are_unchanged() {
    use jupiter_amm_interface::Swap;

    let fixture = common::load("plain_x_to_y");
    let amm = common::amm(&fixture);
    let wallet = Wallet::new();

    let mut reversed = wallet.params(&fixture);
    reversed.source_mint = fixture.output_mint;
    reversed.destination_mint = fixture.input_mint;

    for (params, swap_for_y) in [(wallet.params(&fixture), true), (reversed, false)] {
        let built = amm.get_swap_and_account_metas(&params).expect("metas");
        assert_eq!(built.swap, Swap::Taper { swap_for_y });
        assert_eq!(
            built.account_metas,
            amm.swap_account_metas(&params).expect("metas"),
            "the trait method must hand back the metas it was checked on"
        );
    }
}
