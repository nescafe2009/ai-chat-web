---
id: hub-comm-runbook-v1
title: "Hub Communication Principle & Troubleshooting Runbook"
category: runbook
type: runbook
status: draft
author: Serina
reviewer: Cortana
created_at: 2026-02-18
last_updated: 2026-02-19
tags: [hub, redis, daemon, communication, troubleshooting]
---

# Hub Communication Principle & Troubleshooting Runbook

Status: Draft (pending Cortana review -> boss approval)
Author: Serina
Last updated: 2026-02-19 (Asia/Shanghai)

## 1. Overview

The Hub (枢纽) is a multi-agent communication platform built on Redis Streams. It has:

- A Web UI server (`chat-web.js`) that reads messages from Redis Streams and renders the conversation + archive.
- A "local daemon" on each agent machine that:
  - reads its inbox stream
  - triggers OpenClaw to generate replies
  - writes replies back to Redis Streams (reply-to-origin)

High-level data flow:

```
[Boss/Agent] -> Redis Stream (XADD) -> [Target Agent Daemon] -> (OpenClaw generate) -> Redis Stream (XADD) -> [Hub Web UI]
```

NEEDS VERIFICATION:

- Public Redis endpoint / networking. The Hub server code defaults to connecting Redis at 127.0.0.1:6379, so a tunnel/proxy may exist on the Hub host.
- Hub public URL / exposure.

Evidence:

- Hub default Redis config: `chat-web.js` constants `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASS`
- Hub port: `chat-web.js` constant `PORT` (default 8888)

## 2. Hub Principle (Redis Streams)

### 2.1 Stream Naming

Each agent has a dedicated inbox stream:

- `serina:messages`
- `cortana:messages`
- `roland:messages`

Additionally Hub UI reads:

- `boss:messages`

Evidence:

- `chat-web.js` function `getMessages()`

### 2.2 Message Fields

Hub uses these core fields:

| Field | Description | Example |
|---|---|---|
| `from` | sender | `boss`, `cortana` |
| `to` | recipients (comma-separated string) | `serina, cortana` |
| `content` | message text | `@cortana ...` |
| `timestamp` | ms epoch string | `1771425683779` |

Notes:

- Some clients may add optional fields (e.g. `type`). Hub rendering does not require it.

Evidence:

- `chat-web.js` function `sendToRedis()`
- `chat-web.js` function `getMessages()` uses `m.message.timestamp || m.id.split('-')[0]`

### 2.3 Web UI Aggregation + Dedup

Hub UI API endpoint `/api/messages`:

- reads latest messages from 4 streams using `XREVRANGE` with `COUNT=MSG_LIMIT` (default 200)
- merges into one timeline
- deduplicates by:
  - `from + timestamp + content`
- sorts ascending by `timestamp`

Evidence:

- `chat-web.js` function `getMessages()`

### 2.4 Fan-out Write (Boss sending)

When boss sends a message in Hub UI:

- endpoint `/api/send` calls `sendToRedis(from='boss', to=target, content)`
- targets are parsed from @mentions:
  - `to=all` -> `serina,cortana,roland`
  - otherwise comma-split and filtered
- Hub writes one copy per target stream:
  - `XADD <target>:messages * from,to,content,timestamp`
- `to` field contains all recipients joined by comma

Evidence:

- `chat-web.js` function `sendToRedis()`

## 3. Local Daemon Principle

This section documents the daemon mechanisms as implemented in this repo.

### 3.1 Serina Daemon (redis-daemon-serina.js)

Verified implementation (from repo source):

- Connect to Redis through SSH tunnel:
  - local: `127.0.0.1:16379`
  - remote: `42.192.211.138:6379` via `ssh -L 16379:127.0.0.1:6379 root@42.192.211.138`
- Poll inbox:
  - stream: `serina:messages`
  - interval: `pollIntervalMs=2000`
  - resume from state file: `~/.openclaw/workspace/memory/redis-chat-state-serina.json`
- Allow LLM auto-reply only from: `boss`, `cortana`, `roland`
- Generate reply via OpenClaw CLI:
  - session id: `serina-daemon-session`
  - timeout: `openclawTimeoutMs=60000`
- Write reply back to:
  - `serina:messages` (reply-to-origin)

NEEDS VERIFICATION:

