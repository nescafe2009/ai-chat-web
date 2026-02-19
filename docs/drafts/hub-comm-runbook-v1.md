---
id: hub-comm-runbook-v1
title: "Hub Communication Principle & Troubleshooting Runbook"
category: runbook
type: runbook
status: deprecated
owner: Serina
author: Serina
reviewer: Cortana
version: "1.0"
applies_to: all
created_at: 2026-02-18
last_updated: 2026-02-19
tags: [runbook, hub, redis, daemon, option-b]
---

# Hub Communication Principle & Troubleshooting Runbook

Status: Deprecated — moved to docs/approved/hub-comm-runbook-v1.md
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

Assumptions (deployer must verify in their environment):

- Redis runs on Tencent Cloud host `42.192.211.138:6379`, accessed via SSH tunnel (not directly exposed to public).
- Hub Web UI runs on the same host, port 8888 (`http://42.192.211.138:8888`).

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

### 3.1 Serina Daemon (redis-daemon-serina.js) — Option B (Pure Wake)

Verified implementation (from repo source + live verification 2026-02-19):

- Connect to Redis through SSH tunnel:
  - local: `127.0.0.1:16379`
  - remote: `42.192.211.138:6379` via `ssh -L 16379:127.0.0.1:6379 root@42.192.211.138`
  - tunnel pid file: `/tmp/redis-tunnel-serina.pid`
  - tunnel health check interval: `10000ms`
- Poll inbox:
  - stream: `serina:messages`
  - interval: `pollIntervalMs=2000`
  - resume from state file: `~/.openclaw/workspace/memory/redis-chat-state-serina.json`
- Allow wake only from: `boss`, `cortana`, `roland`
  - Self-messages (`from=serina`) are silently skipped (line 214: `if (from === CONFIG.myName) return`)
- Wake main OpenClaw session (Option B — no LLM, no independent session):
  - `POST http://127.0.0.1:4152/hooks/wake`
  - Envelope injected as system event:
    - `EGRESS_LOCK=redis`
    - `REPLY_STREAM=<from>:messages`
    - `REPLY_TO=<from>`
    - `REQ_ID=<msgId>`
    - `ORIG_FROM=<from>`
    - `ORIG_CONTENT=<content>`
  - Main session generates reply and writes back via `redis-chat.js send`
- Process manager: pm2
  - name: `redis-daemon-serina`
  - max_restarts: 20, restart_delay: 5000ms
  - pm2 save confirmed

VERIFIED (2026-02-19 17:57):

- pm2 status: online (PID 74541, uptime 113m+)
- HUB-ONLY-TEST-001: daemon picked up test msg (req_id=1771495033644-0), wake API 200, main session processed and wrote reply to boss:messages (id=1771495052967-0)
- Full loop confirmed: XADD → daemon → wake → main session → XADD writeback

Evidence:

- `redis-daemon-serina.js` constants/config (`CONFIG.*`)
- pm2 logs: `[2026/2/19 17:57:15] Wake main: from=boss req_id=1771495033644-0 content=HUB-ONLY-TEST-001`
- pm2 logs: `[2026/2/19 17:57:15] Wake API 响应: 200 body={"ok":true,"mode":"now"}`

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

Serina machine:

```sh
pm2 list
pm2 logs redis-daemon-serina --lines 200 --nostream
```

Decision:

- If daemon not running -> start/restart daemon.
- If logs show no polling / tunnel errors -> go to tunnel checks.

### 4.3 Step 2: Check SSH tunnel health

Cortana machine (verified implementation uses local port 16379):

```sh
lsof -iTCP:16379 -sTCP:LISTEN || true
```

Serina machine (same local port 16379, tunnel managed by daemon):

```sh
# Check tunnel pid
cat /tmp/redis-tunnel-serina.pid
# Check port is open
lsof -iTCP:16379 -sTCP:LISTEN || true
# Or test connectivity directly
node -e "const s=require('net').connect(16379,'127.0.0.1');s.on('connect',()=>{console.log('OK');s.end()});s.on('error',e=>console.log('FAIL',e.message))"
```

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

Observe:

```sh
# On Cortana machine — verify inbound + ACK + reply
node redis-chat.js history 10
# Or via Redis directly
redis-cli -p 16379 -a $REDIS_PASS XREVRANGE cortana:messages + - COUNT 5
```

### 5.2 COMM test (Serina)

- In Hub UI or via Redis, request: `COMM-TEST-7002`
Expected:

- serina replies with `COMM-TEST-7002-OK` in `serina:messages` with `to=cortana`

Observe:

```sh
# On Serina machine — verify reply exists
node redis-chat.js history 10
# Or check specific stream
node -e "const{createClient}=require('redis');(async()=>{const c=createClient({socket:{host:'127.0.0.1',port:16379},password:process.env.REDIS_PASS});await c.connect();const r=await c.xRevRange('serina:messages','+','-',{COUNT:5});console.log(JSON.stringify(r,null,2));await c.quit()})()"
```

