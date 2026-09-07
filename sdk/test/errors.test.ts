/**
 * The TypeScript error table against the Rust one it copies.
 *
 * `crates/taper-core/src/errors.rs` holds a single `taper_error_table!` macro
 * that expands into both Rust enums, so the program and the core crate cannot
 * drift from each other. This package is a third consumer and cannot share the
 * macro, so it is checked against its text instead — name, order and message,
 * which together are the whole of what a client needs and exactly what is ABI.
 *
 * Parsing Rust source in a test is the same trade the account parsers make:
 * an independent re-derivation is only worth having if something proves it
 * still agrees.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ERROR_CODE_OFFSET, TAPER_ERRORS, describeError, errorCodeFor, errorForCode } from "../src/errors";

const SOURCE = join(import.meta.dir, "..", "..", "crates", "taper-core", "src", "errors.rs");

/** The `Name, "message";` rows inside `macro_rules! taper_error_table`. */
function rustTable(): { name: string; message: string }[] {
  const text = readFileSync(SOURCE, "utf8");
  const start = text.indexOf("macro_rules! taper_error_table");
  expect(start).toBeGreaterThan(-1);
  const body = text.slice(start);
  const end = body.indexOf("\n}");
  const rows = [...body.slice(0, end).matchAll(/^\s{12}([A-Z][A-Za-z]*), "(.*)";$/gm)];
  return rows.map((m) => ({ name: m[1], message: m[2] }));
}

describe("the error table", () => {
  test("matches taper_error_table, entry for entry", () => {
    const rust = rustTable();
    expect(rust.length).toBeGreaterThan(0);
    expect(TAPER_ERRORS.map((e) => ({ name: e.name, message: e.message }))).toEqual(rust);
  });

  test("numbers variants the way Anchor does", () => {
    expect(errorCodeFor("MathOverflow")).toBe(ERROR_CODE_OFFSET);
    expect(errorForCode(ERROR_CODE_OFFSET)?.name).toBe("MathOverflow");
    const last = TAPER_ERRORS[TAPER_ERRORS.length - 1];
    expect(errorForCode(ERROR_CODE_OFFSET + TAPER_ERRORS.length - 1)?.name).toBe(last.name);
    expect(errorForCode(ERROR_CODE_OFFSET + TAPER_ERRORS.length)).toBeUndefined();
  });
});

describe("describeError", () => {
  const slippage = errorCodeFor("SlippageExceeded")!;

  test("prefers the program's own log line", () => {
    const message = describeError(new Error("Transaction simulation failed"), [
      "Program log: AnchorError occurred. Error Code: SlippageExceeded. Error Number: 6020. Error Message: Swap output is below the caller's minimum."
    ]);
    expect(message).toBe("Swap output is below the caller's minimum.");
  });

  test("decodes the bare number when no logs came through", () => {
    expect(describeError(new Error(`custom program error: 0x${slippage.toString(16)}`))).toBe(
      "Swap output is below the caller's minimum"
    );
  });

  test("finds the code in a structured InstructionError", () => {
    const error = new Error("failed");
    (error as { cause?: unknown }).cause = { InstructionError: [2, { Custom: slippage }] };
    expect(describeError(error)).toBe("Swap output is below the caller's minimum");
  });

  test("does not claim a code from another program", () => {
    // 1 is the SPL Token program's InsufficientFunds, not a Taper error.
    expect(describeError(new Error("custom program error: 0x1"))).toBe("The program returned error 1.");
  });

  test("falls through to the raw message for a non-program failure", () => {
    expect(describeError(new Error("Blockhash not found"))).toBe("Blockhash not found");
  });
});
