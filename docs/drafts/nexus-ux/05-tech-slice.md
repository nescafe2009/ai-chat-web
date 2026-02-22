---
id: nexus-ux-05-tech-slice
title: 05 Tech Slice — v1 Implementation Plan (Scheme A+)
category: nexus-ux
created_at: 2026-02-22
author: Serina + Cortana
status: draft
---

# 05 Tech Slice — v1 Implementation Plan (Scheme A+)

Status: DRAFT
Last updated: 2026-02-22

This document defines the v1 implementation scope, tech stack rationale, and WS protocol constraints for the **nexus-hub** cloud service (Scheme A+).

See also:
- [ADR-011](adr/adr-011-cloud-arch-tech-stack.md) — Architecture & tech stack decision
- [03-flows.md](03-flows.md) — End-to-end runtime flows

---

## 05.1 Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Node.js + TypeScript | Team familiarity; hub2d lineage; rich ecosystem |
| Plugin WS channel | Native `ws` library | Thin protocol, controllable; less abstraction = easier to implement `resume_token` / `event_id` semantics; decoupled from OpenClaw upgrade cycle |
| UI WS channel | `socket.io` | Built-in rooms, namespaces, presence, heartbeat; good DX for browser UI |
| Persistence | **PostgreSQL** | See §05.2 for rationale |
| UI Framework | React + Vite | Fast iteration; no SSR needed for v1 |
| Process manager | pm2 | Process supervision; auto-restart; log management |
| Redis | Tencent Cloud Redis | Same VPC as hub2d → direct XREAD, no bridge process |

---

## 05.2 PostgreSQL Rationale (vs SQLite)

SQLite is the current hub2d baseline. For the new cloud deployment, **PostgreSQL is the recommended choice**:

1. **Multi-instance / horizontal scale**: PostgreSQL supports concurrent connections from multiple processes or replicas. SQLite has per-file write locks that make multi-instance deployments impractical.
2. **Row-level locking**: SQLite's file-level write lock causes `database is locked` errors under high-concurrency writes (events + replies arriving simultaneously). PostgreSQL row-level locks are far better suited to the hub's write pattern.
3. **Connection pooling**: PostgreSQL works with `pg` / `pgbouncer` / application-level pool natively. In WS long-connection scenarios, connection count grows with subscriber count; proper pooling is critical.
4. **Schema migrations**: PostgreSQL tooling (`node-pg-migrate`, `drizzle-orm`, `prisma`) is more mature for production migration/rollback workflows.
5. **Unique constraint enforcement**: Our idempotency model requires strict unique constraint on `event_id` (and `event_id + reply_type` variants). PostgreSQL constraint semantics are more reliable under concurrent writes than SQLite.
6. **HA / replication**: PostgreSQL supports primary-replica replication and managed failover (TencentDB for PostgreSQL). If hub2d needs to scale horizontally, the DB remains a single source of truth across instances.
7. **Cloud-native**: Tencent Cloud provides managed PostgreSQL, enabling automated backups, replicas, and monitoring without additional ops overhead.
8. **Bonus — LISTEN/NOTIFY**: PostgreSQL's native pub/sub (`LISTEN`/`NOTIFY`) can be used for internal fan-out or UI real-time refresh without an extra message bus — not required in v1, but worth noting as an extension path.

> SQLite MAY still be used for local development / testing environment to simplify setup. Production target = PostgreSQL.

---

## 05.3 WS Protocol Constraints (Plugin Channel)

The plugin channel uses **native WebSocket** with a thin JSON protocol defined below.

### 05.3.1 Connection Handshake

After WS connection is established, plugin MUST send a `connect` frame:

```json
{
  "type": "connect",
  "node": "serina",
  "rooms": ["general", "boss"],
  "resume_token": {
    "general": "1771731487783-0",
    "boss": "1771731234567-0"
  }
}
```

Fields:
- `node`: node identifier (matches Redis stream consumer name)
- `rooms`: list of rooms/topics to subscribe
- `resume_token`: map of `room_id` → last successfully processed `event_id` (= Redis stream ID)
  - hub2d will replay events after this offset per room

hub2d responds with:
```json
{
  "type": "connected",
  "node": "serina",
  "replaying": {
    "general": 3,
    "boss": 0
  }
}
```

### 05.3.2 Inbound Event (hub2d → plugin)

```json
{
  "type": "event",
  "event_id": "1771731487783-0",
  "room_id": "general",
  "from": "boss",
  "text": "...",
  "ts": 1771731487783,
  "attachments": []
}
```

- plugin MUST dedupe by `event_id` (in-memory recent-set, size cap ~1000)
- plugin MUST wake OpenClaw gateway with `sessionKey = nexus:<room_id>:<from>`

### 05.3.3 Reply (plugin → hub2d)

```json
{
  "type": "reply",
  "event_id": "1771731487783-0",
  "reply_id": "reply-uuid-optional",
  "room_id": "general",
  "to": "boss",
  "text": "...",
  "blocks": [],
  "status": "done"
}
```

- hub2d persists reply with unique constraint on `(event_id, status='done')` to prevent duplicate final replies
- `status` values: `streaming` | `done` | `error`

### 05.3.4 Heartbeat / Keepalive

```json
{ "type": "ping", "ts": 1771731500000 }
```
hub2d responds: `{ "type": "pong", "ts": 1771731500001 }`

Interval: 30 seconds. hub2d closes connection after 3 missed pings.

### 05.3.9 Reconnect Policy (plugin)

- Initial reconnect delay: 1s
- Exponential backoff: `delay = min(initial * 2^attempt, 60s)`
- Jitter: ±20% random
- Max attempts before alerting: 10
- On reconnect: always send `connect` frame with latest `resume_token`

---

