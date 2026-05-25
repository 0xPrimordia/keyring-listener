# Testnet Hardening for Schedule Listener

Research and recommendations for hardening the listener against Hashio testnet instability (1006 closures, 502s). For mainnet, use a commercial relay or self-hosted relay.

## 1. Exponential Backoff with Jitter

**Problem:** Fixed 5s reconnect hammers the server during outages; multiple clients reconnecting simultaneously causes "thundering herd."

**Solution:** Exponential backoff with random jitter.

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Base delay | 2–5 s | Start gentle |
| Max delay | 60 s | Cap to avoid long outages |
| Growth factor | 2 | Standard exponential |
| Jitter | 0–2 s random | Spread reconnects across clients |

**Formula:** `min(base * 2^attempt + jitter, max)`

Reset `attempt` to 0 on successful connection + successful resubscribe.

## 2. JSON-RPC Keepalive

**Problem:** Hgraph/Hiero relay closes idle WebSocket connections after ~5 minutes with code `4002 Connection timeout expired`. WebSocket protocol `ping()` frames do **not** reset the relay's inactivity timer — only JSON-RPC traffic does.

**Solution:** Send `eth_blockNumber` over the open WebSocket every 60s (well under the 5 min TTL). Responses also track the latest block for reconnect backfill.

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Keepalive interval | 60 s | Safely under 300 s relay inactivity TTL |
| Method | `eth_blockNumber` | Lightweight; resets activity + tracks block height |

**Note:** Hashio may behave differently. WebSocket `ping()` is not used.

## 3. Connection State Cleanup

**Problem:** On close/error, old WebSocket and timers can leak or cause double-connect.

**Solution:**
- Clear `reconnectTimeout` before scheduling new one
- Null out `ws` and remove listeners before reconnecting
- Call `ws.terminate()` (not `close`) to force cleanup on suspected-dead connections

## 4. Resubscribe on Reconnect

**Problem:** After reconnect, the old subscription ID is invalid. Must call `eth_subscribe` again.

**Solution:** Already implemented—we call `subscribe()` in the `open` handler. Ensure we don't send duplicate subscribe if `open` fires twice.

## 5. eth_getLogs Backfill (Implemented)

**Problem:** Events that occur during the disconnection window are missed.

**Solution:** On reconnect, call `eth_getLogs` over HTTP with `fromBlock` = last known block + 1, `toBlock` = `latest`, and the same address filter. Process any missed events before resubscribing. Backfill runs only on reconnect—not on startup—so events prior to listener start are ignored.

**Config:** `RPC_RELAY_HTTP_URL` (default: derived from WS URL, e.g. `https://testnet.hashio.io/api`).

## 6. Max Reconnect Attempts (Optional)

**Problem:** Infinite reconnect can waste resources if Hashio is down for hours.

**Solution:** Cap attempts (e.g. 50); after max, wait longer (e.g. 5 min) and reset counter. Or exit with error and let process manager (e.g. Render) restart.

**Recommendation:** For Render worker, let it run indefinitely; Render will restart on crash. Capping is optional.

## 7. Configurable Parameters

Expose via env for tuning without code changes:

| Env | Default | Description |
|-----|---------|-------------|
| `WS_RECONNECT_BASE_MS` | 3000 | Base delay for exponential backoff |
| `WS_RECONNECT_MAX_MS` | 60000 | Max delay cap |
| `WS_PING_INTERVAL_MS` | 60000 | JSON-RPC keepalive interval (0 = disabled) |
| `WS_PONG_TIMEOUT_MS` | 0 | Unused (kept for compatibility) |

## Implementation Summary

1. **Exponential backoff + jitter** in `scheduleReconnect()`
2. **JSON-RPC keepalive** via `eth_blockNumber` on the WebSocket when connected
3. **Cleanup** on close: remove listeners, clear ping interval, null ws
4. **Config** for base/max delay, ping interval (optional)
