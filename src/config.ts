/**
 * Configuration loaded from environment variables.
 * See .env.example for required values.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export interface Config {
  hederaOperatorAccountId: string;
  hederaOperatorPrivateKey: string;
  hederaNetwork: "testnet" | "mainnet";
  rpcRelayWsUrl: string;
  /** HTTP URL for eth_getLogs backfill (derived from WS URL). */
  rpcRelayHttpUrl: string;
  scheduleReviewTriggerContractAddress: string;
  logLevel: string;
  /** Base delay (ms) for exponential backoff. Default 3000. */
  wsReconnectBaseMs: number;
  /** Max delay (ms) cap for backoff. Default 60000. */
  wsReconnectMaxMs: number;
  /** Ping interval (ms); 0 = disabled. Default 18000 (Hgraph idle timeout). */
  wsPingIntervalMs: number;
  /** Pong timeout (ms) before terminating; 0 = disabled. Default 0. */
  wsPongTimeoutMs: number;
}

function parsePositiveInt(value: string | undefined, defaultVal: number): number {
  if (!value) return defaultVal;
  const n = parseInt(value, 10);
  return Number.isNaN(n) || n < 0 ? defaultVal : n;
}

function getDefaultRelayUrls(network: "testnet" | "mainnet"): {
  ws: string;
  http: string;
} {
  const hgraphKey = process.env.HGRAPH_PUBLIC_KEY;
  if (hgraphKey) {
    const host =
      network === "mainnet"
        ? "mainnet.hedera.api.hgraph.io"
        : "testnet.hedera.api.hgraph.io";
    return {
      ws: `wss://${host}/v1/${hgraphKey}/rpc`,
      http: `https://${host}/v1/${hgraphKey}/rpc`,
    };
  }
  const ws =
    network === "mainnet"
      ? "wss://mainnet.hashio.io/ws"
      : "wss://testnet.hashio.io/ws";
  const http = ws.replace(/^wss:\/\//, "https://").replace(/\/ws$/, "/api");
  return { ws, http };
}

export function loadConfig(): Config {
  const network = optionalEnv("HEDERA_NETWORK", "testnet") as "testnet" | "mainnet";
  const defaults = getDefaultRelayUrls(network);
  // When HGRAPH_PUBLIC_KEY is set, always use Hgraph (ignore RPC_RELAY_* overrides)
  const useHgraph = Boolean(process.env.HGRAPH_PUBLIC_KEY);
  const wsUrl = useHgraph
    ? defaults.ws
    : optionalEnv("RPC_RELAY_WS_URL", defaults.ws);
  const httpUrl = useHgraph
    ? defaults.http
    : optionalEnv(
        "RPC_RELAY_HTTP_URL",
        (() => {
          const base = wsUrl.replace(/^wss:\/\//, "https://").replace(/\/ws$/, "");
          return base.endsWith("/api") ? base : `${base.replace(/\/$/, "")}/api`;
        })()
      );

  return {
    hederaOperatorAccountId: requireEnv("HEDERA_OPERATOR_ACCOUNT_ID"),
    hederaOperatorPrivateKey: requireEnv("HEDERA_OPERATOR_PRIVATE_KEY"),
    hederaNetwork: network,
    rpcRelayWsUrl: wsUrl,
    rpcRelayHttpUrl: httpUrl,
    scheduleReviewTriggerContractAddress: requireEnv(
      "SCHEDULE_REVIEW_TRIGGER_CONTRACT_ADDRESS"
    ),
    logLevel: optionalEnv("LOG_LEVEL", "info"),
    wsReconnectBaseMs: parsePositiveInt(process.env.WS_RECONNECT_BASE_MS, 3000),
    wsReconnectMaxMs: parsePositiveInt(process.env.WS_RECONNECT_MAX_MS, 60000),
    wsPingIntervalMs: parsePositiveInt(process.env.WS_PING_INTERVAL_MS, 18000),
    wsPongTimeoutMs: parsePositiveInt(process.env.WS_PONG_TIMEOUT_MS, 0),
  };
}
