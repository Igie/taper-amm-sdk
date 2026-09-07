//! Quote parity against real on-chain execution.
//!
//! Jupiter's bar for an integration: take live pool state, run `Amm::quote`,
//! execute the real instruction, and assert the token deltas match the quote
//! exactly. This is the second half of that. The first half runs in
//! `tests/tests/parity_fixtures.rs`, where LiteSVM and the real `taper_amm.so`
//! already live: it snapshots the accounts an `Amm` would read, executes the
//! swap for real, and records what the trader's wallet actually gained and
//! lost. Here those snapshots are quoted and the two are compared.
//!
//! So the numbers below are not expectations anybody typed. They came out of
//! the program, executed by the SVM.
//!
//! Their own harness routes through a committed `jupiter_v6.so` that decodes a
//! `Swap` enum variant to pick a DEX, so it cannot execute a Taper hop until
//! Jupiter ships both `Swap::Taper` and an aggregator that dispatches it —
//! neither of which is forkable. Splitting the property across the two
//! workspaces tests the same thing without waiting on that.
//!
//! Regenerate the fixtures with `cd tests; cargo test --test parity_fixtures`.

use std::collections::BTreeMap;
use std::str::FromStr;
use std::sync::atomic::Ordering;

use jupiter_amm_interface::{
    AccountMap, Amm, AmmContext, ClockRef, KeyedAccount, QuoteParams, SwapMode,
};
use solana_account::Account;
use solana_pubkey::Pubkey;
use taper_jupiter::TaperAmm;

struct Fixture {
    name: String,
    covers: String,
    pool: Pubkey,
    unix_timestamp: i64,
    epoch: u64,
    input_mint: Pubkey,
    output_mint: Pubkey,
    amount: u64,
    /// What left the trader's wallet, measured on chain.
    observed_in: u64,
    /// What reached it.
    observed_out: u64,
    accounts: BTreeMap<Pubkey, Account>,
}

fn fixtures_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
}

/// The inverse of the writer in `parity_fixtures.rs`, and hand-written for the
/// same reason: one alphabet is a smaller thing to own than a dependency.
fn base64_decode(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let value = |c: u8| ALPHABET.iter().position(|a| *a == c).expect("base64 char") as u32;
    let bytes: Vec<u8> = text.bytes().filter(|c| *c != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            n |= value(*c) << (18 - 6 * i);
        }
        for i in 0..chunk.len() - 1 {
            out.push((n >> (16 - 8 * i)) as u8);
        }
    }
    out
}

fn load(name: &str) -> Fixture {
    let path = fixtures_dir().join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}. Run `cd tests; cargo test --test parity_fixtures`", path.display()));
    let json: serde_json::Value = serde_json::from_str(&text).expect("fixture json");

    let key = |field: &str| {
        Pubkey::from_str(json[field].as_str().expect("string")).expect("pubkey")
    };
    let number = |field: &str| json[field].as_u64().expect("number");

    let mut accounts = BTreeMap::new();
    for (address, value) in json["accounts"].as_object().expect("accounts") {
        let data = base64_decode(value["data"].as_str().expect("data"));
        accounts.insert(
            Pubkey::from_str(address).expect("pubkey"),
            Account {
                lamports: 1,
                data,
                owner: Pubkey::from_str(value["owner"].as_str().expect("owner")).expect("pubkey"),
                executable: false,
                rent_epoch: 0,
            },
        );
    }

    Fixture {
        name: json["name"].as_str().expect("name").to_string(),
        covers: json["covers"].as_str().expect("covers").to_string(),
        pool: key("pool"),
        unix_timestamp: json["unixTimestamp"].as_i64().expect("timestamp"),
        epoch: number("epoch"),
        input_mint: key("inputMint"),
        output_mint: key("outputMint"),
        amount: number("amount"),
        observed_in: number("observedIn"),
        observed_out: number("observedOut"),
        accounts,
    }
}

fn names() -> Vec<String> {
    let text = std::fs::read_to_string(fixtures_dir().join("index.json")).expect("index.json");
    serde_json::from_str::<Vec<String>>(&text).expect("index json")
}

