---
id: nexus-ux-03-flows
title: 03 Core Flows (Scheme A+)
category: nexus-ux
created_at: 2026-02-22
author: Cortana + Serina
status: draft
---

# 03 Core Flows (Scheme A+)

Status: DRAFT
Last updated: 2026-02-22

This chapter defines the end-to-end runtime flows for the cloud-first Nexus hub ("hub2d") and OpenClaw Nexus channel plugin.

The current baseline is **Scheme A+**:
- **Redis Streams (Tencent Cloud)** is the durable event log (source of truth).
- **hub2d (cloud, same VPC)** consumes streams via **consumer group** and provides **WebSocket transport** + persistence + replay + admin/UI.
- **nexus plugin (each node)** connects to hub2d via **native WebSocket client** (thin, controlled protocol).
- **UI (cloud)** connects to hub2d via **Socket.IO** for presence/rooms/subscriptions (UX convenience; reliability still anchored on `event_id` + offsets).

See also: [ADR-011](adr/adr-011-cloud-arch-tech-stack.md) for tech stack rationale.

---

## 03.1 Actors And Channels

Actors:
- **Producer**: a node/user that creates a message (human or bot).
- **Redis Streams**: durable log; provides stream IDs (offsets).
- **hub2d**: cloud hub; stream consumer + persistence + transport + dedupe + replay.
- **Nexus plugin**: OpenClaw channel plugin; WS client; routes inbound to gateway sessions and sends replies back.
- **OpenClaw gateway**: routes to session/agent; emits streaming replies.
- **UI**: web console; subscribes to rooms, shows status/queues/retries.

Transport channels:
- **Plugin channel (reliability-critical)**: hub2d <-> nexus plugin over **native WS**.
- **UI channel (UX-oriented)**: hub2d <-> UI over **Socket.IO**.

---

## 03.2 Event Model (IDs, Ordering, Idempotency)

### `event_id` (Hard Requirement)
- `event_id` MUST be **stable end-to-end** and uniquely identify an inbound message.
- Recommendation: `event_id = <redis_stream_message_id>` (e.g. `1771731487783-0`).

### Ordering
- Ordering guarantee is **per room/topic** (or per stream key) as provided by Redis stream IDs.
- hub2d MUST preserve ordering when pushing to a single subscriber for the same room.

### Idempotency (Dual Layer)
- **Server-side**: hub2d persists inbound events and replies with a **unique constraint** on `event_id` (and optionally `event_id + reply_type`).
- **Client-side (plugin)**: nexus plugin keeps an in-memory recent-set of `event_id` to dedupe WS retransmits and reconnect replays.

Goal: "at-least-once delivery" + "exactly-once effect".

---

## 03.3 Ingestion Flow (Redis -> hub2d)

### Step-by-step
1) Producer appends message to Redis Stream
- `XADD stream:<room> * { ...payload... }`
- Redis returns `stream_id`.

2) hub2d consumes via consumer group
- hub2d uses `XGROUP CREATE` (one per stream/room, or one stream with room field).
- Reads via `XREADGROUP GROUP <group> <consumer> COUNT N BLOCK T STREAMS <stream> >`.

3) hub2d persists and materializes
- Persist inbound event:
  - `event_id = stream_id`
  - `room_id`, `from`, `text`, `attachments`, `ts`, etc.
- Persist consumer progress:
  - store last processed `stream_id` (per stream key and per group/consumer) to enable restart recovery.

4) hub2d ACKs (only after durable write)
- `XACK <stream> <group> <stream_id>` happens ONLY after hub2d has durably recorded the event.

### Notes
- If hub2d crashes before ACK, Redis will keep it in PEL (pending) and hub2d can reclaim via `XPENDING` + `XCLAIM`.
- This is the Redis-layer replay mechanism; it is independent from WS-layer replay.

---

## 03.4 Delivery Flow (hub2d -> nexus plugin -> gateway)

### Plugin subscription and replay
1) nexus plugin connects to hub2d native WS endpoint.
2) During WS handshake, plugin MUST send `resume_token`:
- `resume_token = last_event_id` it successfully processed (per room subscription).
- In practice this is the last seen `event_id` (= Redis stream ID).

3) hub2d replies with subscription confirmation and replays missing events:
- hub2d finds events with `event_id > resume_token` (per room) and pushes them in order.

### Routing to OpenClaw session
4) plugin transforms inbound event to OpenClaw inbound message.
5) plugin MUST set explicit `sessionKey` (routing guarantee):
- `sessionKey = nexus:<room_id>:<from>` (example).
6) gateway resolves session strictly by `sessionKey` and runs the agent.

---

## 03.5 Reply Flow (gateway -> plugin -> hub2d)

### Step-by-step
1) Agent produces streaming output blocks.
2) nexus plugin aggregates blocks (buffer/merge strategy) into fewer outbound chunks to reduce fragility.
3) plugin sends reply over the same native WS channel:
- payload includes `event_id`, `reply_id` (optional), `text`, `blocks`, `status`.

4) hub2d persists reply idempotently
- Unique constraint on `event_id` ensures retries/reconnect do not create duplicate replies.
- hub2d then fan-outs the reply to:
  - UI (Socket.IO)
  - any other subscribers (if needed)

---

## 03.6 Failure Modes And Recovery

### hub2d restart
- Redis consumer group progress is recovered from:
  - Redis PEL (pending messages) + `XCLAIM`
  - persisted last processed `stream_id` (for sanity / bootstrap)
- hub2d resumes consumption and continues pushing.

### WS disconnect (hub2d <-> plugin)
- plugin reconnects with exponential backoff + jitter.
- plugin re-sends `resume_token` to request replay.
- hub2d replays events after `resume_token` (WS-layer replay).

### gateway restart (node)
- Messages are NOT lost:
  - Inbound events remain in hub2d/Redis.
  - plugin reconnects / re-subscribes and replays by `resume_token`.
- Plugin-side dedupe prevents double-delivery into the gateway session.

### Duplicate deliveries / retries
- Expect duplicates at transport level.
- Exactly-once effect is achieved by `event_id` dual dedupe (hub2d unique + plugin in-memory recent-set).

---

## 03.7 Appendix: Why Not "Pure Redis Plugin" (Scheme B)

Scheme B (Redis Streams -> OpenClaw plugin directly) is viable but requires rebuilding reliability surfaces typically centralized in a hub:
- `XPENDING`/`XCLAIM` ownership recovery
- retries + exponential backoff policies
- DLQ (dead queue) + admin UI
- metrics/monitoring for pending/active/done/dead

Prior art: `mugli/orkid-node` demonstrates the full feature set a robust Redis Streams queue tends to accumulate (retry/backoff/DLQ/admin UI). In Scheme A+, hub2d is the place to host these concerns.
