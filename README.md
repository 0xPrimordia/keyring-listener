# Keyring Schedule Listener

Listens for `ReviewTriggered(scheduleId, topicIds)` events from the ScheduleReviewTrigger contract via Hedera JSON-RPC Relay (Hgraph) WebSocket, and posts the schedule ID to each HCS inbound topic.

## Setup

1. Copy `.env.example` to `.env` and fill in values.
2. `npm install`
3. `npm run build`
4. `npm start` (or `npm run dev` for development)

## Deploy to Render

Configure as a **Background Worker** using `render.yaml`. Set the environment variables in the Render dashboard (or via `render.yaml` envVars with `sync: false` for secrets).

## Docs

- [docs/event-trigger-stack.md](docs/event-trigger-stack.md) – architecture and flow
