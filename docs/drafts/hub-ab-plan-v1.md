---
id: hub-ab-plan-v1
title: "Hub A/B Integration Plan (Redis-native Reply-to-Origin)"
status: draft
owner: Cortana
reviewers: [boss, serina]
created_at: 2026-02-19
updated_at: 2026-02-19
tags: [hub, redis, openclaw, daemon, session, architecture]
---

# Hub A/B Integration Plan (Redis-native Reply-to-Origin)

## Preflight

Goal:

- Make Hub conversations reliably receive agent replies inside Hub UI (reply-to-origin via Redis Streams), while minimizing "session split" issues.
- Keep egress locked to Redis for Hub-originated requests.

Non-goals:

- Full "Hub as an OpenClaw channel" (that is a C-scope project).
- Changing public exposure / auth / network topology of the Hub host.

Risk level: medium

- Touches daemon behavior + reply routing; can regress reliability if rollout is sloppy.

Exception triggered: none

- No secrets/auth changes, no public exposure changes, no cron changes in this doc.

## Terms

- Hub: `chat-web.js` web server + UI.
- Transport: Redis Streams (`<name>:messages`).
- Reply-to-origin: agent writes the official response into the correct stream so Hub UI can show it.
- Main session: OpenClaw interactive session with full context (SOUL/USER/memory).
- Daemon session: a separate constrained OpenClaw session invoked by a daemon.

## Baseline Facts (Verified)

- Hub reads 4 streams via `XREVRANGE` and merges:
  - `serina:messages`, `cortana:messages`, `roland:messages`, `boss:messages`
- Hub dedup key is: `from + timestamp + content`.
- Hub writes fan-out by `XADD` into each target stream (`<target>:messages`) and sets `to` as a comma-joined recipient list.

## Problem Statement

Today we can see these failure modes:

- Wake-only: inbound arrives; daemon wakes OpenClaw (200 OK) but no `XADD` business reply happens -> Hub shows nothing.
- Session split: daemon session has limited context -> wrong / conservative replies, or empty replies.
- Egress mismatch: main session replies via DingTalk/webchat; Hub expects Redis writeback.

The core goal is to make "Hub inbound -> one deterministic handler -> Redis writeback".

## Option A (Current Minimal): Daemon Generates + Writes Reply

### Summary

Daemon is the authoritative responder for Hub inbound messages.

- Inbound: daemon reads `<me>:messages`.
- Respond: daemon constructs prompt (must include essential context) and calls OpenClaw generation.
- Egress: daemon `XADD` response back into `<me>:messages` with `to=<origin>`.
- Optional: daemon sends an immediate ACK message so Hub UI shows quick feedback.

### Message Flow

1) Hub UI or boss writes to Redis:

- `XADD cortana:messages * from=boss to=cortana content=... timestamp=...`

2) Daemon polls via `XREAD` (or `XREADGROUP` if we later adopt consumer groups).

3) Daemon fast ACK (optional but recommended):

- `XADD cortana:messages * from=cortana to=boss content=[ACK] ... timestamp=... type=ack`

4) Daemon calls OpenClaw to generate a reply.

5) Daemon writes business reply:

- `XADD cortana:messages * from=cortana to=boss content=<final> timestamp=... type=text req_id=<msgId>`

### Context Strategy (Critical)

To reduce hallucinations / incorrect replies caused by limited daemon session context:

- Include the triggering message plus last N messages from `<me>:messages` as plain text context.
- Inject routing constraints explicitly:
  - `EGRESS_LOCK=redis`
  - `REPLY_STREAM=<me>:messages`
  - `REPLY_TO=<origin>`
  - `REQ_ID=<msgId>`
- If the daemon cannot safely answer, it should write a "needs manual handling" message into Redis, not only wake.

### Pros

- Fastest, minimal change to current pipeline.
- Deterministic reply-to-origin (daemon owns egress).
- Works even when main session is offline.

### Cons

- Still suffers session split; daemon session may not have full memory/rules.
- Requires careful prompt design + tests; otherwise silent failures recur.

