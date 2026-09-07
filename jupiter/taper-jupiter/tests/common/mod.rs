//! Loading a parity fixture and building the `Amm` Jupiter would build.
//!
//! Shared by `parity.rs` and `swap_variant.rs`. An integration test is its own
//! binary, so without this the base64 decoder and the JSON reader would exist
//! twice — and this repository's whole shape is an argument against a second
//! copy of anything.
//!
//! Regenerate the fixtures with `cd tests; cargo test --test parity_fixtures`.

// Each test binary uses a different part of this.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::str::FromStr;
use std::sync::atomic::Ordering;

use jupiter_amm_interface::{AccountMap, Amm, AmmContext, ClockRef, KeyedAccount};
use solana_account::Account;
use solana_pubkey::Pubkey;
use taper_jupiter::TaperAmm;

pub struct Fixture {
    pub name: String,
    pub covers: String,
    pub pool: Pubkey,
    pub unix_timestamp: i64,
    pub epoch: u64,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub amount: u64,
    /// What left the trader's wallet, measured on chain.
    pub observed_in: u64,
    /// What reached it.
    pub observed_out: u64,
    pub accounts: BTreeMap<Pubkey, Account>,
}

pub fn fixtures_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
}

/// The inverse of the writer in `parity_fixtures.rs`, and hand-written for the
/// same reason: one alphabet is a smaller thing to own than a dependency.
pub fn base64_decode(text: &str) -> Vec<u8> {
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

pub fn load(name: &str) -> Fixture {
    let path = fixtures_dir().join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("{}: {e}. Run `cd tests; cargo test --test parity_fixtures`", path.display())
    });
    let json: serde_json::Value = serde_json::from_str(&text).expect("fixture json");

    let key =
        |field: &str| Pubkey::from_str(json[field].as_str().expect("string")).expect("pubkey");
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

pub fn names() -> Vec<String> {
    let text = std::fs::read_to_string(fixtures_dir().join("index.json")).expect("index.json");
    serde_json::from_str::<Vec<String>>(&text).expect("index json")
}

/// Builds the `Amm` the way Jupiter does: from the pool's keyed account and a
/// clock, then `update` with everything else.
pub fn amm(fixture: &Fixture) -> TaperAmm {
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
        &KeyedAccount { key: fixture.pool, account: pool_account, params: None },
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
    amm
}
