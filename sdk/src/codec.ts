/**
 * Byte plumbing: little-endian writers for instruction data, readers for
 * account data, and the `TransactionInstruction` constructor they feed.
 *
 * Hand-packed rather than Borsh-generated on purpose — the same reason
 * `tests/src/lib.rs` does it — so nothing here is derived from the program
 * crate and a layout drift breaks loudly.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID } from "./constants";

export class Writer {
  private readonly parts: number[] = [];

  u8(v: number) {
    this.parts.push(v & 0xff);
    return this;
  }
  private view(size: number, write: (d: DataView) => void) {
    const d = new DataView(new ArrayBuffer(size));
    write(d);
    this.parts.push(...new Uint8Array(d.buffer));
    return this;
  }
  u16(v: number) {
    return this.view(2, (d) => d.setUint16(0, v, true));
  }
  u32(v: number) {
    return this.view(4, (d) => d.setUint32(0, v, true));
  }
  i32(v: number) {
    return this.view(4, (d) => d.setInt32(0, v, true));
  }
  u64(v: bigint | number) {
    return this.view(8, (d) => d.setBigUint64(0, BigInt(v), true));
  }
  i64(v: bigint | number) {
    return this.view(8, (d) => d.setBigInt64(0, BigInt(v), true));
  }
  u128(v: bigint) {
    let n = v;
    for (let i = 0; i < 16; i += 1) {
      this.parts.push(Number(n & 0xffn));
      n >>= 8n;
    }
    return this;
  }
  /**
   * Borsh `Option<T>`: a presence byte, then the value only if present.
   *
   * `update_config` takes every field this way, so a caller edits one setting
   * without restating the rest.
   */
  option<T>(v: T | undefined | null, write: (w: Writer, value: T) => Writer) {
    if (v === undefined || v === null) return this.u8(0);
    return write(this.u8(1), v);
  }
  bytes() {
    return Uint8Array.from(this.parts);
  }
}

const dv = (d: Uint8Array, o: number, len: number) => new DataView(d.buffer, d.byteOffset + o, len);
export const u8At = (d: Uint8Array, o: number) => d[o];
export const u16At = (d: Uint8Array, o: number) => dv(d, o, 2).getUint16(0, true);
export const u32At = (d: Uint8Array, o: number) => dv(d, o, 4).getUint32(0, true);
export const i32At = (d: Uint8Array, o: number) => dv(d, o, 4).getInt32(0, true);
export const u64At = (d: Uint8Array, o: number) => dv(d, o, 8).getBigUint64(0, true);
export const i64At = (d: Uint8Array, o: number) => dv(d, o, 8).getBigInt64(0, true);
export const keyAt = (d: Uint8Array, o: number) => new PublicKey(d.slice(o, o + 32));

export function u128At(d: Uint8Array, o: number) {
  let n = 0n;
  for (let i = 15; i >= 0; i -= 1) n = (n << 8n) + BigInt(d[o + i]);
  return n;
}

export function ix(
  discriminator: readonly number[],
  keys: TransactionInstruction["keys"],
  data: Uint8Array
) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data: Buffer.from(Uint8Array.from([...discriminator, ...data]))
  });
}

export const seedI32 = (v: number) => new Writer().i32(v).bytes();
export const seedU16 = (v: number) => new Writer().u16(v).bytes();
export const seedI64 = (v: number) => new Writer().i64(v).bytes();

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Base58, for the one place this package needs it: a `memcmp` filter's
 * `bytes`, which `getProgramAccounts` takes base58-encoded.
 *
 * Twelve lines rather than a dependency. `PublicKey` cannot stand in - it
 * insists on 32 bytes, and an account discriminator is eight.
 */
export function base58(bytes: Uint8Array): string {
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading += 1;

  const digits: number[] = [];
  for (const byte of bytes.subarray(leading)) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  // A leading zero byte is a leading "1", and carries no digit of its own.
  return "1".repeat(leading) + digits.reverse().map((d) => BASE58[d]).join("");
}
