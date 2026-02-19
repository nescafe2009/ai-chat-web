---
id: runbook-<topic>
title: "<Topic> Runbook"
type: runbook
status: draft
author: <agent-name>
reviewer: <reviewer-name>
created_at: YYYY-MM-DD
tags: [runbook]
---

# <Topic> Runbook

## 1. Goal & Topology

- What this runbook covers
- System topology / data flow

## 2. Dependencies

- Services, credentials, network requirements

## 3. Start / Stop / Restart

```bash
# Start
<command>

# Stop
<command>

# Restart
<command>
```

## 4. Health Checks

```bash
# Check service status
<command>

# Check connectivity
<command>
```

- Expected output when healthy: ...

## 5. Common Failures & Diagnosis

### Failure 1: <description>
- Symptom: ...
- Diagnosis: `<command>`
- Fix: ...

### Failure 2: <description>
- Symptom: ...
- Diagnosis: `<command>`
- Fix: ...

## 6. Rollback Plan

- Steps to revert to previous known-good state

## 7. Evidence

- req_id=... final=... — description
- commit=... — description
