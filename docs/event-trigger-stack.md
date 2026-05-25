# Event Trigger Stack (Separate Stack)

This document describes the **upstream event trigger stack** that notifies the passive agent when to review a specific scheduled transaction. This is a **separate stack** from the keyring-passive-agent and is not a concern of this repo.

## Overview

The passive agent subscribes to an HCS inbound topic and reacts when it receives a message. Each agent has its own **private inbound topic** (only the project operator can submit). The **trigger sends the schedule ID** that needs review—the agent processes only that schedule, not all pending schedules. The contract event includes the **topic IDs** for each agent in the threshold list; the listener posts the schedule ID to each of those inbound topics.

```
[Scheduled contract executes at interval]
         ↓
[Emits event on-chain (includes schedule ID + topic IDs)]
         ↓
[Listener: RPC Relay eth_subscribe]
         ↓
[Posts schedule ID to each HCS inbound topic from event]
         ↓
[Passive agent receives → processes that schedule only]
```

### Message Format

The trigger posts a message containing the schedule ID. Supported formats:

- JSON: `{"scheduleId": "0.0.1234"}` or `{"schedule_id": "0.0.1234"}`
- Plain: `0.0.1234`

## Why Contract Can't Trigger Directly

Smart contracts run in the EVM sandbox and **cannot make HTTP calls**. They can only:

- Emit events
- Call other contracts
- Use Hedera system contracts (HSS, HTS, etc.)

So an off-chain listener is required to bridge the contract event to the agent's inbound topic.

## Hedera Solution: RPC Relay + eth_subscribe

The Hedera JSON-RPC Relay supports **`eth_subscribe`** (HIP-694) for real-time contract events via WebSocket. This is Hedera's equivalent to Alchemy-style hooks.

| Alchemy Hooks | Hedera RPC Relay |
|---------------|------------------|
| HTTP webhook: Alchemy POSTs to your URL when events occur | WebSocket: you maintain a connection, events pushed over it |
| No persistent connection | Persistent WebSocket connection |
| You expose an HTTP endpoint | You run a client that connects to the Relay |

### eth_subscribe Example

