/**
 * WebSocket listener for ScheduleReviewTrigger contract events.
 * Subscribes via eth_subscribe and posts schedule IDs to HCS topics on event.
 */

import {
  Client,
  TopicMessageSubmitTransaction,
  PrivateKey,
} from "@hashgraph/sdk";
import { AbiCoder } from "ethers";
import type { Config } from "./config.js";
import WebSocket from "ws";

const REVIEW_TRIGGERED_ABI = ["string", "string", "string"];

/** Parse ECDSA hex or DER private key; matches createAgentAccounts key format. */
function parsePrivateKey(keyStr: string): PrivateKey {
  const trimmed = String(keyStr).trim();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return PrivateKey.fromStringECDSA(hex);
  }
  if (PrivateKey.isDerKey(trimmed)) {
    return PrivateKey.fromStringDer(trimmed);
  }
  return PrivateKey.fromStringECDSA(hex);
}

export interface Listener {
  start(): Promise<void>;
}

export function createListener(config: Config): Listener {
  return new ScheduleListener(config);
}

class ScheduleListener implements Listener {
  private readonly config: Config;
  private ws: WebSocket | null = null;
  private subscriptionId: string | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private lastProcessedBlock: string | null = null;
  private hederaClient: Client | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  async start(): Promise<void> {
    const operatorKey = parsePrivateKey(this.config.hederaOperatorPrivateKey);
    this.hederaClient = Client.forName(this.config.hederaNetwork)
      .setOperator(
        this.config.hederaOperatorAccountId,
        operatorKey
      );
    await this.connect();
  }

  private async connect(): Promise<void> {
    const { rpcRelayWsUrl, rpcRelayHttpUrl, scheduleReviewTriggerContractAddress } =
      this.config;

    await this.runBackfill(rpcRelayHttpUrl, scheduleReviewTriggerContractAddress);

    console.log(`Connecting to RPC Relay: ${rpcRelayWsUrl}`);
    this.ws = new WebSocket(rpcRelayWsUrl);

    this.ws.on("open", () => {
      console.log("WebSocket connected");
      this.reconnectAttempt = 0;
      this.subscribe(scheduleReviewTriggerContractAddress);
      this.startPing();
    });

    this.ws.on("message", (data: Buffer) => {
      this.handleMessage(data.toString());
    });

    this.ws.on("pong", () => {
      this.clearPongTimeout();
    });

    this.ws.on("close", (code, reason) => {
      this.cleanup();
      console.warn(`WebSocket closed: ${code} ${reason}`);
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error("WebSocket error:", err);
    });
  }

  private sendPing(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const pongTimeoutMs = this.config.wsPongTimeoutMs;
    if (pongTimeoutMs > 0) {
      this.clearPongTimeout();
      this.pongTimeout = setTimeout(() => {
        console.warn("Pong timeout, terminating connection");
        this.ws?.terminate();
      }, pongTimeoutMs);
    }

    this.ws.ping();
  }

  private startPing(): void {
    this.stopPing();
    const interval = this.config.wsPingIntervalMs;
    if (interval <= 0) return;

    console.log(`WebSocket keepalive: ping every ${interval}ms`);
    this.sendPing();
    this.pingInterval = setInterval(() => this.sendPing(), interval);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.clearPongTimeout();
  }

  private clearPongTimeout(): void {
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  private cleanup(): void {
    this.stopPing();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }
    this.subscriptionId = null;
  }

  private async runBackfill(
    httpUrl: string,
    contractAddress: string
  ): Promise<void> {
    if (!this.lastProcessedBlock) {
      return;
    }

    console.log(`Running backfill from block ${this.lastProcessedBlock}...`);

    const addr = contractAddress.startsWith("0x")
      ? contractAddress
      : `0x${contractAddress}`;
    const next = BigInt(this.lastProcessedBlock) + 1n;
    const fromBlock = `0x${next.toString(16)}`;

    const logs = await this.ethGetLogs(httpUrl, addr, fromBlock, "latest");
    console.log(
      logs.length > 0
        ? `Backfilling ${logs.length} missed event(s) from block ${this.lastProcessedBlock}`
        : `Backfill complete: 0 missed events (from block ${this.lastProcessedBlock})`
    );

    for (const log of logs) {
      await this.handleLog(log as LogResult);
    }
  }

