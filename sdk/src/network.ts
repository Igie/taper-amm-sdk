/**
 * Which chain the client is talking to, and through which endpoint.
 *
 * This is the one piece of client configuration the SDK owns rather than
 * leaves to the caller, and it is here for a reason the rest of the package
 * makes obvious: everything else in `taper-amm-sdk` is network-independent by
 * construction. PDAs, instruction encodings, account offsets and the ladder
 * are the same bytes on every cluster, so a network is not a variant of the
 * ABI — it is a default endpoint, an explorer prefix, and a warning about
 * whether a mistake costs real money.
 *
 * **The program has one address on every network.** `taperAJP7…` is deployed
 * from the same keypair on devnet and mainnet, so `PROGRAM_ID` stays a
 * constant and every PDA in `pda.ts` derives without knowing the cluster. The
 * field is carried on the descriptor anyway, so a future divergence is a data
 * change rather than a signature change across the whole package.
 *
 * There is still no `Connection` here. A `Network` names an endpoint; opening
 * it is the caller's business, exactly as with every other module.
 *
 * `hasWebsocket` is the distinction that actually changes caller code: the
 * LiteSVM localnet has no subscription endpoint, so anything driving it must
 * poll `getSignatureStatuses` and must never call `confirmTransaction`.
 */
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./constants";

export type NetworkId = "mainnet-beta" | "devnet" | "localnet";

export type Network = {
  id: NetworkId;
  label: string;
  /** Where `taper-amm` lives on this network. The same key on all of them. */
  programId: PublicKey;
  /** The endpoint used when the caller does not name one. */
  defaultEndpoint: string;
  /** False on the LiteSVM localnet: poll statuses, never `confirmTransaction`. */
  hasWebsocket: boolean;
  /** Whether SOL can be had for nothing here. */
  faucet: boolean;
  /**
   * True where a mistake spends real money and cannot be undone. Callers use
   * it to decide whether to confirm twice, not to change what they build.
   */
  live: boolean;
};

const MAINNET: Network = {
  id: "mainnet-beta",
  label: "Mainnet",
  programId: PROGRAM_ID,
  // Deliberately the public endpoint, which rate-limits `getProgramAccounts`
  // hard: a default that quietly works for one user and fails for the next is
  // worse than one that is obviously in need of replacing.
  defaultEndpoint: "https://api.mainnet-beta.solana.com",
  hasWebsocket: true,
  faucet: false,
  live: true
};

const DEVNET: Network = {
  id: "devnet",
  label: "Devnet",
  programId: PROGRAM_ID,
  defaultEndpoint: "https://api.devnet.solana.com",
  hasWebsocket: true,
  faucet: true,
  live: false
};

const LOCALNET: Network = {
  id: "localnet",
  label: "Localnet",
  programId: PROGRAM_ID,
  defaultEndpoint: "http://127.0.0.1:8899",
  hasWebsocket: false,
  faucet: true,
  live: false
};

/** Every network, in the order a picker should list them: safest last. */
export const NETWORKS: Network[] = [MAINNET, DEVNET, LOCALNET];

export const NETWORK_IDS = NETWORKS.map((n) => n.id);

export const isNetworkId = (value: unknown): value is NetworkId =>
  typeof value === "string" && NETWORK_IDS.includes(value as NetworkId);

/** The descriptor for an id, or `undefined` for anything else. */
export const networkFor = (id: string | null | undefined): Network | undefined =>
  NETWORKS.find((n) => n.id === id);

/** A network with an endpoint actually chosen, default or otherwise. */
export type ResolvedNetwork = Network & {
  /** What this client is talking to. */
  endpoint: string;
  /** True when that is not `defaultEndpoint`. */
  overridden: boolean;
};

/**
 * Pins a network to an endpoint.
 *
 * An override equal to the default is not an override: a caller that stores
 * whatever is in its input box would otherwise flag the shipped endpoint as
 * the user's own.
 */
export function withEndpoint(network: Network, endpoint?: string): ResolvedNetwork {
  const chosen = endpoint?.trim() || network.defaultEndpoint;
  return { ...network, endpoint: chosen, overridden: chosen !== network.defaultEndpoint };
}

/**
 * A URL this client can actually talk to, or a sentence saying why not.
 *
 * Rejecting a WebSocket URL is worth doing explicitly rather than letting
 * web3.js fail later: `wss://` is what a provider's dashboard shows next to
 * the HTTP endpoint, and it is the easy one to copy by mistake.
 */
export function normaliseEndpoint(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter an RPC URL.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("That is not a URL. It should start with https://");
  }
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    throw new Error("That is the WebSocket endpoint. Use the HTTP one — it usually starts https://");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("An RPC endpoint has to be http:// or https://");
  }
  return url.toString().replace(/\/$/, "");
}

/** The host, for a status chip with no room for the whole URL. */
export function endpointLabel(endpoint: string) {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/**
 * Whether a failed read is the endpoint's fault rather than the chain's.
 *
 * Worth separating, because the two have opposite fixes and a client cannot
 * tell them apart from the result alone: an empty pool list on a throttled
 * endpoint looks exactly like a network with no pools on it.
 */
export function isEndpointFailure(message: string) {
  // The status codes are bounded so an address that happens to contain "429"
  // is not read as a rate limit.
  return /\b(429|403|410|50[234])\b|too many requests|rate.?limit|forbidden|unauthorized|method not (found|supported)|not enabled|excluded from account secondary indexes|failed to fetch|load failed|networkerror|fetch failed|econnrefused|socket hang up|timed? ?out/i.test(
    message
  );
}

/**
 * The query Solana Explorer needs to look at this network.
 *
 * Localnet is built from the endpoint rather than hardcoded, because the
 * localnet server picks its port and a link to the wrong one silently shows an
 * empty account.
 */
export function explorerQuery(network: Network | ResolvedNetwork): string {
  if (network.id === "mainnet-beta") return "";
  if (network.id === "devnet") return "?cluster=devnet";
  const endpoint = "endpoint" in network ? network.endpoint : network.defaultEndpoint;
  return `?cluster=custom&customUrl=${encodeURIComponent(endpoint)}`;
}

export const explorerAccount = (network: Network | ResolvedNetwork, address: PublicKey | string) =>
  `https://explorer.solana.com/address/${typeof address === "string" ? address : address.toBase58()}${explorerQuery(network)}`;

export const explorerTx = (network: Network | ResolvedNetwork, signature: string) =>
  `https://explorer.solana.com/tx/${signature}${explorerQuery(network)}`;