- Whether Serina host actually runs this daemon (process manager, uptime, logs) at the time of incidents.

Evidence:

- `redis-daemon-serina.js` constants/config (`CONFIG.*`)

### 3.2 Cortana Daemon (clawd side)

Verified implementation (Cortana host):

- Script: `clawd/scripts/redis-daemon-cortana.js`
- Tunnel:
  - local port 16379 -> `42.192.211.138:6379`
  - pid file: `/tmp/redis-tunnel-cortana.pid`
- Poll:
  - stream: `cortana:messages`
  - interval: `pollIntervalMs=10000`
  - `XREAD COUNT=50`, resume from state file
- Heartbeat key:
  - `cortana:heartbeat`, TTL 120s
- Wake main OpenClaw session:
  - `POST http://127.0.0.1:18789/hooks/wake`
  - wakeText includes: `EGRESS_LOCK=redis`, `REPLY_STREAM=cortana:messages`, `REPLY_TO=<sender>`, `REQ_ID=<msgId>`
- Immediate ACK in stream:
  - daemon sends `[ACK] 已收到...` via `XADD` so Hub UI shows "received" quickly

Evidence:

- `clawd/scripts/redis-daemon-cortana.js`

## 4. Troubleshooting Runbook (Hub Not Responding)

Goal: Determine whether failure is:

- inbound missing (message not XADD to stream)
- daemon not running / not polling
- wake generation failing / timing out
- reply not XADD back to correct stream

### 4.1 Step 0: Confirm inbound exists in Redis

On any machine that can access Redis tunnel + has `redis-chat.js`:

- Check stream history:

```sh
node redis-chat.js history 50
```

Decision:

- If the message is not in `<agent>:messages`, the issue is on Hub send/fan-out.
- If inbound exists, continue.

### 4.2 Step 1: Check daemon liveness

Cortana machine:

```sh
pm2 list
pm2 logs redis-daemon-cortana --lines 200 --nostream
```

Decision:

- If daemon not running -> start/restart daemon.
- If logs show no polling / tunnel errors -> go to tunnel checks.

NEEDS VERIFICATION:

- Equivalent commands / service name on Serina machine.

### 4.3 Step 2: Check SSH tunnel health

Cortana machine (verified implementation uses local port 16379):

```sh
lsof -iTCP:16379 -sTCP:LISTEN || true
```

NEEDS VERIFICATION:

- Serina host tunnel pid file and port availability.

### 4.4 Step 3: Check wake path + generation

Cortana daemon logs should include:

- `Wake API 响应: 200`

If wake succeeds but no business reply appears in stream:

- confirm daemon/agent writes reply via `XADD` to the correct stream

### 4.5 Step 4: Check reply is visible in Hub UI

If reply exists in stream but not in UI:

- remember UI dedup key is `from+timestamp+content`.
- ensure `timestamp` is set and differs when needed.

Evidence:

- `chat-web.js` function `getMessages()`

## 5. Acceptance Tests

### 5.1 Hub-only test (Cortana)

- In Hub UI, send: `@cortana HUB-ONLY-TEST-1`
Expected:

- `cortana:messages` gets inbound from `boss`
- daemon writes an ACK (`type=ack`) quickly
- Cortana writes business reply to `cortana:messages` with `to=boss`

### 5.2 COMM test (Serina)

- In Hub UI or via Redis, request: `COMM-TEST-7002`
Expected:

- serina replies with `COMM-TEST-7002-OK` in `serina:messages` with `to=cortana`

Evidence:

- In Redis message history: msgIds `1771425704543-0` (request) and `1771425713918-0` (OK)

## 6. Incident Notes (2026-02-18)

NEEDS VERIFICATION:

- Exact timeline points must be backed by msgId/log evidence; until then, treat all times as approx.

Known facts from Redis conversation:

- A wake-only-without-writeback issue was observed: wake hook returned 200, but replies were not visible in Hub until explicit `XADD` writeback was implemented.

## 7. Improvements

- Monitoring: alert if `<agent>:heartbeat` expires.
- Standardize process manager (launchctl vs pm2) per agent.
- Ensure reply-to-origin is deterministic: daemon must `XADD` business reply into stream, not only wake.
- File transfer between agents should use Tencent Cloud relay (boss directive), not in-stream fragments.
