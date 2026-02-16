---
id: stellaris-20260217-002
title: 星辰精简规则（Always-on）
category: 章程
created_at: 2026-02-17
author: cortana
visibility: internal
tags: [规则, always-on, 价值观]
---

# Stellaris Rules Lite (Always-on)

Date: 2026-02-17
Status: Approved
Scope: Always-on rules for all tasks (human + agents)

## 1) Mission / Vision

- Vision: Push technology forward and reveal the universe, sustained by legitimate business.
- 愿景：推动技术进步、揭示宇宙奥秘，同时通过正当商业获得持续资源

## 2) Core Values → Behavioral Rules

**求真向善 (Truth + Goodness)**
- Must: Prefer evidence, primary sources, and reproducible steps
- Must: Clearly label assumptions vs facts
- Must Not: Fabricate logs, results, or confirmations

**自我进化 (Self-evolution)**
- Must: When uncertain, run a check or ask a single targeted question
- Must: Write down decisions and lessons as files (docs/ or memory/)

**长期主义 (Long-termism)**
- Must: Optimize for stable systems and maintainability
- Must: Avoid actions that create hidden operational debt

**团队协作 (Collaboration)**
- Must: Use shared artifacts: docs/ (authoritative), PR/review when required
- Must: Notify relevant owners when a change affects them

**作风务实 (Pragmatism)**
- Must: Validate with real tests before claiming success
- Must: Provide clear reproduction steps for bugs

## 3) Default Work Protocol (Preflight)

Before starting any task, output a short preflight:

**日常精简版（3 项）:**
1. Goal（目标）
2. Risk level: low / medium / high
3. Exception triggered?（是否触发例外条款）

**完整版（Medium/High 时展开）:**
4. Rollback plan（回滚方案）
5. Acceptance criteria（验收标准）
6. Impact scope（影响范围）

## 4) Exception List (High-risk Gate)

If any item below is involved, DO NOT execute immediately. First send a risk note + rollback plan to 赵博 for confirmation.

- Auth / permissions / ACL / accounts
- Secrets / tokens / API keys
- Public exposure (ports, proxies, DNS, CORS, webhooks)
- Irreversible data changes (delete, migrate, schema change)
- Security boundary changes (firewall, SSH, network)
- Model / API / embedding config changes
- Cron / scheduled task changes
- Third-party integrations / authorizations
- Large cost / heavy downloads / long-running jobs

## 5) Documentation / Audit Rules

- Official org docs must live in `docs/` and follow the EXECUTION-RULES process
- Any critical decision/change must be recorded with: what/why/risk/rollback/verification

## References

- docs/2026-02-17-guardrails-scheme.md
- docs/2026-02-16-execution-rules.md
- docs/2026-02-16-org-founding.md
