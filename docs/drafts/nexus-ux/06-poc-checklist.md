---
id: nexus-ux-06-poc-checklist
title: 06 POC Acceptance Checklist (Scheme A+)
category: nexus-ux
created_at: 2026-02-22
author: Cortana + Serina
status: draft
---

# 06 POC Checklist (Scheme A+)

Status: DRAFT
Last updated: 2026-02-22

Purpose: define a minimal, testable acceptance checklist for the v1 POC of Scheme A+.

Scope:
- Redis Streams as durable log (source of truth)
- hub2d consumes via consumer group (XREADGROUP) and delivers via native WebSocket to nexus plugin
- nexus plugin routes into OpenClaw gateway via explicit sessionKey, then sends reply back via WS
- hub2d persists replies idempotently and exposes to UI (Socket.IO is optional for POC, but replay semantics must be verifiable)

Hard invariants:
- event_id is stable end-to-end and recommended to equal Redis stream message ID
- delivery is at-least-once, effects are idempotent (no duplicate persisted replies)

See also:
- [03-flows.md](03-flows.md) — End-to-end flow definitions
- [05-tech-slice.md](05-tech-slice.md) — WS protocol, DB schema, field naming

---

## Pre-Flight

- One room/topic stream exists (example: `stream:general`)
- hub2d has a consumer group for the stream
- hub2d has a persistence store (PostgreSQL preferred)
- nexus plugin can connect to hub2d WS endpoint
- plugin has a persisted `resume_token` (per room) and an in-memory recent-set dedupe

---

## Acceptance Tests (10)

### 1) End-to-End Happy Path (Single Message)

Steps:
- `XADD` one message into the target stream
- hub2d consumes it and pushes one `event` frame to the plugin
- plugin injects inbound into OpenClaw gateway session and produces a reply
- plugin sends `reply` frame to hub2d via WS

Expected:
- [ ] hub2d persists exactly 1 inbound event row with `event_id = stream_id`
- [ ] hub2d persists exactly 1 reply row linked to the same `event_id`
- [ ] plugin receives exactly 1 event (no duplicates)

---

### 2) Ordering (Two Messages Same Room)

Steps:
- `XADD` message A then message B to the same stream/room

Expected:
- [ ] plugin receives A then B in order
- [ ] hub2d persists inbound events with monotonic `event_id` (stream IDs) matching receive order

---

### 3) hub2d Crash Before XACK (PEL Replay)

Steps:
- Inject a message
- Force hub2d to crash after it has read the message but before it `XACK`s
- Restart hub2d

Expected:
- [ ] message is reclaimed from PEL (`XPENDING`/`XCLAIM` or equivalent)
- [ ] inbound event is persisted once (unique on `event_id`)
- [ ] plugin eventually receives the event (at-least-once)

---

### 4) hub2d Crash After Persist + Before Push

Steps:
- Inject a message
- Force hub2d to crash after persisting inbound event but before delivering it over WS
- Restart hub2d

Expected:
- [ ] hub2d does not lose the message
- [ ] plugin receives the event after restart (via backlog replay from DB or via re-consuming from Redis)
- [ ] no duplicate inbound persistence for the same `event_id`

---

### 5) WS Disconnect: Resume With resume_token

Steps:
- Ensure plugin has processed up to `event_id = X`
- Disconnect the plugin WS
- Inject messages X+1..X+n
- Reconnect plugin with `resume_token = X`

Expected:
- [ ] hub2d replays X+1..X+n to plugin in order
- [ ] plugin does not require manual intervention to catch up

---

### 6) Duplicate Delivery Over WS (Client Dedupe)

Steps:
- Make hub2d send the same event twice (simulate retransmit or bug)

Expected:
- [ ] plugin recent-set dedupe prevents double-injection into gateway
- [ ] gateway/agent runs once for that `event_id`

---

### 7) Reply Idempotency (Server Unique Constraint)

Steps:
- For one `event_id`, force plugin to send the same reply twice (simulate reconnect/resend)

Expected:
- [ ] hub2d stores only one reply record for that `event_id` (unique constraint holds)
- [ ] any duplicate send is treated as idempotent (ignored or updated deterministically)

---

### 8) Gateway Restart During Processing

Steps:
- Deliver one inbound event to plugin
- Restart OpenClaw gateway before the agent finishes
- Ensure plugin reconnect/replay path can re-drive processing

Expected:
- [ ] event is eventually processed and replied
- [ ] hub2d persists only one effective reply (idempotent)
- [ ] no permanent stuck state (retry path exists or operator can trigger retry)

---

### 9) Consumer Group Rebalance / Multi-Consumer Safety

Steps:
- Run two hub2d consumers (or two instances) in the same consumer group
- Inject a burst of messages

Expected:
- [ ] each stream entry is processed by exactly one consumer at a time
- [ ] no message loss
- [ ] duplicates, if any, are neutralized by `event_id` unique constraints

---

### 10) Observability And Operator Actions (Minimum)

Steps:
- For a normal message and for a failure case (one of tests 3/4/8), inspect metrics/logs/UI

Expected (minimum signals):
- [ ] can query by `event_id` and see state transitions: `received → persisted → delivered → replied`
- [ ] can see consumer offsets (last processed `stream_id`) and pending count
- [ ] can see WS connection status for plugin clients
- [ ] operator can trigger a retry/replay for a given `event_id` (even if via a simple admin endpoint)

---

## Pass Criteria

All 10 tests must pass before POC is considered complete.
Tests 1, 5, 7 are the minimum subset for a "smoke test" pass.
Tests 3, 4, 8 are required for reliability validation.
Tests 9, 10 are required before any multi-node deployment.
