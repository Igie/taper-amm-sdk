/**
 * SOL, which is not a token.
 *
 * A pool holds token accounts, so the SOL side of any pair is really the
 * native mint `So111…112` wrapped into an SPL account. Nothing in the program
 * knows about that — to `taper-amm` wrapped SOL is an ordinary mint — so the
 * whole of the difference is here, and it is three instructions:
 *
 * - **before**, an idempotent ATA create, a lamport transfer into it, and
 *   `sync_native` so the account's `amount` matches the lamports it now holds;
 * - **after**, a close, which pays the whole balance back out as SOL.
 *
 * The wrapped account is therefore treated as scratch space: it is funded for
 * exactly one transaction and emptied at the end of it, so a user is never
 * left holding a wSOL balance they have to notice. The cost of that choice is
 * that a wSOL balance held deliberately is swept back to SOL too; a client
 * should say so rather than hide it.
 *
 * `SOL_RESERVE` is the other half of the same idea: wrapping every lamport a
 * wallet holds leaves nothing to pay the fee with, so a max button should stop
 * short of the balance rather than produce a transaction that cannot land.
 *
 * This lives in the SDK rather than in one interface because every client that
 * lists a SOL pair needs exactly this and gets it subtly wrong: forgetting
 * `sync_native` produces a transfer that fails for insufficient funds while
 * the lamports are visibly there.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction
} from "@solana/spl-token";
import type { TokenAccountState } from "./token";

export { NATIVE_MINT };

export const isNativeMint = (mint: PublicKey) => mint.equals(NATIVE_MINT);

/**
 * Lamports a max button leaves unwrapped: the signature, the priority fee, and
 * some slack. A caller that also pays rent in the same transaction adds it on
 * top with `rentFor` — a bin array is 6,792 bytes, about 0.048 SOL.
 */
export const SOL_RESERVE = 20_000_000n;

/**
 * What this side can actually spend.
 *
 * For an ordinary mint that is the token account's balance. For the native
 * mint it is that balance *plus* the wallet's own lamports, because anything
 * unwrapped can be wrapped in the same transaction — less `reserve`, which a
 * max button sets and a bounds check leaves at zero.
 */
export function spendable(
  mint: PublicKey,
  state: TokenAccountState,
  lamports: bigint,
  reserve = 0n
): bigint {
  if (!isNativeMint(mint)) return state.amount;
  return state.amount + (lamports > reserve ? lamports - reserve : 0n);
}

/**
 * Rent for an account of `bytes`, at the cluster defaults: 3,480 lamports per
 * byte-year, two years, over 128 bytes of storage overhead.
 *
 * Used only to decide how much SOL a max button must leave behind, so an
 * estimate is enough — a deposit that creates two bin arrays needs about
 * 0.1 SOL of rent it cannot also wrap.
 */
export const rentFor = (bytes: number) => BigInt(128 + bytes) * 6_960n;

/** One side of a transaction: its account, and how much has to leave it. */
export type TokenNeed = {
  mint: PublicKey;
  program: PublicKey;
  state: TokenAccountState;
  /** Raw units this transaction sends from the account. Zero if it only receives. */
  needed: bigint;
};

/**
 * Setup and teardown for a transaction that moves these tokens.
 *
 * `before` goes ahead of the program's instructions and `after` behind them,
 * which is the only ordering that works: an account has to exist before it is
 * paid into, and the unwrap has to see whatever the swap or the withdrawal put
 * there.
 */
export function prepareTokens(
  owner: PublicKey,
  needs: TokenNeed[]
): { before: TransactionInstruction[]; after: TransactionInstruction[] } {
  const before: TransactionInstruction[] = [];
  const after: TransactionInstruction[] = [];

  for (const need of needs) {
    const native = isNativeMint(need.mint);
    // Idempotent, so racing another transaction to the same account is not a
    // failure — and so wrapping does not have to know whether it exists.
    if (!need.state.exists || native) {
      before.push(
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          need.state.address,
          owner,
          need.mint,
          need.program,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
    if (!native) continue;

    const short = need.needed - need.state.amount;
    if (short > 0n) {
      before.push(
        SystemProgram.transfer({ fromPubkey: owner, toPubkey: need.state.address, lamports: short })
      );
      // Without this the account holds the lamports but reports the old
      // `amount`, and the transfer out of it fails for insufficient funds.
      before.push(createSyncNativeInstruction(need.state.address, TOKEN_PROGRAM_ID));
    }
    after.push(
      createCloseAccountInstruction(need.state.address, owner, owner, [], TOKEN_PROGRAM_ID)
    );
  }

  return { before, after };
}

/** Whether either side of a pair is SOL, i.e. whether any of this applies. */
export const involvesSol = (...mints: PublicKey[]) => mints.some(isNativeMint);
