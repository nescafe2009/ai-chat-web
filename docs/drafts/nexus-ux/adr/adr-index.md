---
id: nexus-ux-adr-index
title: Nexus UX 设计决策记录（ADR 汇总）
category: adr
created_at: 2026-02-22
author: Serina + Cortana
---

# Nexus UX ADR 汇总

> 本目录记录 Serina × Cortana 10 轮设计讨论的决策结论，供追溯和防止重复争论。
> 讨论时间：2026-02-22 09:43–09:57 (GMT+8)

---

## ADR-001 会话边界：Thread（非 Channel/Task）

- **结论**：Thread 为上下文边界；Channel 是收件箱（聚合视图），Task 粒度过细且用户不感知
- **反例**：Channel 边界 → token 膨胀；Task 边界 → 追问时上下文断裂
- **状态**：已确认

---

## ADR-002 默认订阅模型：self + boss（to/self 过滤）

- **结论**：默认订阅 `serina:messages` + `boss:messages`；boss 侧做 to/self 白名单过滤
- **过滤规则**：to 包含 self 或 to=all → 处理；to 缺失且来自 boss → 跳过（保守）
- **兜底**：每小时补扫 + 未回复 banner
- **状态**：已确认

---

## ADR-003 上下文裁剪策略：v1 固定窗口，v2 Card 模式

- **结论**：v1 注入 Thread 首条 + 最近 K=5 条，硬限 2000 tokens；v2（Thread>10条）升级为结构化 Card 模式
- **跳过**：摘要+窗口 B 方案（额外 LLM 调用，复杂度高）
- **点状引用**：in_reply_to 取被引用消息全文（>400字截断），叠加正常窗口注入
- **超预算处理**：80% 黄色警告 → 100% 红色 + 自动降窗（K=5→3→首条截断）
- **状态**：已确认

---

## ADR-004 Thread 生命周期：超时归档 + 回复自动恢复

- **结论**：60 分钟无交互 → 自动归档（灰色）；用户回复归档 Thread → 自动恢复（不新开）
- **7天以上**：提示"建议新开话题"，但不强制
- **UI 状态**：🟢进行中 / 🟡等待回复 / ⚪已归档 / ✅已完成
- **联动**：归档 Thread 有未回复消息 → banner 仍提醒
- **状态**：已确认

---

## ADR-005 Agent 状态机：5状态 + 分层超时 + 混合重试

- **状态定义**：Idle / Running / Streaming / Done / Failed（内部细分 NETWORK/MODEL/TIMEOUT）
- **超时分层**：Wake→200OK 5s / 首token 60s（15s/30s渐进提示）/ Streaming总计 120s
- **重试策略**：网络失败自动3次指数退避；超时自动1次；模型拒答/4xx 不重试
- **关键防范**：幂等检查（按 req_id）/ 占位符按时序排列（防乱序）/ 重试不激进裁剪上下文
- **状态**：已确认

---

## ADR-006 收件箱信息架构：三栏布局 + 按重要性分组 + 默认仅@我

- **布局**：导航56px + Channel列表280px + 聊天区flex；移动端退化单栏
- **Channel分组**：全部消息（置顶）/ 进行中 / 等待我回复 / 其他 / 已归档（折叠）
- **Thread卡片必须字段**：状态点 + 标题（30字）+ 最后消息（50字）+ 时间 + 来源标签
- **订阅默认**：仅@我；配置粒度 Channel级（v1）→ 人级（v1）→ 关键词级（v2）
- **透明度**："触发wake" vs "可查看历史"分开；每Channel有过滤说明 + 7日统计（v2）
- **状态**：已确认

---

## ADR-007 验收指标：11个指标 + 2个红线

- **体验指标**：A1 延迟P50<5s / A2 漏回复<2% / A3 未读积压日均<3 / A4 重复回复 0%
- **质量指标**：B1 一致性≥90% / B2 冷线程恢复≥85% / B3 无关回复<5%
- **成本指标**：C1 注入token<2000 / C2 无关wake比例 / C4 补扫触发率<1%
- **Session Split 核心指标**：SS1 = Thread内session_count>1的比例，目标 **0%**
- **采集方式**：daemon state file + Redis 消息字段（session_key/token_count）+ UI埋点（v2）
- **红线**：5分钟无状态更新 / 重复回复率>0%
- **状态**：已确认

