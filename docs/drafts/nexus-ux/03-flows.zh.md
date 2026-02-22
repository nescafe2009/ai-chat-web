---
id: nexus-ux-03-flows-zh
title: 03 核心流程（方案 A+）
category: nexus-ux
created_at: 2026-02-22
author: Cortana + Serina
status: draft
---

# 03 核心流程（Flows，方案 A+）

状态：DRAFT
最后更新：2026-02-22

本章描述云端 Nexus 枢纽（hub2d）+ OpenClaw Nexus channel plugin 的端到端运行流程。

当前基线为 **方案 A+**：
- **Redis Streams（腾讯云）**：durable log / 真正的消息源（source of truth）。
- **hub2d（云端，同 VPC）**：通过 **consumer group** 消费 stream，并提供 **WebSocket 传输** + 持久化 + replay + 管理/UI。
- **nexus plugin（各节点）**：以 **原生 WebSocket client** 连接 hub2d（协议薄、可控）。
- **UI（云端）**：通过 **Socket.IO** 连接 hub2d（rooms/订阅/在线状态等 UX 便利；可靠性语义仍以 `event_id` + offset 为准）。

另见：[ADR-011](adr/adr-011-cloud-arch-tech-stack.md) 技术选型理由。

---

## 03.1 参与方与通道

参与方：
- **Producer**：产生消息的节点/用户（人或机器人）。
- **Redis Streams**：durable log，提供 stream ID（offset）。
- **hub2d**：云端枢纽，负责消费、持久化、分发、去重、重放。
- **Nexus plugin**：OpenClaw channel plugin，WS client，将消息路由到 gateway session，并把回复写回 hub2d。
- **OpenClaw gateway**：按 sessionKey 路由到 session/agent，产出流式回复。
- **UI**：Web 控制台，订阅房间，展示队列/状态/重试。

传输通道：
- **Plugin 通道（可靠性关键）**：hub2d <-> nexus plugin（原生 WS）。
- **UI 通道（交互体验）**：hub2d <-> UI（Socket.IO）。

---

## 03.2 事件模型（ID、顺序、幂等）

### `event_id`（硬约束）
- `event_id` 必须端到端稳定，唯一标识一条"入站消息事件"。
- 推荐：`event_id = <redis_stream_message_id>`（例如 `1771731487783-0`）。

### 顺序
- 顺序保证以 **房间/Topic（或 stream key）粒度**为主，依赖 Redis stream ID 的天然有序性。
- hub2d 给同一订阅者推送同一房间的事件时必须保持顺序。

### 幂等（双层去重）
- **服务端（hub2d）**：入站事件与回复落盘时，对 `event_id` 做 **唯一约束**（必要时扩展为 `event_id + reply_type`）。
- **客户端（plugin）**：维护 `event_id` 的短期内存集合（recent-set），用于去重 WS 重传/重连 replay。

目标：传输层允许"至少一次（at-least-once）"，业务效果做到"准一次（exactly-once effect）"。

---

## 03.3 摄取流程（Redis -> hub2d）

### 流程
1) Producer 写入 Redis Stream
- `XADD stream:<room> * { ...payload... }`
- Redis 返回 `stream_id`。

2) hub2d 通过 consumer group 消费
- hub2d 使用 `XGROUP CREATE`（可按房间分 stream，也可单 stream + room 字段）。
- 使用 `XREADGROUP GROUP <group> <consumer> COUNT N BLOCK T STREAMS <stream> >` 读取新消息。

3) hub2d 落盘并物化
- 入站事件落盘：
  - `event_id = stream_id`
  - `room_id`, `from`, `text`, `attachments`, `ts` 等。
- 消费进度落盘：
  - 持久化 last processed `stream_id`（按 stream key / group / consumer），用于重启恢复与自检。

4) hub2d ACK（仅在持久化成功后）
- 必须在 hub2d 持久化完成后才执行 `XACK <stream> <group> <stream_id>`。

### 说明
- 如果 hub2d 在 ACK 前崩溃，消息会留在 PEL（pending），可通过 `XPENDING` + `XCLAIM` 夺回处理。
- 这是 Redis 层的 replay，独立于 WS 层的 replay。

---

## 03.4 分发流程（hub2d -> nexus plugin -> gateway）

### plugin 订阅与重放
1) nexus plugin 连接 hub2d 的原生 WS endpoint。
2) WS handshake 后，plugin 必须发送 `resume_token`：
- `resume_token = last_event_id`（按房间维度）
- 实际上就是最后处理成功的 `event_id`（= Redis stream ID）。

3) hub2d 确认订阅并补推缺失事件
- hub2d 查找 `event_id > resume_token`（按房间），按序补推。

### 路由到 OpenClaw session
4) plugin 将入站事件转换为 OpenClaw inbound message。
5) plugin 必须显式设置 `sessionKey`（路由硬保证）：
- `sessionKey = nexus:<room_id>:<from>`（示例）。
6) gateway 按 `sessionKey` 严格路由到 session 并运行 agent。

---

## 03.5 回复流程（gateway -> plugin -> hub2d）

### 流程
1) Agent 产出流式输出块。
2) nexus plugin 做 block buffer/merge（减少碎片化流式带来的不稳定与成本）。
3) plugin 通过同一条原生 WS 通道发送回复：
- payload 包含 `event_id`, `reply_id`（可选）, `text`, `blocks`, `status`。

4) hub2d 幂等落盘回复
- `event_id` 唯一约束确保重试/重连不会造成重复回复。
- hub2d 再把回复 fan-out 到：
  - UI（Socket.IO）
  - 其他订阅者（如需要）

---

## 03.6 故障场景与恢复

### hub2d 重启
- Redis consumer group 进度通过以下信息恢复：
  - Redis PEL（pending）+ `XCLAIM`
  - 持久化的 last processed `stream_id`（用于 bootstrap/自检）
- hub2d 恢复消费并继续推送。

### WS 断线（hub2d <-> plugin）
- plugin 采用指数退避 + jitter 重连。
- 重连后携带 `resume_token` 请求补推。
- hub2d 按 `resume_token` 之后的事件进行 WS 层 replay。

### gateway 重启（节点侧）
- 消息不丢：
  - 入站事件仍在 hub2d/Redis。
  - plugin 重连/重新订阅后按 `resume_token` 补推。
- plugin 的内存去重避免重复注入 gateway session。

### 重复投递/重试
- 允许传输层重复。
- 依靠 `event_id` 双层去重（hub2d unique + plugin recent-set）实现"效果幂等"。

---

## 03.7 附录：为何不选"纯 Redis plugin"（方案 B）

方案 B（Redis Streams -> OpenClaw plugin 直连）可行，但需要在插件侧重建大量"枢纽能力"：
- `XPENDING`/`XCLAIM` 所有权恢复
- retry + 指数退避策略
- DLQ（dead queue）+ 管理 UI
- pending/active/done/dead 的监控指标

参考实现：`mugli/orkid-node` 展示了一个可靠的 Redis Streams 队列最终会累积的完整能力（retry/backoff/DLQ/admin UI）。在方案 A+ 中，这些能力集中在 hub2d 更合理。
