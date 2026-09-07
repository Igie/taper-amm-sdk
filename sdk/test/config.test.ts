/**
 * `updateConfigIx`'s wire format, and the validator that stands in front of it.
 *
 * The instruction data is hand-packed rather than Borsh-generated — the same
 * reason the rest of the codec is — so nothing but a test stands between a
 * mis-ordered field and a transaction that fails on chain with a byte-offset
 * error. Every field is a borsh `Option`: one presence byte, then the value
 * only when present.
 */
import { describe, expect, test } from "bun:test";
import { DISCRIMINATORS, MAX_PROTOCOL_SHARE, PROGRAM_ID } from "../src/constants";
import { buildConfig, validateConfig } from "../src/ladder";
import { updateConfigIx } from "../src/instructions";
import { configPda } from "../src/pda";
import { PublicKey } from "@solana/web3.js";

const AUTHORITY = new PublicKey("11111111111111111111111111111112");
const CONFIG = configPda(AUTHORITY, 0);

/** The 11 optional fields, in the order `UpdateConfigParams` declares them. */
const FIELD_COUNT = 11;

describe("updateConfigIx", () => {
  test("an empty update is eleven absent-value bytes", () => {
    const data = updateConfigIx(AUTHORITY, CONFIG, {}).data;
    expect([...data.subarray(0, 8)]).toEqual([...DISCRIMINATORS.updateConfig]);
    expect(data.length).toBe(8 + FIELD_COUNT);
    expect([...data.subarray(8)]).toEqual(Array(FIELD_COUNT).fill(0));
  });

  test("a present field is a 1 byte followed by its little-endian value", () => {
    // `protocolShare` is the fifth field and a u16, so it sits after four
    // absent markers: minBinId, maxBinId, baseFactor, baseFeePowerFactor.
    const data = updateConfigIx(AUTHORITY, CONFIG, { protocolShare: 2_000 }).data;
    expect(data.length).toBe(8 + FIELD_COUNT + 2);
    expect([...data.subarray(8, 12)]).toEqual([0, 0, 0, 0]);
    expect(data[12]).toBe(1);
    expect(data.readUInt16LE(13)).toBe(2_000);
    expect([...data.subarray(15)]).toEqual(Array(6).fill(0));
  });

  test("a negative bin id round-trips as a signed 32-bit value", () => {
    const data = updateConfigIx(AUTHORITY, CONFIG, { minBinId: -35_840 }).data;
    expect(data[8]).toBe(1);
    expect(data.readInt32LE(9)).toBe(-35_840);
    expect(data[13]).toBe(0); // maxBinId absent
  });

  test("every field can be sent at once, in declaration order", () => {
    const data = updateConfigIx(AUTHORITY, CONFIG, {
      minBinId: -100,
      maxBinId: 100,
      baseFactor: 10_000,
      baseFeePowerFactor: 1,
      protocolShare: 1_500,
      collectFeeMode: 1,
      filterPeriod: 30,
      decayPeriod: 600,
      reductionFactor: 5_000,
      variableFeeControl: 40_000,
      maxVolatilityAccumulator: 350_000
    }).data;

    // 4 + 4 + 2 + 1 + 2 + 1 + 2 + 2 + 2 + 4 + 4 bytes of value, plus a
    // presence byte each.
    expect(data.length).toBe(8 + FIELD_COUNT + 28);

    let o = 8;
    const take = (size: number, read: (at: number) => number) => {
      expect(data[o]).toBe(1);
      const v = read(o + 1);
      o += 1 + size;
      return v;
    };
    expect(take(4, (at) => data.readInt32LE(at))).toBe(-100);
    expect(take(4, (at) => data.readInt32LE(at))).toBe(100);
    expect(take(2, (at) => data.readUInt16LE(at))).toBe(10_000);
    expect(take(1, (at) => data[at])).toBe(1);
    expect(take(2, (at) => data.readUInt16LE(at))).toBe(1_500);
    expect(take(1, (at) => data[at])).toBe(1);
    expect(take(2, (at) => data.readUInt16LE(at))).toBe(30);
    expect(take(2, (at) => data.readUInt16LE(at))).toBe(600);
    expect(take(2, (at) => data.readUInt16LE(at))).toBe(5_000);
    expect(take(4, (at) => data.readUInt32LE(at))).toBe(40_000);
    expect(take(4, (at) => data.readUInt32LE(at))).toBe(350_000);
    expect(o).toBe(data.length);
  });

  test("a zero is sent as present, not skipped", () => {
    // `variableFeeControl: 0` is how the variable fee is switched off, so
    // treating a falsy value as absent would make it unsettable.
    const data = updateConfigIx(AUTHORITY, CONFIG, { variableFeeControl: 0 }).data;
    expect(data.length).toBe(8 + FIELD_COUNT + 4);
    expect(data[8 + 9]).toBe(1);
    expect(data.readUInt32LE(8 + 10)).toBe(0);
  });

  test("the authority signs and only the config is written", () => {
    const ix = updateConfigIx(AUTHORITY, CONFIG, { baseFactor: 1 });
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
    expect(ix.keys).toHaveLength(2);
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: false });
    expect(ix.keys[0].pubkey.equals(AUTHORITY)).toBe(true);
    expect(ix.keys[1]).toMatchObject({ isSigner: false, isWritable: true });
    expect(ix.keys[1].pubkey.equals(CONFIG)).toBe(true);
  });
});

describe("validateConfig", () => {
  test("a config straight from buildConfig is accepted", () => {
    expect(validateConfig(buildConfig(0, 25, Infinity))).toEqual([]);
    expect(validateConfig(buildConfig(1, 100, 4_000))).toEqual([]);
    expect(validateConfig(buildConfig(2, 200, 1_500))).toEqual([]);
  });

  test("each rule the program enforces is reported", () => {
    const base = buildConfig(0, 25, Infinity);
    const broken = (over: Partial<typeof base>) => validateConfig({ ...base, ...over });

    expect(broken({ protocolShare: MAX_PROTOCOL_SHARE + 1 })).toHaveLength(1);
    expect(broken({ baseFactor: 0 })).toHaveLength(1);
    expect(broken({ baseFeePowerFactor: 11 })).toHaveLength(1);
    expect(broken({ reductionFactor: 10_001 })).toHaveLength(1);
    expect(broken({ filterPeriod: 900, decayPeriod: 600 })).toHaveLength(1);
    expect(broken({ collectFeeMode: 2 })).toHaveLength(1);
    // A control with no ceiling can never engage: a mistake, not a disable.
    expect(broken({ variableFeeControl: 40_000, maxVolatilityAccumulator: 0 })).toHaveLength(1);
    // Which is why zeroing the control *is* how you disable it.
    expect(broken({ variableFeeControl: 0, maxVolatilityAccumulator: 0 })).toEqual([]);
  });

  test("a band outside what the ladder supports is reported", () => {
    const base = buildConfig(0, 100, 4_000);
    expect(validateConfig({ ...base, maxBinId: base.maxBinId + 1_000 })).toHaveLength(1);
    expect(validateConfig({ ...base, minBinId: base.minBinId - 1_000 })).toHaveLength(1);
    // Narrower than the widest is fine — it can be widened later on chain.
    expect(validateConfig({ ...base, minBinId: -100, maxBinId: 100 })).toEqual([]);
  });

  test("an empty band is reported", () => {
    const base = buildConfig(0, 25, Infinity);
    expect(validateConfig({ ...base, minBinId: 100, maxBinId: 100 }).length).toBeGreaterThan(0);
  });
});
