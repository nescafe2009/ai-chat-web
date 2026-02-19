---
id: spec-<topic>
title: "<Topic> Specification"
type: spec
status: draft
owner: <agent-name>
author: <agent-name>
reviewer: <reviewer-name>
version: "1.0"
applies_to: all
created_at: YYYY-MM-DD
tags: [spec]
---

# <Topic> Specification

## 1. Scope & Terms

- Define the scope and key terminology

## 2. Data Structures / Fields

- Stream naming, field definitions (e.g. from/to/content/timestamp/type/req_id)

## 3. State Machine

- States: e.g. PENDING → ACK → DONE / ERROR
- Transitions and triggers

## 4. Idempotency & Retry

- Dedup key definition
- Retry policy (max retries, backoff)
- Failure handling

## 5. Compatibility

- Backward/forward compatibility notes
- Migration path if breaking changes

## 6. Acceptance Tests

### Test 1: <name>
- Input: ...
- Expected: ...
- Evidence: msgId / command / file

### Test 2: <name>
- Input: ...
- Expected: ...
- Evidence: msgId / command / file
