/**
 * `@taper/sdk` — a client-side view of the `taper-amm` ABI.
 *
 * Written as an external client on purpose, exactly like `tests/src/lib.rs`:
 * discriminators are the constants Anchor generates, instructions are packed
 * by hand, and accounts are read by byte offset. Nothing here is imported from
 * the program, so a layout drift shows up as a broken client rather than as
 * silence.
 *
 * The ladder helpers are an independent `f64` re-derivation of the same
 * formulas, so what a caller draws or previews is a genuine cross-check of the
 * on-chain integer math and not an echo of it.
 *
 * There is deliberately no `Connection` or RPC layer here: the SDK builds
 * instructions and reads bytes, and leaves transport to the caller. That is
 * what lets the same code drive the WebSocket-less localnet, devnet and
 * mainnet from one build. `network.ts` names those three and their default
 * endpoints; it does not open any of them.
 */
export * from "./constants";
export * from "./network";
export * from "./errors";
export * from "./types";
export * from "./pda";
export * from "./ladder";
export * from "./instructions";
export * from "./accounts";
export * from "./mint";
export * from "./token";
export * from "./native";
export * from "./position";
export * from "./quote";
export * from "./plan";
export * from "./shapes";
export { Writer } from "./codec";
