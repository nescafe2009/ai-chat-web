---
id: stellaris-20260216-002
title: 星辰执行规章（一期）
category: 章程
created_at: 2026-02-16
author: cortana
visibility: internal
tags: [规章, 流程, 协作]
---

# 星辰 (Stellaris) - 执行规章（一期）

日期: 2026-02-16

适用范围: 本规章用于提高协作效率与降低重复错误, 先行试运行, 后续可按 PR/Review 流程迭代。

## 1. 组织正式文件（档案）定稿流程

对象:
- `docs/` 下的组织资料、会议纪要、决策文件、章程/规章等。

流程:
- Serina 提交变更（PR 或等价变更集）。
- Cortana Review（按 checklist: 一致性/结构/可执行性/边界风险）。
- 赵博确认后合并/定稿。

定稿要求:
- 文档需包含基本元信息（至少: 标题、日期、作者; 推荐使用 YAML frontmatter: id/title/category/created_at/author/visibility/tags）。
- 所有改动必须可追溯（git commit/PR 记录）。

## 2. 平台代码快速迭代流程

对象:
- 枢纽平台的功能开发、Bug 修复、UI 调整、性能优化等代码变更。

流程:
- Serina 负责 review 后可直接提交/合并, 不要求赵博逐次确认。

例外（必须额外处理）:
- 若变更涉及以下任一项, 必须在合并前补充"风险评估 + 回滚方案"并通知 赵博:
  - 权限/认证/ACL
  - 对外网络暴露（公网端口、反向代理、token/secret 处理）
  - 数据不可逆变更（删除、迁移、格式变更）
  - 安全边界变化（trusted proxies, CORS, webhooks 等）

## 3. 档案馆文档写入规范（建议项, 可逐步启用）

- 文件位置: `docs/` 及其子目录。
- 文件命名: `<date>-<slug>.md`（示例: `2026-02-16-stellaris-org-record.md`）。
- 分类枚举建议: 会议纪要 / 决策 / 章程。
- 可见性建议: `visibility: internal` 为默认值。