Connect to the Relay WebSocket and subscribe to contract logs:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "eth_subscribe",
  "params": [
    "logs",
    {
      "address": "0x...",
      "topics": ["0x..."]
    }
  ]
}
```

When a matching event occurs, the Relay pushes it over the WebSocket. Use `eth_unsubscribe` to cancel.

**References:**

- [HIP-694: Real-time events in JSON-RPC Relay](https://hips.hedera.com/hip/hip-694)
- [Hgraph JSON-RPC Relay](https://docs.hgraph.com/json-rpc/overview)

## Listener Implementation Options

| Approach | How it works | Pros | Cons |
|----------|--------------|------|------|
| **Custom listener** | Small process connects to RPC Relay WebSocket, subscribes to contract events, posts to HCS topic on event | Full control, single process | You run and maintain it |
| **Mirror node + indexer** | Mirror node streams events; indexer or webhook service forwards to HCS | Uses existing infra | More moving parts |
| **Managed RPC** | Use Hgraph or Validation Cloud WebSocket endpoint instead of self-hosted Relay | No Relay ops | Depends on provider |

## Recommended Flow

1. **Scheduled contract** runs at the desired interval (e.g. via HSS `scheduleCall` or `scheduleCallWithPayer`).
2. Contract **emits an event** when it executes (event should include the schedule ID that needs review).
3. **Listener service** maintains WebSocket connection to Hedera RPC Relay, subscribes via `eth_subscribe` to that contract's events.
4. On event: listener **extracts the schedule ID and topic IDs** from the event and **posts the schedule ID to each HCS inbound topic** listed in the event (using Hedera SDK `TopicMessageSubmitTransaction`). The operator has permission to post to those topics when the event targets those agents.
5. **Passive agent** receives the message, parses the schedule ID, and processes only that schedule.

The agent stays simple: it only reacts to inbound topic messages and processes the specific schedule ID provided. No timers, no API, same flow for many agents.

## Self-Invoking Contract Patterns (HSS scheduleCall)

Contracts can use HSS `scheduleCall` (HIP-1215) to schedule future execution. Key behaviors:

### Init per transaction

Each `scheduleCall` creates a **new** schedule entity. Any transaction (user call, contract call, or prior scheduled execution) can trigger a new schedule. Multiple independent schedules can run in parallel.

### Run once vs. infinite repeat

| Pattern | Behavior |
|---------|----------|
| **Run once** | Scheduled function does its work and does **not** call `scheduleCall` at the end. |
| **Infinite repeat** | Scheduled function calls `scheduleCall` at the end to schedule the next run. |
| **Limited runs** | Track a counter; only call `scheduleCall` when `runsRemaining > 0`. |

The contract logic controls whether execution continues or stops.

### Schedule limits

- **Max future window**: 62 days (5,356,800 seconds).
- **Cost**: Same per cycle regardless of expiry (1 min vs 7 days). Longer intervals = fewer cycles = lower total cost over time.

## Listener Deployment: Relay Options

### Hgraph (recommended)

- **Endpoints**: `wss://testnet.hedera.api.hgraph.io/v1/<API_KEY>/rpc`, `https://testnet.hedera.api.hgraph.io/v1/<API_KEY>/rpc`
- Set `HGRAPH_PUBLIC_KEY` in `.env`; URLs are built automatically per network.
- [Hgraph JSON-RPC docs](https://docs.hgraph.com/json-rpc/overview)

### Hashio (dev/test fallback)

- **Endpoints**: `wss://testnet.hashio.io/ws`, `wss://mainnet.hashio.io/ws`
- **No sign-up**; free for development.
- **Not for production**—use Hgraph or self-hosted relay.
- **Unreliable**—frequent 502s and 1006 closures on testnet.

### Performance

- **Latency**: Relay polls Mirror node at most every 2 seconds (HIP-694). Expect ~1–2 seconds from consensus to event delivery.
- **Worker load**: One WebSocket connection, low CPU/memory.
- **Reliability**: Implement reconnection and re-subscribe logic; subscriptions may have TTL.

### Render deployment

The listener is a **Background Worker** (not a Web Service)—long-running process, no HTTP, runs continuously.

### Listener environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HEDERA_OPERATOR_ACCOUNT_ID` | Yes | Operator account (must have submit permission on agent inbound topics) |
| `HEDERA_OPERATOR_PRIVATE_KEY` | Yes | Operator private key (never commit to source) |
| `SCHEDULE_REVIEW_TRIGGER_CONTRACT_ADDRESS` | Yes | Deployed contract address (EVM format, e.g. `0x...`) |
| `HEDERA_NETWORK` | No | `testnet` or `mainnet` (default: `testnet`) |
| `HGRAPH_PUBLIC_KEY` | No | Hgraph API key; when set, relay URLs use Hgraph (recommended) |
| `RPC_RELAY_WS_URL` | No | WebSocket URL (default: Hgraph when key set, else Hashio) |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` (default: `info`) |
| `WS_RECONNECT_BASE_MS` | No | Base delay for exponential backoff (default: 3000) |
| `WS_RECONNECT_MAX_MS` | No | Max reconnect delay cap (default: 60000) |
| `WS_PING_INTERVAL_MS` | No | JSON-RPC keepalive interval (`eth_blockNumber`); 0 = disabled (default: 60000) |
| `WS_PONG_TIMEOUT_MS` | No | Unused (default: 0) |
| `RPC_RELAY_HTTP_URL` | No | HTTP URL for eth_getLogs backfill (default: Hgraph or derived from WS URL) |

See `.env.example` and [docs/testnet-hardening.md](testnet-hardening.md) for WebSocket hardening.

### Event backfill on reconnect

When the WebSocket disconnects, events during the outage are missed. On reconnect, the listener calls `eth_getLogs` over HTTP to backfill missed events from `lastKnownBlock + 1` to `latest`, then resubscribes. `lastKnownBlock` is updated from contract events and from `eth_blockNumber` keepalive responses, so backfill works even if no events have been processed yet. Backfill is skipped on the very first connection (no baseline block yet).

## ScheduleReviewTrigger Contract

The contract lives in `hardhat/contracts/ScheduleReviewTrigger.sol` in this repo.

### Behavior

- **`scheduleReviewTrigger(string scheduleId, uint256 durationSeconds, string topicId1, string topicId2)`** — payable, requires 1 HBAR
- User passes the schedule ID to review (e.g. `"0.0.1234"`), delay in seconds, and **two HCS inbound topic IDs** for the agents in the threshold list
- Contract schedules a one-time call to `emitReviewTrigger(scheduleId, topicId1, topicId2)` at `now + durationSeconds`
- When the schedule runs, it emits **`ReviewTriggered(string scheduleId, string topicId1, string topicId2)`**
- Listener subscribes to this event and posts the schedule ID to **each** HCS inbound topic (topicId1, topicId2)

The topic IDs correspond to each agent's private inbound topic in the threshold list. The operator has permission to post to those topics when the emitted event targets those agents.

### Build & Deploy

```bash
npm run contracts:build
# Set HEDERA_DEPLOYER_PRIVATE_KEY in .env, then:
npm run contracts:deploy
```

Deploy with 1 HBAR to fund the contract (it pays gas when the scheduled call executes). The contract must hold HBAR to act as payer for the HSS schedule.

### Event for Listener

Subscribe to `ReviewTriggered(string, string, string)` — the `scheduleId` is the value to post; `topicId1` and `topicId2` are the HCS inbound topics to post to (one per agent in the threshold list).

## Related HIPs

- [HIP-755](https://hips.hedera.com/hip/hip-755) – Schedule Service system contract
- [HIP-756](https://hips.hedera.com/hip/hip-756) – Contract scheduled token create
- [HIP-1215](https://hips.hedera.com/hip/hip-1215) – Generalized scheduled contract calls (scheduleCall, etc.)
- [Hedera Schedule Service docs](https://docs.hedera.com/hedera/core-concepts/smart-contracts/system-smart-contracts/hedera-schedule-service)