---

## ADR-008 v1 技术切片（MoSCoW）

- **Must**：Thread边界识别、摄取层B默认订阅、上下文固定窗口K=5、幂等检查、session_key写入、5状态机、占位符时序
- **Should**：补扫（每小时）、冷线程归档提示、未回复banner、token_count写入、过滤tooltip、混合重试
- **Could**（v2+）：Card结构化记忆、关键词订阅、7日统计、token预算条、跨Thread语义搜索
- **Won't**：自动摘要B方案、语义切分D方案、全量peer订阅、正则wake、多LLM投票
- **纯UI可实现**：三栏布局、状态机展示、打字机效果、Thread卡片、未回复banner、设置页UI
- **必须改daemon**：多stream订阅、to过滤、Thread state、幂等、session_key/token_count写入、补扫、重试
- **状态**：已确认

---

## ADR-009 文档组织：多篇拆分 + approved/drafts 分界

- **结构**：`docs/drafts/nexus-ux/` 下多篇；完成后按优先级移入 `docs/approved/`
- **文件**：00-index / 01-goals / 02-ia / 03-flows / 04-metrics / 05-tech-slice / adr/
- **进 approved**：01-goals、04-metrics、05-tech-slice（老板签字）
- **保持 drafts**：02-ia、03-flows、adr/（持续迭代）
- **引用已有文档**：nexus-ux-design-spec-v1.md（178d4cb）、ux-design-spec-v1.md（178d4cb）、ux-research（80ff66a）只引用章节号，不重复写 spec
- **状态**：已确认

---

## ADR-010 WON'T 清单（按风险/成本/收益排序）

1. 自动滚动摘要+再摘要链路（额外LLM调用，延迟/成本/质量均不可控）
2. 全语义话题切分（误判率高，引入隐性session split）
3. 默认全量订阅 peer:messages（噪声>>信号，过滤复杂度指数级）
4. 复杂关键词/正则触发wake（维护成本高，边界case多）
5. 多LLM评审/投票式合成回复（成本3x+，延迟3x+，场景不明确）
6. 自动话题标签/ML分类（数据量不够，准确率低）

- **状态**：已确认

---

---

## ADR-011 云端工程架构与技术选型（方案A+）

- **结论**：Redis Streams（腾讯云）→ hub2d（内嵌，直连 XREAD）→ WebSocket（plugin 原生ws / UI socket.io）→ nexus plugin → OpenClaw → Agent → ws.send(reply+event_id) → hub2d 幂等落盘
- **技术栈**：Node.js + TypeScript / 原生ws / socket.io / PostgreSQL / React + Vite / pm2
- **幂等键**：event_id = Redis stream message ID，贯穿全链；PostgreSQL unique constraint + plugin 内存 Set dedupe
- **WS 握手**：必须携带 resume_token（= stream lastId），hub2d 从此 offset 重放
- **工程形态**：所有服务端代码封装进单一工程，部署腾讯云服务器
- **参考案例**：hearit-io/redis-channels（A+验证）/ mugli/orkid-node（B成本对照）/ soimy/openclaw-channel-dingtalk（OpenClaw channel plugin 官方参考）
- **详细文档**：`adr/adr-011-cloud-arch-tech-stack.md`（commit ef4eaf5）
- **状态**：draft（等 03-flows 完成后联合 review）

---

## 分工备忘

| 产出 | 负责人 |
|------|--------|
| 02-ia.md、03-flows.md | Cortana 主写，Serina review |
| 05-tech-slice.md（daemon改动） | Serina 主写，Cortana review |
| adr/ 整理（本文件） | Serina |
| adr-011 云端架构选型 | Serina 已出草稿（ef4eaf5） |
| 01-goals.md、04-metrics.md | 双方对齐后推给老板 |
| daemon 6项改造实施 | Serina |
| UI 三栏+设置页 | Cortana 主导 |
| 云端新工程（nexus-hub）实施 | 待 03-flows 通过后启动 |
