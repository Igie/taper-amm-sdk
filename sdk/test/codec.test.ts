/**
 * The two pieces of encoding this package cannot borrow from web3.js.
 *
 * `base58` exists because a `memcmp` filter takes base58 `bytes` and an
 * account discriminator is eight of them — `PublicKey` insists on 32 and is
 * therefore no help. Since it is hand-written, it is checked against
 * `PublicKey`'s own encoder over the one length they share.
 *
 * The account discriminators are checked the way `anchor_support.rs` checks
 * them on the Rust side: re-derived from the name, so a renamed struct or a
 * mistyped byte shows up here rather than as an empty position list.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { base58 } from "../src/codec";
import { ACCOUNT_DISCRIMINATORS, DISCRIMINATORS } from "../src/constants";

describe("base58", () => {
  test("agrees with PublicKey over random 32-byte keys", () => {
    for (let i = 0; i < 300; i += 1) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      // Leading zeros are the case a naive implementation drops.
      if (i < 20) bytes[0] = 0;
      if (i < 10) bytes[1] = 0;
      expect(base58(bytes)).toBe(new PublicKey(bytes).toBase58());
    }
  });

  test("encodes an all-zero input as leading ones", () => {
    expect(base58(new Uint8Array(4))).toBe("1111");
    expect(base58(new Uint8Array(0))).toBe("");
  });
});

describe("discriminators", () => {
  const first8 = (preimage: string) => [...createHash("sha256").update(preimage).digest().subarray(0, 8)];

  test("account discriminators are sha256(\"account:<Name>\")[..8]", () => {
    expect(ACCOUNT_DISCRIMINATORS.config).toEqual(first8("account:Config") as never);
    expect(ACCOUNT_DISCRIMINATORS.pool).toEqual(first8("account:Pool") as never);
    expect(ACCOUNT_DISCRIMINATORS.binArray).toEqual(first8("account:BinArray") as never);
    expect(ACCOUNT_DISCRIMINATORS.position).toEqual(first8("account:Position") as never);
  });

  test("instruction discriminators are sha256(\"global:<snake_name>\")[..8]", () => {
    const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    for (const [name, bytes] of Object.entries(DISCRIMINATORS)) {
      expect(bytes).toEqual(first8(`global:${snake(name)}`) as never);
    }
  });
});
