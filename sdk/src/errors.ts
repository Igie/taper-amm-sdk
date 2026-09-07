/**
 * The program's error table, as a client sees it.
 *
 * A wallet hands back `{ InstructionError: [i, { Custom: 6019 }] }` and
 * nothing else. The program's own log line names the guard — `Error Message:
 * Deposit produced zero liquidity shares` — but logs are not always carried
 * through an adapter, and a simulation failure often arrives with the number
 * alone. So the number has to be decodable on its own, which means the table
 * has to exist on this side too.
 *
 * **This is a copy, and it is checked.** `crates/taper-core/src/errors.rs`
 * holds the one table the two Rust enums are generated from; a variant's
 * position there is its error number, `6000 + index`, as Anchor assigns them.
 * `sdk/test/errors.test.ts` parses that macro and fails if this list drifts
 * from it in name, order or message — the same arrangement as the account
 * offsets in `accounts.ts`, and for the same reason: an external client that
 * silently agrees with the program is worth less than one that is made to
 * prove it.
 *
 * **Append, never reorder.**
 */

/** What Anchor adds to a variant's position to get its on-chain code. */
export const ERROR_CODE_OFFSET = 6000;

export type TaperErrorName = (typeof TAPER_ERRORS)[number]["name"];

/** Every `TaperError` variant, in declaration order. Index + 6000 is the code. */
export const TAPER_ERRORS = [
  { name: "MathOverflow", message: "Arithmetic overflow" },
  { name: "DivideByZero", message: "Division by zero" },
  { name: "PriceOutOfRange", message: "Price is outside the representable Q64.64 range" },
  { name: "BinIdOutOfRange", message: "Bin id is outside the config's supported range" },
  { name: "InvalidTaper", message: "Taper factor must be in (MIN_TAPER, 1.0]" },
  { name: "InvalidBaseWidth", message: "Base bin width produces a step outside [0.01 bps, 400 bps]" },
  { name: "InvalidBinRange", message: "Bin width at the range bounds is outside [0.01 bps, 400 bps]" },
  { name: "InvalidFeeParameters", message: "Invalid fee parameters" },
  { name: "InvalidProtocolShare", message: "Protocol share exceeds the 25% cap" },
  { name: "InvalidMintOrder", message: "Token mints must be distinct and sorted" },
  { name: "InvalidBinArrayIndex", message: "Bin array index does not match the bin ids it must cover" },
  { name: "BinArrayPoolMismatch", message: "Bin array does not belong to this pool" },
  { name: "MissingBinArray", message: "A bin array required by this operation was not supplied" },
  { name: "PositionTooWide", message: "Position range is wider than a position can hold" },
  { name: "BinIdOutsidePosition", message: "Bin id lies outside the position's range" },
  { name: "InvalidDistribution", message: "Liquidity distribution must sum to at most 10_000 bps per side" },
  { name: "DepositXBelowActiveBin", message: "Cannot deposit token X into a bin below the active bin" },
  { name: "DepositYAboveActiveBin", message: "Cannot deposit token Y into a bin above the active bin" },
  { name: "ZeroLiquidity", message: "Deposit produced zero liquidity shares" },
  { name: "InsufficientLiquidity", message: "Insufficient liquidity to fill the swap" },
  { name: "SlippageExceeded", message: "Swap output is below the caller's minimum" },
  { name: "ZeroAmount", message: "Swap amount must be greater than zero" },
  { name: "PositionNotEmpty", message: "Position still holds liquidity, fees or rewards" },
  { name: "PoolDisabled", message: "Pool is disabled for this operation" },
  { name: "UnauthorizedPositionOwner", message: "Caller is not the position owner" },
  { name: "UnauthorizedAuthority", message: "Caller is not the config authority" },
  { name: "SwapBinLimitExceeded", message: "Swap walked more bins than one instruction allows" },
  { name: "BinArrayNotEmpty", message: "Bin array is not empty and cannot be closed" },
  { name: "UnsupportedMintExtension", message: "Mint carries a Token-2022 extension this pool does not support" },
  { name: "TokenProgramMismatch", message: "Token program does not own the mint it was passed for" },
  { name: "BinRangeExceedsBitmap", message: "Config bin range reaches past the bin ids the pool bitmap can cover" },
  { name: "BandMayOnlyWiden", message: "A config's bin range may only be widened, never narrowed" },
  { name: "IncompleteFill", message: "Swap could not consume the whole input and strict fill was required" },
  { name: "PositionNotExtended", message: "Bin lies past the part of the position that has been allocated" },
  {
    name: "ResizeDropsLiquidity",
    message: "Resize would drop bins that still hold liquidity or fees"
  },
  {
    name: "ActiveBinOutOfBounds",
    message: "Active bin lies outside the bounds the caller required"
  }
] as const;

const BY_CODE = new Map(TAPER_ERRORS.map((e, i) => [ERROR_CODE_OFFSET + i, e]));
const BY_NAME = new Map(TAPER_ERRORS.map((e, i) => [e.name as string, ERROR_CODE_OFFSET + i]));

/** The code a named variant carries on chain, or `undefined` if it is not one. */
export const errorCodeFor = (name: string) => BY_NAME.get(name);

/** The variant a code names, or `undefined` for a code from another program. */
export const errorForCode = (code: number) => BY_CODE.get(code);

/**
 * Pulls a custom program error number out of whatever the wallet threw.
 *
 * Adapters wrap the RPC failure several layers deep and inconsistently, so
 * this looks in the two places the number reliably survives: the structured
 * `InstructionError` when it is there, and the rendered message when it is
 * not. A number outside this program's block is reported as-is — it belongs to
 * the token program or the system program, and pretending otherwise would put
 * a Taper error message on a failure Taper did not cause.
 */
export function customErrorCode(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  const walk = (value: unknown): number | undefined => {
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (typeof record.Custom === "number") return record.Custom;
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) {
        for (const item of child) {
          const found = walk(item);
          if (found !== undefined) return found;
        }
      }
      const found = walk(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const structured = walk(error instanceof Error ? (error as { cause?: unknown }).cause ?? {} : error);
  if (structured !== undefined) return structured;

  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const match = /custom program error:?\s*(?:0x([0-9a-f]+)|(\d+))/i.exec(text) ?? /"Custom"\s*:\s*(\d+)/.exec(text);
  if (!match) return undefined;
  return match[1] !== undefined ? parseInt(match[1], 16) : Number(match[2] ?? match[1]);
}

/**
 * The most useful sentence available for a failed instruction.
 *
 * Order matters and is the whole point: the program's own log line is the
 * best answer because it names the guard *and* the instruction that hit it, so
 * it is preferred whenever logs came through. The decoded number is the
 * fallback that works when they did not. The raw message is the last resort,
 * and is what a non-Taper failure — a missing account, an unfunded fee payer —
 * correctly ends up reporting.
 */
export function describeError(error: unknown, logs: string[] = []): string {
  const named = [...logs].reverse().find((line) => line.includes("Error Message:"));
  if (named) return named.replace(/^.*Error Message:\s*/, "").trim();

  const code = customErrorCode(error);
  if (code !== undefined) {
    const known = errorForCode(code);
    if (known) return known.message;
    return `The program returned error ${code}.`;
  }

  const anchor = [...logs].reverse().find((line) => line.includes("AnchorError"));
  if (anchor) return anchor.replace(/^Program log:\s*/, "").trim();

  if (error instanceof Error) {
    const nested = (error as { logs?: string[] }).logs;
    if (nested?.length && nested !== logs) return describeError(error, nested);
    return error.message;
  }
  return String(error);
}