  private async ethRpc<T>(url: string, method: string, params: unknown[]): Promise<T | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
        }),
        signal: controller.signal,
      });
      const json = (await res.json()) as { result?: T; error?: { message: string } };
      if (json.error) {
        console.warn(`RPC ${method} error:`, json.error.message);
        return null;
      }
      return json.result ?? null;
    } catch (err) {
      console.warn(`RPC ${method} failed:`, err);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async ethBlockNumber(url: string): Promise<bigint | null> {
    const hex = await this.ethRpc<string>(url, "eth_blockNumber", []);
    return hex ? BigInt(hex) : null;
  }

  private async ethGetLogs(
    url: string,
    address: string,
    fromBlock: string,
    toBlock: string
  ): Promise<LogResult[]> {
    const result = await this.ethRpc<LogResult[]>(url, "eth_getLogs", [
      { address, topics: [], fromBlock, toBlock },
    ]);
    return result ?? [];
  }

  private subscribe(contractAddress: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // ReviewTriggered(string,string[]) - topic[0] is event signature hash
    const params = [
      "logs",
      {
        address: contractAddress.startsWith("0x") ? contractAddress : `0x${contractAddress}`,
        topics: [], // Subscribe to all events from this contract
      },
    ];

    const msg = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_subscribe",
      params,
    };

    this.ws.send(JSON.stringify(msg));
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as {
        id?: number;
        method?: string;
        params?: { subscription: string; result: unknown };
        result?: string;
      };

      if (msg.result && typeof msg.result === "string") {
        this.subscriptionId = msg.result;
        console.log("Subscribed, subscription ID:", this.subscriptionId);
        return;
      }

      if (msg.method === "eth_subscription" && msg.params?.result) {
        this.handleLog(msg.params.result as LogResult);
      }
    } catch (err) {
      console.error("Failed to parse message:", err);
    }
  }

  private async handleLog(log: LogResult): Promise<void> {
    if (!log.data) {
      console.warn("Event has no data, skipping");
      return;
    }

    let scheduleId: string;
    let topicIds: string[];

    try {
      const abiCoder = AbiCoder.defaultAbiCoder();
      const decoded = abiCoder.decode(REVIEW_TRIGGERED_ABI, log.data);
      scheduleId = decoded[0] as string;
      const topicId1 = decoded[1] as string;
      const topicId2 = decoded[2] as string;
      topicIds = [topicId1, topicId2];
    } catch (err) {
      console.error("Failed to decode event:", err);
      return;
    }

    if (log.blockNumber) {
      this.lastProcessedBlock = typeof log.blockNumber === "string"
        ? (log.blockNumber.startsWith("0x") ? String(BigInt(log.blockNumber)) : log.blockNumber)
        : String(log.blockNumber);
    }

    console.log(`ReviewTriggered: scheduleId=${scheduleId}, topicIds=[${topicIds.join(", ")}]`);
    await this.postToTopics(scheduleId, topicIds);
  }

  private async postToTopics(scheduleId: string, topicIds: string[]): Promise<void> {
    if (!this.hederaClient) {
      console.error("Hedera client not initialized");
      return;
    }

    const message = JSON.stringify({ scheduleId });

    for (const topicId of topicIds) {
      try {
        const tx = await new TopicMessageSubmitTransaction()
          .setTopicId(topicId)
          .setMessage(message)
          .execute(this.hederaClient);

        const receipt = await tx.getReceipt(this.hederaClient);
        console.log(`Posted to topic ${topicId}: status=${receipt.status}`);
      } catch (err) {
        console.error(`Failed to post to topic ${topicId}:`, err);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;

    const { wsReconnectBaseMs, wsReconnectMaxMs } = this.config;
    const delay = Math.min(
      wsReconnectBaseMs * Math.pow(2, this.reconnectAttempt) +
        Math.random() * 2000,
      wsReconnectMaxMs
    );
    this.reconnectAttempt++;

    console.log(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt})...`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect().catch((err) => console.error("Reconnect failed:", err));
    }, delay);
  }
}

interface LogResult {
  address?: string;
  topics?: string[];
  data?: string;
  blockNumber?: string;
  transactionHash?: string;
}