Evidence:

- In Redis message history: msgIds `1771425704543-0` (request) and `1771425713918-0` (OK)

### 5.3 Hub-only test (Serina — Option B)

- Via Redis XADD to `serina:messages`: `from=boss content=HUB-ONLY-TEST-001`
Expected:

- daemon picks up message and wakes main session (wake API 200)
- main session generates reply and XADD to `boss:messages`

VERIFIED (2026-02-19 17:57):

- Test msg id: `1771495033644-0`
- Daemon log: `Wake main: from=boss req_id=1771495033644-0 content=HUB-ONLY-TEST-001`
- Wake response: `200 body={"ok":true,"mode":"now"}`
- Reply written to boss:messages: `1771495052967-0`

## 6. Incident Notes (2026-02-18)

Known facts from Redis conversation and deployment logs:

- **Root cause:** Under Option A, daemon generated replies via independent OpenClaw session (`serina-daemon-session`), causing session split — main session had no awareness of hub messages, and daemon session lacked full context.
- **Symptom:** Wake hook returned 200, but replies were generated in the wrong session or not written back to the correct stream.
- **Resolution:** Option B deployed (commit `4210e8e`, 2026-02-19 ~15:55 CST):
  - Daemon stripped of LLM/session logic, now pure wake
  - Main session receives envelope via `/hooks/wake` and handles reply + XADD writeback
  - Acceptance tests A1-A3, B4, C6 passed (see Section 10)
- **Verification (2026-02-19 17:57):** HUB-ONLY-TEST-001 confirmed full loop (see Section 3.1 VERIFIED block)

## 7. Rollback Plan

### 7.1 Revert daemon from Option B (pure-wake) to Option A (LLM generation)

```bash
# 1. Restore old daemon script from git
cd ~/.openclaw/workspace/projects/redis-chat-web
git log --oneline redis-daemon-serina.js  # find pre-Option-B commit
git checkout <pre-4210e8e-commit> -- redis-daemon-serina.js

# 2. Restart daemon
pm2 restart redis-daemon-serina

# 3. Verify: daemon should log "Slowpath: 生成回复" instead of "Wake main:"
pm2 logs redis-daemon-serina --lines 20 --nostream
```

### 7.2 Disable hub-main-handler

hub-main-handler.js is only invoked explicitly (not auto-loaded). To disable:
- Simply stop calling it. No process to kill.
- Optionally back up and remove state file: `mv memory/hub-handler-state.json memory/hub-handler-state.json.bak`

### 7.3 Post-rollback smoke test

```bash
# Send a test message via Redis
node redis-chat.js sendto boss "ROLLBACK-SMOKE-TEST"

# Verify in Redis: should see reply in boss:messages (from daemon LLM session)
node redis-chat.js history 5
```

## 8. Security Notes

- Redis must NOT be exposed to public internet. Access only via SSH tunnel (`ssh -L 16379:127.0.0.1:6379`).
- Tokens, passwords, and verification codes must NOT be written into documents or logs. Pass only at runtime via environment variables or credential files (`~/.openclaw/credentials/`).
- SSH tunnel pid files are stored in `/tmp/` — ensure proper cleanup on reboot.
- Hub Web UI (`chat-web.js`) listens on port 8888. If exposed to public, ensure firewall rules or reverse proxy with auth.

## 9. Improvements

- Monitoring: alert if `<agent>:heartbeat` expires.
- Standardize process manager (launchctl vs pm2) per agent.
- Ensure reply-to-origin is deterministic: daemon must `XADD` business reply into stream, not only wake.
- File transfer between agents should use Tencent Cloud relay (boss directive), not in-stream fragments.

## 10. Option B Deployment Evidence (2026-02-19)

Commit: `4210e8e` (nescafe2009/ai-chat-web main)

Changes:
- `redis-daemon-serina.js`: pure wake mode (no LLM, no independent session)
- `hub-main-handler.js`: idempotent write-back helper (adapted from Cortana's bundle)
- `redis-chat.js`: added `streamOverride` parameter

### Acceptance Tests (Cortana sanity-checked ✅)

**A1. HUB-only happy path**
- req_id=acceptance-hub-001
- final=1771488156222-0
- nonce=SERINA-20260219-001

**A2. Idempotency replay**
- req_id=acceptance-hub-001
- final(first)=1771488156222-0
- replay(second)=SKIPPED (no duplicate final)

**A3. Failure visible**
- req_id=acceptance-fail-001
- error=1771488166187-0

**B4. Semantic correctness**
- XREVRANGE boss:messages verified: from=serina, to=boss, type=text/error, timestamp present
- Conforms to inbox semantics (reply-to-origin writes to recipient stream)

**C6. pm2 self-healing**
- kill -9 PID 74348 → auto-restart PID 74541 after 5s
- max_restarts=20, restart_delay=5000ms
- pm2 save confirmed
