---
id: stellaris-docs-strategy-v1-zh
title: "Stellaris 文档与日志策略 v1"
category: strategy
type: spec
status: draft
author: Cortana
created_at: 2026-02-18
tags: [documentation, strategy, stellaris, SSOT]
---

# Stellaris 文档与日志策略 v1

状态：草案（请老板审核）
负责人：Cortana
最后更新：2026-02-18（Asia/Shanghai）

## 1. 目标

- 建立一个稳定、低摩擦的文档体系，提升执行效率，减少重复排障。
- 文档对人和 AI 都"易理解、易记忆、易检索"。
- 所有人访问同一事实源，并具备容灾能力。
- 老板可在枢纽（档案馆）里方便查看关键进展。

## 2. 非目标

- 不在第一天就替换枢纽产品。
- 不一开始就建设复杂的知识系统。

## 3. 文档类型（写什么）

### 3.1 Journal（日记/原始日志）

目的：记录当天事实 + 决策 + 证据。

固定小节（Journal v1）：

- Goals
- Progress
- Decisions
- Evidence
- Issues
- Next

规则：

- Evidence 至少包含以下任一项：Redis msgId、文件路径、日志关键词、可复现命令。
- 尽量用单行 bullet，避免长篇叙事。

### 3.2 Spec（协议/接口/规范）

目的：消除多 Agent / 多系统协作时的歧义。

必须包含：

- 范围与术语
- 数据结构/字段（例如 stream 命名、reqId/replyTo/status）
- 状态机（ACK/DONE/ERROR）
- 幂等与重试规则
- 兼容性说明
- 验收用例（1-3 个可执行案例）

### 3.3 Runbook（运维/排障手册）

目的：让排障可复用、可复制。

必须包含：

- 目标与拓扑
- 依赖
- 启停/重启
- 健康检查（必须提供可复制命令）
- 常见故障与定位方法
- 回滚方案

## 4. 存放位置（放哪里）

### 4.1 单一事实源（SSOT）

- 使用一个共享仓库作为 SSOT（建议名：`stellaris-docs`）。
- 原因：Cortana/Serina/Roland 的 workspace 独立；如果文档分散在各自 repo 的 docs/memory，会导致同步困难且易错。

### 4.2 目录约定（SSOT 仓库内）

- `docs/specs/`：规范/协议
- `docs/runbooks/`：运维/排障
- `docs/daily/`：给老板看的每日汇总
- `journals/YYYY-MM-DD/<agent>.md`：三位 AI 的原始日记

## 5. 枢纽可见（便于老板查看）

### 5.1 每日汇总

- 每天生成一份老板视角摘要：`docs/daily/YYYY-MM-DD.md`。
- 内容：Decisions + Next + 风险/阻塞（避免噪音日志）。
- 由 Serina 归档进枢纽档案馆。

### 5.2 关键文档变更通知

- 对重要 spec/runbook 的更新，额外在枢纽发一条短通知：
  - 标题
  - 1-3 条摘要
  - 变更点（高层）
  - 路径/链接

避免老板必须等到日报。

## 6. 知识质量与审批（防止污染）

老板要求：

- 每日原始日记允许不审批。
- 除日记外的"知识归档"（spec/runbook/daily/决策记录）必须经老板批准，才视为高可信知识。

建议分层策略（v1）：

- Tier 0（未审阅）
  - `journals/**` 原始日记（可能包含错误假设）
  - 检索优先级：低

- Tier 1（待批准/草案）
  - 待老板审核的 spec/runbook/summary
  - 必须清晰标注 `Status: Draft` 或 frontmatter `status: draft`
  - 检索优先级：中（低于 approved）

- Tier 2（已批准/权威）
  - 老板批准后的 spec/runbook/决策记录
  - 必须可复现：包含验收用例、命令、证据指针
  - 检索优先级：最高

轻量审批流程：

- 作者发起 "Doc Approval" 请求给老板（枢纽或聊天皆可），包含：
  - 文档路径
  - 3 条摘要
  - 变更点
- 老板回复：`APPROVED` 或修改意见。
- 批准后：将文档状态设为 Approved，并移动到 canonical 目录（或加 approved 标签）。

## 7. 搜索（如何未来快速找到）

三层搜索（从轻到重）：

1) 命名 + 标签
- 统一文件命名，并用 frontmatter：`status: draft|approved`，`type: spec|runbook|daily|journal`，`tags: [...]`。

2) 全文检索
- 在 SSOT 仓库中用 `grep`/`rg`。

3) 语义检索（带优先级）
- 全量建索引，但检索时加权：
  - 优先命中 `status: approved`，其次 `draft`，最后才回溯 journals。
  - journals 主要用于取证/复盘，不作为权威指南。
- 可用 OpenClaw `memory_search`（或独立向量索引）索引 `docs/` + `journals/`。

## 8. 执行规则（避免低价值文档）

- 任一问题调试超过 30 分钟，必须产出至少一项：
  - runbook 更新；或
  - 当天 journal 中的 postmortem 记录。

- 任何跨 Agent 的协议变更必须落到 `docs/specs/`，并附 1-3 条验收用例。

## 9. 角色分工

- Cortana
  - 负责策略、模板、文档一致性与落地推进。

- Serina
  - 将老板视角的文档归档到枢纽档案馆。
  - 维护关键文档变更通知。

- Roland
  - 参与 specs/runbooks/journals 编写；强调清晰与可用。

## 10. 立即落地步骤（MVP）

1) 创建共享仓库 `stellaris-docs` 并给三人权限。
2) 加入模板：
   - `docs/templates/journal-template.md`
   - `docs/templates/spec-template.md`
   - `docs/templates/runbook-template.md`
3) 启动日常流程：
   - 每个 agent 写 journal
   - Cortana 汇总生成 `docs/daily/YYYY-MM-DD.md`
   - Serina 归档 daily 到枢纽

## 11. 待老板确认

- SSOT 仓库命名：`stellaris-docs` 是否确认？
- 权威归档的落点：仅枢纽，还是 枢纽 + repo 路径链接？
- "关键文档变更通知"的阈值：哪些算关键？
