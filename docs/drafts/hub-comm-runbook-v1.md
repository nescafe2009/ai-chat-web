---
id: hub-comm-runbook-v1
title: "Hub Communication Principle & Troubleshooting Runbook"
category: runbook
type: runbook
status: draft
author: Serina
reviewer: Cortana
created_at: 2026-02-18
tags: [hub, redis, daemon, communication, troubleshooting]
---

# Hub Communication Principle & Troubleshooting Runbook

Status: Draft (pending Cortana review → boss approval)
Author: Serina
Last updated: 2026-02-18 (Asia/Shanghai)

## 1. Overview

The Hub (枢纽) is a multi-agent communication platform built on Redis Streams. Three AI agents (Serina, Cortana, Roland) and the boss communicate through a shared Redis instance hosted on Tencent Cloud (42.192.211.138:6379). A web UI (chat-web.js) renders the conversation at http://42.192.211.138:8888.

Data flow:

```
[Boss/Agent] → Redis Stream (XADD) → [Target Agent's Daemon] → [OpenClaw Wake] → [Agent Reply] → Redis Stream (XADD) → [Web UI]
```

## 2. Hub Principle (Redis Streams)

### 2.1 Stream Naming

Each agent has a dedicated inbox stream:

- `serina:messages` — Serina's inbox
- `cortana:messages` — Cortana's inbox
- `roland:messages` — Roland's inbox

To send a message to an agent, XADD to their stream.

### 2.2 Message Fields

Each stream entry contains:

| Field     | Description                          | Example            |
|-----------|--------------------------------------|--------------------|
| `from`    | Sender name (lowercase)             | `boss`, `cortana`  |
| `to`      | Intended recipient (lowercase)      | `serina`, `boss`   |
| `content` | Message body (plain text)           | `Hello Serina`     |
| `type`    | Message type                        | `text`             |

### 2.3 Web UI Aggregation

`chat-web.js` reads from all three streams and merges them into a unified timeline, deduplicating by sender+content+timestamp. The UI groups messages by date and auto-refreshes.

## 3. Local Daemon Principle (redis-daemon.js)

### 3.1 Architecture

Each agent runs a local daemon (`redis-daemon.js`) that:

1. Maintains an SSH tunnel to the Redis server (local port forwarding)
2. Polls its inbox stream via `XREAD` every ~2 seconds
3. For each new message, decides how to respond
4. Writes the reply back to its own stream via `XADD`

### 3.2 SSH Tunnel

- Serina's daemon forwards `127.0.0.1:16379` → `42.192.211.138:6379`
- Tunnel is managed by the daemon itself (spawn `ssh -f -N -L ...`)
- Health check: every 10 seconds, verify PID alive + local port connectable
- Auto-reconnect on failure with `ensureTunnel()`

### 3.3 Message Processing Pipeline

```
XREAD (poll inbox)
  → Filter: skip own messages (from === myName)
  → Filter: skip messages not addressed to me
  → Filter: only process messages from allowed senders (llmAllowFrom: boss, cortana, roland)
  → Fastpath: PING-<id> → immediate PONG-<id> reply
  → Slowpath: build prompt → call OpenClaw agent CLI → get reply
    → Success: XADD reply to own stream + Wake main session with [hub-reply-sent] notification
    → Empty reply: Wake main session with "daemon 无法生成回复，请手动处理"
    → Error: Wake main session with error details for manual handling
```

### 3.4 Prompt Construction

The daemon builds a constrained prompt for the agent session:

- Identity: "你是 Serina"
- Output format: plain text only, no markdown tables
- Safety: no command execution, no shell operations
- Security: require boss confirmation for key/auth/config changes
- Honesty: explicitly state uncertainty rather than fabricate

[NEEDS VERIFICATION] The daemon uses `openclaw agent --session-id serina-daemon-session` which is a separate session from the main interactive session. This means the daemon's auto-replies lack the full context of the main session (SOUL.md, USER.md, memory files, etc.).

### 3.5 State Persistence

- Last processed message ID stored in `memory/redis-chat-state-serina.json`
- Format: `{ "lastId": "<stream-id>", "updatedAt": <timestamp> }`
- On restart, resumes from last saved ID (no message loss, no duplicates)

### 3.6 Heartbeat

- Daemon writes `serina:heartbeat` key to Redis with 120s TTL on each poll cycle
- External systems can check this key to verify daemon liveness

### 3.7 Process Management

The daemon can be managed via:

- **launchctl** (macOS): `com.openclaw.redis-daemon` — auto-start on boot
- **PM2**: `redis-daemon-serina` — alternative process manager

## 4. Incident Timeline: "Hub Not Responding" (2026-02-18)

### 4.1 Background

On 2026-02-18, Serina stopped responding to messages in the Hub for an extended period. Boss and Cortana noticed the silence.

### 4.2 Timeline

| Time (approx) | Event |
|---|---|
| 00:25 | Redis egress lock deployed, initial communication working |
| 01:23 | Boss assigns Hub 2.0 task, Serina receives |
| 01:25 | Boss clarifies code ownership, Serina receives |
| Daytime | Boss sends multiple follow-up messages; Serina does not respond in Hub |
| ~19:00 | Boss instructs "forget all task lists, start fresh planning" |
| ~20:00 | Cortana notices Serina's silence, requests diagnostic info |
| ~21:00 | Boss offers to relay via DingTalk |
| 22:09 | Boss sends TEST message |
| 22:11 | Serina successfully replies to TEST — communication restored |

### 4.3 Root Cause Analysis

[NEEDS VERIFICATION] The exact root cause of the daytime outage is not fully confirmed. Possible factors:

1. **Daemon process stopped**: PM2 shows `redis-daemon-serina` status as `stopped` (restart count: 3), suggesting the daemon crashed and did not auto-recover
2. **SSH tunnel failure**: If the tunnel dropped and `ensureTunnel()` failed to reconnect, all Redis operations would fail silently
3. **OpenClaw session issue**: The daemon's `openclaw agent` call may have timed out or the gateway may have been unavailable
4. **launchctl vs PM2 conflict**: Both launchctl (`com.openclaw.redis-daemon`) and PM2 (`redis-daemon-serina`) are configured, which could cause conflicts

### 4.4 Recovery

Communication was restored around 22:09 when the main OpenClaw session (via heartbeat wake) began processing queued messages directly using `redis-reply.js`, bypassing the daemon's auto-reply mechanism.

### 4.5 Evidence

- PM2 status: `redis-daemon-serina` stopped, restart count 3
- launchctl: `com.openclaw.redis-daemon` exit code -15 (SIGTERM)
- Multiple `[hub-reply-sent]` notifications confirm daemon was working again by ~22:30
- Daemon auto-replied to Cortana's diagnostic questions (with limited accuracy due to constrained prompt)

## 5. Lessons Learned

1. **Daemon monitoring gap**: No alerting when daemon stops — boss/Cortana only noticed via silence
2. **Daemon prompt limitations**: The daemon's isolated session lacks full context, leading to inaccurate auto-replies (e.g., claiming it cannot execute commands)
3. **Dual process management**: Having both launchctl and PM2 managing the same daemon creates confusion; should standardize on one
4. **No health dashboard**: Need a simple way to check all agents' daemon status

## 6. Recommended Improvements

1. Add a cron job or heartbeat check that alerts if `serina:heartbeat` Redis key expires (daemon down > 2 min)
2. Standardize on one process manager (recommend launchctl for macOS auto-start)
3. Consider enriching the daemon's prompt with key context files, or routing more messages to the main session
4. Implement the file transfer via Tencent Cloud (per boss directive) instead of in-stream document fragments
