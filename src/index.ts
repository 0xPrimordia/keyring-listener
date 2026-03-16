#!/usr/bin/env node
/**
 * Keyring Schedule Listener
 *
 * Connects to Hedera JSON-RPC Relay via WebSocket (eth_subscribe),
 * listens for ReviewTriggered(scheduleId, topicIds) events from the
 * ScheduleReviewTrigger contract, and posts the schedule ID to each
 * HCS inbound topic.
 *
 * Deploys as a Render Background Worker.
 */

import "dotenv/config";
import { loadConfig } from "./config.js";
import { createListener } from "./listener.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const listener = createListener(config);
  await listener.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
