/**
 * Mint screening, mirroring `instructions::token::validate_mint`.
 *
 * `initialize_pool` allowlists mint extensions and rejects everything else,
 * including discriminants it does not recognise. Doing the same check client
 * side is not redundant: it turns a failed transaction into a sentence, and it
 * is the difference between "this token cannot be pooled, here is why" and a
 * custom error code.
 *
 * The list must not be widened without widening the program's first. A
 * permanent delegate or a close authority reaches into the reserves, and an
 * unknown discriminant fails closed for the same reason.
 */
import { PublicKey } from "@solana/web3.js";
import {
  ExtensionType,
  getExtensionTypes,
  getTransferFeeConfig,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
  type Mint
} from "@solana/spl-token";
import { FLAG_SPL_TOKEN, FLAG_TOKEN_2022 } from "./constants";

/** Exactly `ALLOWED_MINT_EXTENSIONS` in `instructions/token.rs`. */
export const ALLOWED_MINT_EXTENSIONS: ExtensionType[] = [
  ExtensionType.Uninitialized,
  ExtensionType.TransferFeeConfig,
  ExtensionType.MetadataPointer,
  ExtensionType.TokenMetadata,
  ExtensionType.GroupPointer,
  ExtensionType.TokenGroup,
  ExtensionType.GroupMemberPointer,
  ExtensionType.TokenGroupMember
];

export type MintInfo = {
  address: PublicKey;
  program: PublicKey;
  /** `TokenProgramFlag`, as the pool stores it. */
  flag: number;
  decimals: number;
  supply: bigint;
  extensions: ExtensionType[];
  /** Extensions present that `initialize_pool` will reject. */
  rejected: ExtensionType[];
  /** Current transfer fee in bps, or 0. Only ever set on Token-2022. */
  transferFeeBps: number;
  transferFeeMax: bigint;
  mint: Mint;
};

/**
 * Reads a mint account and reports whether a pool can be opened against it.
 *
 * `owner` is the account's owner program, which is the only thing that decides
 * whether this is a legacy or a Token-2022 mint — never guess it from the
 * data.
 */
export function screenMint(address: PublicKey, data: Uint8Array, owner: PublicKey): MintInfo {
  const is2022 = owner.equals(TOKEN_2022_PROGRAM_ID);
  if (!is2022 && !owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(`${address.toBase58()} is not a token mint (owned by ${owner.toBase58()})`);
  }

  const mint = unpackMint(address, { data: Buffer.from(data), owner } as never, owner);
  const extensions = is2022 && mint.tlvData.length ? getExtensionTypes(mint.tlvData) : [];
  const rejected = extensions.filter((e) => !ALLOWED_MINT_EXTENSIONS.includes(e));

  // The fee that applies now, not the one scheduled: `older` vs `newer` swap at
  // an epoch boundary, and a deposit quoted against the wrong one is short.
  const feeConfig = is2022 ? getTransferFeeConfig(mint) : null;
  const fee = feeConfig?.newerTransferFee;

  return {
    address,
    program: owner,
    flag: is2022 ? FLAG_TOKEN_2022 : FLAG_SPL_TOKEN,
    decimals: mint.decimals,
    supply: mint.supply,
    extensions,
    rejected,
    transferFeeBps: fee ? fee.transferFeeBasisPoints : 0,
    transferFeeMax: fee ? fee.maximumFee : 0n,
    mint
  };
}

/** A human sentence for why a mint was rejected, or undefined if it was not. */
export function mintRejection(info: MintInfo) {
  if (!info.rejected.length) return undefined;
  const names = info.rejected.map((e) => ExtensionType[e] ?? `extension ${e}`);
  return `${names.join(", ")} ${info.rejected.length === 1 ? "is" : "are"} not allowed: the program rejects any mint extension that can reach into pool reserves.`;
}

/**
 * What actually arrives when `amount` is sent, after the mint's transfer fee.
 *
 * The rule the program works to is *credit what arrives, promise what reaches
 * the wallet* — so a deposit must be quoted with this, and a swap's
 * `min_amount_out` checked against it.
 */
export function amountAfterTransferFee(info: MintInfo, amount: bigint) {
  if (!info.transferFeeBps) return amount;
  // Matches spl-token-2022: the fee rounds up, and is capped.
  const fee = (amount * BigInt(info.transferFeeBps) + 9_999n) / 10_000n;
  return amount - (fee > info.transferFeeMax ? info.transferFeeMax : fee);
}
