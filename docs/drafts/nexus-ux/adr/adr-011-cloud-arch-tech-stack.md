---
id: nexus-ux-adr-011
title: ADR-011 云端工程架构与技术选型（方案A+）
category: adr
created_at: 2026-02-22
author: Serina + Cortana
status: draft
---

# ADR-011 云端工程架构与技术选型（方案A+）

> 讨论时间：2026-02-22 11:30–12:20 (GMT+8)
> 决策人：赵博（老板）
> 记录人：Serina

---

## 背景

在老板拍板"采用 OpenClaw channel 机制（push）"后，团队对 Redis stream 接入方式（方案A/B）和云端工程形态进行了充分讨论，最终形成本 ADR。

## 决策点

### 1. 消息源：保留 Redis Streams

**结论**：保留 Redis Streams 作为消息持久化层（durable log）。

**理由**：
- WebSocket（WS）是传输层（如何推），Redis Streams 是持久化层（消息从哪来、不丢）
- Redis Streams 提供 consumer group + XPENDING/XCLAIM，天然支持 offset 重放
- WS 断线时消息在 Redis 中等待，重连后可从 lastId 补推，不丢失
- 去掉 Redis 等于要在 hub2d + DB 里重建所有 stream 语义，复杂度更高

**类比**：钉钉 Stream 模式（WS）= 传输层；钉钉服务器 = 持久化层（我们的 Redis）

---

### 2. 接入架构：方案A+（hub2d 内嵌云端工程，直连 Redis）

**结论**：Redis Streams 与 hub2d 在同一腾讯云 VPC 内，hub2d 直接 XREAD，消灭桥接进程。

**最终架构链路**：
```
Redis Streams（腾讯云）
  ↓ XREAD/XGROUP（直连，无桥接进程）
hub2d（内嵌云端工程）
  ├── WebSocket server（面向各节点 nexus plugin）
  ├── socket.io server（面向 UI 浏览器）
  ├── consumer group offset 持久化（PostgreSQL）
  └── event_id 幂等落盘（PostgreSQL unique constraint）
  ↓ WebSocket push
各节点 nexus plugin（WS client）
  ↓ wake
OpenClaw gateway → Agent 处理
  ↓ ws.send(reply + event_id)
hub2d 幂等落盘 → UI 可见
```

**对比废弃方案**：
- 方案A（SSE + 桥接进程）：Redis→桥接进程→hub2d→SSE plugin，桥接进程需额外 pm2 守护
- 方案B（独立 redis plugin）：绕过 hub2d，需在 plugin 层重实现 XACK/XPENDING/监控，成本高
- 方案A+：Redis 和 hub2d 同 VPC，直连无桥接，最简洁

**Prior Art**：
- `hearit-io/redis-channels`：Redis Streams consumer group → Hub → SSE，与 A+ 架构一致
- `mugli/orkid-node`：方案B路线的完整实现，需要自建 retry/DLQ/admin UI
- `soimy/openclaw-channel-dingtalk`：OpenClaw channel plugin 官方参考，WS 长连接 + 平台层持久化

---

### 3. 传输层：WebSocket（双通道分离）

**结论**：plugin 通道用原生 `ws`，UI 通道用 `socket.io`。

**plugin 通道（原生 ws）**：
- 协议轻薄可控，便于实现 resume_token/event_id 幂等
- 与 OpenClaw plugin 升级解耦，少一层抽象
- WS 握手必须携带 `resume_token`（= Redis stream lastId）

**UI 通道（socket.io）**：
- 内置 rooms/订阅/在线状态/心跳，UI 开发体验好
- 不影响可靠性语义（仍以 event_id/offset 为准）

---

### 4. 幂等协议（端到端）

**结论**：`event_id = Redis stream message ID`，贯穿全链。

| 层级 | 机制 |
|------|------|
| Redis stream | message ID 全局唯一 |
| hub2d | PostgreSQL unique constraint on event_id |
| nexus plugin | 内存 Set dedupe，防重复 wake |
| WS 协议 | 每条消息携带 event_id；reply 也携带 event_id |

**WS 握手协议**：
```json
{
  "type": "connect",
  "node": "serina",
  "resume_token": "1771700000000-0"
}
```
hub2d 收到后从 resume_token 对应的 stream offset 开始重放未确认消息。

---

### 5. 技术栈选型

| 组件 | 选型 | 理由 |
|------|------|------|
| 运行时 | Node.js + TypeScript | 团队熟悉，hub2d 延续，生态成熟 |
| plugin WS | 原生 `ws` 库 | 协议可控，轻量 |
| UI WS | `socket.io` | rooms/订阅/重连内置 |
| 持久化 | PostgreSQL | 云端可水平扩展，支持多实例 |
| UI 框架 | React + Vite | 迭代快，v1 不需要 SSR |
| 部署 | pm2 | 进程守护，单实例起步 |

---

### 6. 云端工程形态

**结论**：所有服务端代码封装进一个工程，部署腾讯云服务器。

工程目录结构（草案）：
```
nexus-hub/
├── src/
│   ├── redis/          # Redis stream consumer（XREAD/XGROUP）
│   ├── ws/             # WebSocket server（plugin 通道）
│   ├── socketio/       # socket.io server（UI 通道）
│   ├── db/             # PostgreSQL（事件落盘/幂等）
│   └── ui/             # React UI（React + Vite）
├── pm2.config.js
└── package.json
```

**部署约束**：
- 新建 Redis 实例（腾讯云），不复用现有 ai-chat-web Redis
- pm2 守护，自动重启
- hub2d 重启后从 lastId 继续 XREAD，不丢消息

---

## 参考决策链

- ADR-002：默认订阅 self+boss（摄取策略）
- ADR-008：OpenClaw channel 机制为 v1 主线（已拍板）
- ADR-010：sessionKey=nexus:<room_id>:<from>，SS1=0% 硬保证

---

## 状态

- **draft**（等待 03-flows 完成后与 05-tech-slice 联合 review）