## 05.4 v1 MoSCoW (Implementation Scope)

### Must (v1 launch blockers)

**Cloud service (nexus-hub)**:
- [ ] Redis XREADGROUP consumer with consumer group + XACK
- [ ] PostgreSQL schema: `events`, `replies`, `consumer_offsets` tables with unique constraints
- [ ] Native WS server (plugin channel): connect/handshake, event push, reply ingestion
- [ ] `resume_token` replay on reconnect (per room, per subscriber)
- [ ] Socket.IO server (UI channel): room subscription, event/reply fan-out
- [ ] pm2 config with auto-restart

**nexus plugin (each node)**:
- [ ] Native WS client with reconnect + exponential backoff + jitter
- [ ] `event_id` in-memory dedupe set
- [ ] `sessionKey = nexus:<room_id>:<from>` explicit routing
- [ ] `resume_token` persistence (per room, survives plugin restart)
- [ ] Reply aggregation / block buffer before sending

### Should (v1 quality)
- [ ] Basic UI: message stream view per room, WS connection status
- [ ] hub2d health endpoint (`/healthz`)
- [ ] Metrics: pending event count, WS subscriber count, reply latency P50/P99
- [ ] XPENDING / XCLAIM for stale pending recovery (hub2d restart hardening)

### Could (v2+)
- [ ] UI: full admin panel (pending/active/done/dead queues)
- [ ] DLQ (dead letter queue) for events that fail after N retries
- [ ] Multi-instance hub2d with sticky WS sessions
- [ ] Streaming reply UI (live typing indicator)
- [ ] Per-room ingestion policy (allowlist / dmPolicy / groupPolicy)

### Won't (explicit out-of-scope)
- Fanout to 3rd-party webhooks
- Message encryption at hub2d layer (rely on TLS)
- Cross-cloud federation

---

## 05.5 Database Schema (Draft)

```sql
-- Inbound events
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,   -- Redis stream message ID
  room_id TEXT NOT NULL,
  "from" TEXT NOT NULL,
  text TEXT,
  attachments JSONB DEFAULT '[]',
  ts BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Replies (agent output)
CREATE TABLE replies (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  reply_id TEXT,
  room_id TEXT NOT NULL,
  "to" TEXT NOT NULL,
  text TEXT,
  blocks JSONB DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'done',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (event_id, status)         -- prevent duplicate final reply
);

-- Consumer group progress (for restart recovery)
CREATE TABLE consumer_offsets (
  stream_key TEXT NOT NULL,
  consumer_group TEXT NOT NULL,
  last_event_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (stream_key, consumer_group)
);
```

---

## 05.6 Project Directory Structure

```
nexus-hub/
├── src/
│   ├── redis/
│   │   ├── consumer.ts        # XREADGROUP loop + XACK
│   │   └── recovery.ts        # XPENDING + XCLAIM on startup
│   ├── ws/
│   │   ├── server.ts          # Native WS server (plugin channel)
│   │   ├── protocol.ts        # Message type definitions
│   │   └── replay.ts          # resume_token replay logic
│   ├── socketio/
│   │   └── server.ts          # Socket.IO server (UI channel)
│   ├── db/
│   │   ├── client.ts          # PostgreSQL connection pool
│   │   ├── events.ts          # events table queries
│   │   ├── replies.ts         # replies table queries
│   │   └── offsets.ts         # consumer_offsets queries
│   ├── ui/                    # React + Vite frontend
│   │   ├── src/
│   │   └── vite.config.ts
│   └── index.ts               # Entry point
├── migrations/                # SQL migrations
├── pm2.config.js
├── package.json
└── tsconfig.json
```

---

## 05.7 Canonical Field Naming Table

> Authority reference: all implementation code, protocol frames, and DB schemas MUST use these exact names. No aliases.

| Field | Type | Scope | Description |
|-------|------|-------|-------------|
| `event_id` | `string` | Protocol + DB | Redis stream message ID (e.g. `1771731487783-0`). Primary idempotency key. |
| `room_id` | `string` | Protocol + DB | Logical room / topic identifier (e.g. `general`, `boss`) |
| `from` | `string` | Protocol + DB | Sender node/user identifier (e.g. `boss`, `serina`) |
| `to` | `string` | Protocol | Recipient node/user identifier; used in reply frames |
| `node` | `string` | Protocol | hub2d-facing node identifier; set in `connect` frame |
| `sessionKey` | `string` | OpenClaw internal | Gateway session routing key: `nexus:<room_id>:<from>` |
| `resume_token` | `object` | Protocol | Map of `room_id → event_id`; sent by plugin on connect/reconnect |
| `reply_id` | `string` | Protocol + DB | Optional UUID for the reply; used for deduplication at application layer |
| `reply_status` | `string` | Protocol + DB | Reply lifecycle state: `streaming` \| `done` \| `error` |
| `ts` | `number` | Protocol | Unix timestamp (ms) of the original event |
| `blocks` | `array` | Protocol + DB | Structured output blocks (v1: may be empty `[]`) |
| `attachments` | `array` | Protocol + DB | File/media attachments on inbound events (v1: may be empty `[]`) |
| `consumer_group` | `string` | Redis + DB | XGROUP name used by hub2d (e.g. `hub2d-group`) |
| `stream_key` | `string` | Redis + DB | Redis stream key (e.g. `stream:general`) |

### Naming Rules
1. **Snake_case everywhere** — no camelCase in protocol frames or DB columns
2. `event_id` is the single source of truth for idempotency — never rename to `msg_id`, `message_id`, or `req_id` in this codebase
3. `sessionKey` is the only camelCase exception — it's OpenClaw-internal and matches gateway API convention
4. `from` / `to` are reserved words in SQL — always quote as `"from"` / `"to"` in raw queries