/// Builds the `Amm` the way Jupiter does: from the pool's keyed account and a
/// clock, then `update` with everything else.
fn quote(fixture: &Fixture) -> jupiter_amm_interface::Quote {
    let clock_ref = ClockRef::default();
    clock_ref
        .unix_timestamp
        .store(fixture.unix_timestamp, Ordering::Relaxed);
    clock_ref.epoch.store(fixture.epoch, Ordering::Relaxed);

    let pool_account = fixture
        .accounts
        .get(&fixture.pool)
        .expect("the pool is in its own snapshot")
        .clone();
    let mut amm = TaperAmm::from_keyed_account(
        &KeyedAccount {
            key: fixture.pool,
            account: pool_account,
            params: None,
        },
        &AmmContext { clock_ref },
    )
    .expect("from_keyed_account");

    let mut account_map = AccountMap::default();
    for (key, account) in &fixture.accounts {
        account_map.insert(*key, account.clone());
    }

    // Every account the impl asks for should be in the snapshot: the fixture
    // was written from this same list. A miss means the two have drifted.
    for wanted in amm.get_accounts_to_update() {
        assert!(
            fixture.accounts.contains_key(&wanted),
            "{}: get_accounts_to_update wants {wanted}, which the snapshot does not have",
            fixture.name
        );
    }

    amm.update(&account_map).expect("update");
    amm.quote(&QuoteParams {
        amount: fixture.amount,
        input_mint: fixture.input_mint,
        output_mint: fixture.output_mint,
        swap_mode: SwapMode::ExactIn,
        fee_mode: Default::default(),
    })
    .expect("quote")
}

#[test]
fn every_quote_matches_what_the_program_actually_did() {
    let names = names();
    assert!(names.len() >= 11, "the fixture set has shrunk: {names:?}");

    for name in &names {
        let fixture = load(name);
        let quote = quote(&fixture);

        println!(
            "{:<28} in {:>12} out {:>12}   {}",
            fixture.name, quote.in_amount, quote.out_amount, fixture.covers
        );
        assert_eq!(
            quote.in_amount, fixture.observed_in,
            "{}: quoted input does not match what the swap took ({})",
            fixture.name, fixture.covers
        );
        assert_eq!(
            quote.out_amount, fixture.observed_out,
            "{}: quoted output does not match what the swap delivered ({})",
            fixture.name, fixture.covers
        );
    }
}

/// The check on the check: if the comparison above could not fail, it would
/// prove nothing. One lamport either way has to be caught.
#[test]
fn a_one_lamport_error_would_be_caught() {
    let fixture = load("plain_x_to_y");
    let quote = quote(&fixture);
    assert_ne!(quote.out_amount, fixture.observed_out + 1);
    assert_ne!(quote.out_amount, fixture.observed_out - 1);
    assert_ne!(quote.in_amount, fixture.observed_in + 1);
}

/// A partial fill is where a quote is easiest to get wrong: the honest answer
/// is what the ladder absorbed, not what was offered.
#[test]
fn a_partial_fill_quotes_what_was_consumed_not_what_was_offered() {
    let fixture = load("partial_fill");
    let quote = quote(&fixture);
    assert!(
        quote.in_amount < fixture.amount,
        "the fixture should not be fillable in full"
    );
    assert_eq!(quote.in_amount, fixture.observed_in);
}

/// The transfer-fee cases are the ones where the two ends of a quote come
/// apart, so it is worth stating what each of them means rather than trusting
/// the loop above to have covered it.
#[test]
fn transfer_fees_move_the_ends_and_not_the_ladder() {
    let plain = load("plain_x_to_y");
    let plain_quote = quote(&plain);

    // A fee on the input: the wallet sends the same, the ladder trades less,
    // so less comes back.
    let on_input = load("transfer_fee_on_input");
    let input_quote = quote(&on_input);
    assert_eq!(input_quote.in_amount, plain_quote.in_amount);
    assert!(input_quote.out_amount < plain_quote.out_amount);

    // A fee on the output: the ladder trades the same and the wallet receives
    // less on the way home.
    let on_output = load("transfer_fee_on_output");
    let output_quote = quote(&on_output);
    assert!(output_quote.out_amount < plain_quote.out_amount);

    // Both at once is strictly worse than either alone.
    let on_both = load("transfer_fee_on_both");
    let both_quote = quote(&on_both);
    assert!(both_quote.out_amount < input_quote.out_amount);
    assert!(both_quote.out_amount < output_quote.out_amount);
}
