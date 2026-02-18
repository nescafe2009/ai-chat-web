---
id: stellaris-docs-strategy-v1-en
title: "Stellaris Documentation Strategy v1"
category: strategy
type: spec
status: approved
author: Cortana
created_at: 2026-02-18
tags: [documentation, strategy, stellaris, SSOT]
---

# Stellaris Documentation Strategy v1

Status: Approved (2026-02-18)
Owner: Cortana
Last updated: 2026-02-18 (Asia/Shanghai)

## 1. Goals

- Establish a stable, low-friction documentation system that improves execution speed and reduces repeated debugging.
- Make documents easy for both humans and AI models to understand, recall, and search.
- Ensure everyone can access the same source of truth and it has disaster recovery.
- Ensure boss can review progress conveniently inside Hub (archives view).

## 2. Non-Goals

- Replacing the Hub product itself.
- Building a complex knowledge system on day 1.

## 3. Document Types (What We Write)

### 3.1 Journal (Daily Log)

Purpose: Daily factual record + decisions + evidence.

Required fixed sections (Journal v1):

- Goals
- Progress
- Decisions
- Evidence
- Issues
- Next

Rules:

- Evidence must include at least one of: Redis msgId, file path, log keyword, or a reproducible command.
- Prefer one-line bullets. Avoid long narratives.

### 3.2 Spec (Protocol / Interface)

Purpose: Remove ambiguity across multi-agent / multi-system interactions.

Required content:

- Scope and terms
- Data structures / fields (e.g. stream naming, reqId/replyTo/status)
- State machine (ACK/DONE/ERROR)
- Idempotency and retry rules
- Compatibility notes
- Acceptance tests (1-3 concrete cases)

### 3.3 Runbook (Operations / Troubleshooting)

Purpose: Make oncall and debugging repeatable.

Required content:

- Goal and topology
- Dependencies
- Start/stop/restart
- Health checks (must include copy-pastable commands)
- Common failures and how to diagnose
- Rollback plan

## 4. Storage (Where We Put It)

### 4.1 Single Source Of Truth (SSOT)

- Use one shared repository as SSOT (recommended name: `stellaris-docs`).
- Reason: Cortana/Serina/Roland workspaces are independent; if docs live inside each workspace repo, syncing is hard and error-prone.

### 4.2 Directory Layout (in SSOT repo)

- `docs/specs/` specs
- `docs/runbooks/` runbooks
- `docs/daily/` daily summaries for boss
- `journals/YYYY-MM-DD/<agent>.md` raw daily journals

## 5. Hub Visibility (Boss-Friendly)

### 5.1 Daily Summary

- Every day generate one boss-facing summary doc: `docs/daily/YYYY-MM-DD.md`.
- Content: Decisions + Next + Risks/Blockers (no noisy logs).
- Serina archives it into Hub archive system.

### 5.2 Key Doc Change Notifications

- For important docs (spec/runbook) updates, send a short Hub notification message containing:
  - Title
  - 1-3 bullet summary
  - What changed (high-level)
  - Link/path (repo path)

This avoids waiting for the daily summary.

## 6. Knowledge Quality & Approval (Preventing Pollution)

Boss requirement:

- Raw daily journals are allowed without approval.
- Any non-journal "knowledge archive" (spec/runbook/daily summary/decision record) must be approved by boss before it becomes high-trust knowledge.

Proposed policy (v1):

- Tier 0 (Unreviewed)
  - `journals/**` raw daily logs (append-only; may contain wrong hypotheses)
  - Search priority: low

- Tier 1 (Proposed)
  - Draft specs/runbooks/summaries pending boss review
  - Mark clearly as `Status: Draft` and/or in frontmatter `status: draft`
  - Search priority: medium (still below approved)

- Tier 2 (Approved / Canonical)
  - Boss-approved specs/runbooks/decision records
  - Must be reproducible: include acceptance tests, commands, evidence pointers
  - Search priority: highest

Approval workflow (lightweight):

- Author opens a "Doc Approval" request to boss (in Hub or chat), including:
  - doc path
  - 3-bullet summary
  - what changed
- Boss replies with: `APPROVED` or requested edits.
- After approval, set doc status to `Approved` and move (or label) into canonical paths.

## 7. Search (How We Find Things Later)

Three layers (light to heavy):

1) Naming + tags
- Use consistent filenames and frontmatter: `status: draft|approved`, `type: spec|runbook|daily|journal`, `tags: [...]`.

2) Full-text search
- `grep`/`rg` inside the SSOT repo.

3) Semantic search (with priority)
- Index everything, but bias retrieval:
  - Prefer `status: approved` over `draft` over raw journals.
  - Use journals mainly as evidence/forensics, not as canonical guidance.
- Use OpenClaw `memory_search` (or a dedicated vector index) to index `docs/` + `journals/`.
- Use-case: "I remember a decision but not where it is".

## 8. Execution Rules (To Prevent Low-Value Paperwork)

- If a debugging session exceeds 30 minutes, it must produce at least one of:
  - a runbook update, or
  - a postmortem note in that day's journal.

- Any change to a cross-agent protocol must be recorded in `docs/specs/` and must include acceptance tests.

## 9. Responsibilities

- Cortana
  - Owns the strategy, templates, and ensuring the doc system stays consistent.
  - Produces the initial templates.

- Serina
  - Archives boss-facing documents into Hub archive.
  - Maintains Hub notifications for key doc changes.

- Roland
  - Contributes to specs/runbooks/journals as assigned; focuses on clarity and usability.

## 10. Immediate Next Steps (MVP)

1) Create shared repo `stellaris-docs` and grant access to Cortana/Serina/Roland.
2) Add templates:
   - `docs/templates/journal-template.md`
   - `docs/templates/spec-template.md`
   - `docs/templates/runbook-template.md`
3) Start daily workflow:
   - each agent writes their journal
   - Cortana synthesizes `docs/daily/YYYY-MM-DD.md`
   - Serina archives daily summary into Hub

## 11. Open Questions (Need Boss Confirmation)

- SSOT repo naming: `stellaris-docs` ok?
- Where should the canonical archive live: Hub archives only, or Hub + repo link?
- Notification threshold: what counts as "key doc change"?
