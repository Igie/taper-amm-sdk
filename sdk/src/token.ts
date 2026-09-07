/**
 * The caller's own token accounts: their addresses, their balances, and the
 * instructions that bring a missing one into existence.
 *
 * Every instruction in this program that moves tokens names a user account per
 * side, and an associated token account is *derived* rather than looked up —
 * so the address is always knowable, and what is not knowable without a read
 * is whether anything is there yet. A swap that pays out into a missing
 * account fails, so the create belongs in the same transaction.
 *
 * Nothing here opens a connection. `amountOf` parses bytes the caller fetched
 * and `ensureAccounts` returns instructions the caller sends, which is what
 * lets the same code drive the WebSocket-less localnet and a real endpoint.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import type { TokenPair } from "./types";

/**
 * The associated token account for this mint, owner and token program.
 *
 * `allowOwnerOffCurve` is on because a pool's reserve is owned by a PDA, and
 * the same helper derives both sides of every transfer.
 */
export const ataFor = (mint: PublicKey, owner: PublicKey, program: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true, program, ASSOCIATED_TOKEN_PROGRAM_ID);

/** Both of a pair's user accounts, in the pool's own X/Y order. */
export const userAccountsFor = (pair: TokenPair, owner: PublicKey) => ({
  userTokenX: ataFor(pair.mintX, owner, pair.programX),
  userTokenY: ataFor(pair.mintY, owner, pair.programY)
});

export type TokenAccountState = {
  address: PublicKey;
  exists: boolean;
  amount: bigint;
};

/**
 * A token account's balance.
 *
 * Both token programs lay the first 72 bytes out identically — mint, owner,
 * then the `u64` amount — so one reader serves SPL Token and Token-2022 alike.
 */
export const amountOf = (data: Uint8Array) =>
  data.length >= 72 ? new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true) : 0n;

/** The mint a token account holds, at offset 0 in both token programs. */
export const mintOf = (data: Uint8Array) => new PublicKey(data.subarray(0, 32));

/**
 * A state for an account whose existence has not been read.
 *
 * Assuming it is missing is the safe half of the guess: the create that
 * follows is idempotent, so being wrong costs a few compute units, while the
 * other way round costs a failed transaction.
 */
export const assumeMissing = (
  mint: PublicKey,
  owner: PublicKey,
  program: PublicKey
): TokenAccountState => ({ address: ataFor(mint, owner, program), exists: false, amount: 0n });

/** Turns fetched account data into the state the builders below expect. */
export const stateOf = (
  mint: PublicKey,
  owner: PublicKey,
  program: PublicKey,
  data: Uint8Array | null | undefined
): TokenAccountState => ({
  address: ataFor(mint, owner, program),
  exists: Boolean(data),
  amount: data ? amountOf(data) : 0n
});

/**
 * Instructions to create any of these accounts that are missing.
 *
 * Idempotent, so a race with another transaction that created the same account
 * first is not a failure.
 */
export function ensureAccounts(
  payer: PublicKey,
  owner: PublicKey,
  entries: { mint: PublicKey; program: PublicKey; state: TokenAccountState }[]
): TransactionInstruction[] {
  return entries
    .filter((e) => !e.state.exists)
    .map((e) =>
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        e.state.address,
        owner,
        e.mint,
        e.program,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
}