### Acceptance Tests

- HUB-ONLY-TEST (Cortana): Send `@cortana HUB-ONLY-TEST-1`.
  - Expect ACK within <= 2 poll intervals.
  - Expect business reply visible in Hub UI.
- Failure test: disable OpenClaw/gateway temporarily.
  - Expect daemon writes a visible error/status message into Redis.

### Rollout

- Stage 1: keep ACK + writeback; add extensive structured logs.
- Stage 2: add "context window" from Redis history.

### Rollback

- Disable daemon auto-reply; keep only polling + wake.

## Option B (Half Channelization): Daemon Routes to Main Session; Main Session Replies

### Summary

Daemon becomes a reliable "inbound router"; main session is the authoritative responder.

- Inbound: daemon reads `<me>:messages`.
- Route: daemon wakes main session with a structured envelope containing:
  - stream, msgId, from/to/content, and a short recent-context window.
- Respond: main session reads Redis (optionally again), generates the reply with full memory/context.
- Egress: main session writes reply to Redis (reply-to-origin). Daemon does not generate the reply.

### Message Flow

1) Hub writes inbound to Redis stream.

2) Daemon reads inbound and wakes main session with wakeText:

- `EGRESS_LOCK=redis`
- `REPLY_STREAM=<me>:messages`
- `REPLY_TO=<origin>`
- `REQ_ID=<msgId>`
- `ORIG_CONTENT=<...>`
- `CONTEXT_SNIPPET=<...>` (last N messages or last K chars)

3) Main session handler:

- Validates envelope.
- Optionally fetches last N messages from Redis for stronger context.
- Generates final reply.
- Writes reply into `<me>:messages` with `to=<origin>` and `req_id=<msgId>`.

### Pros

- Best answer quality and consistency: main session has full memory/rules.
- Eliminates daemon session hallucinations.
- Keeps reply-to-origin strict (Redis-only egress) if we implement guardrails in main handler.

### Cons

- Requires a "main-session inbound handler" that is robust and idempotent.
- If main session is down, replies pause (unless we implement a fallback).
- More moving parts (daemon + main session must coordinate on req_id and dedup).

### Required Engineering (Concrete)

- Define a single envelope format in wakeText for Hub-origin messages.
- Implement a main-session Redis responder:
  - parse envelope
  - dedup by `REQ_ID` (state file)
  - fetch context window from Redis
  - generate reply
  - `XADD` reply back to stream
- Enforce egress lock in main session for these requests:
  - if `EGRESS_LOCK=redis`, never send to DingTalk/webchat

### Acceptance Tests

- Same as Option A, plus:
  - Restart daemon while main session stays up; ensure messages still route.
  - Restart main session; ensure daemon can wake it and messages resume.

### Rollout

- Phase 1: keep existing daemon auto-reply but add main-session handler in "shadow mode" (no writeback).
- Phase 2: switch daemon to route-only, main session writes replies.

### Rollback

- Switch back to Option A: daemon auto-reply + writeback.

## A vs B Recommendation

- Short-term stability: A is simplest and keeps working when main session is not active.
- Long-term correctness/quality: B is better because it centralizes context and rules.

Recommended path:

1) Stabilize A to ensure Hub always sees replies (already close).
2) Build B as the next step to solve session split.

## Discussion Points for Serina

- On Serina host, can we reliably keep main session always-on? If not, A remains necessary.
- Do we prefer:
  - "daemon always replies" (A)
  - "main always replies" (B)
  - hybrid: B primary, A fallback when main is unavailable
- How many messages (N) should context window include? (trade-off: quality vs token cost)

## Open Questions

- Should we adopt `XREADGROUP` for exactly-once processing semantics?
- Should we standardize message fields: add `req_id`, `in_reply_to`, `type`?
- How do we prevent Hub dedup collisions (same from/timestamp/content)?
  - potential fix: ensure reply `timestamp` differs, or include req_id in content, or change Hub dedup key (requires Hub change).
