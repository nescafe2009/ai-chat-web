---
id: ADR-012
title: Identity Model - user_id/username + room_id/room_name Separation
category: architecture
status: approved
created_at: 2026-02-23
author: serina + cortana
approved_by: 赵博
---

# ADR-012: Identity Model — user_id/username + room_id/room_name 分离

## 状态

**Approved** — 2026-02-23，老板批准

## 背景

v0 协议中 `from` 字段混用了 display name（"serina"/"user"），导致：
1. session split 风险：agentName 字符串变化 → sessionKey 变化 → 新 session
2. 无法区分"同名不同人"场景
3. DB 主键语义不稳定，无法做跨 room 用户关联

## 决策

### user_id / username 分离

| 字段 | 类型 | 说明 |
|------|------|------|
| user_id | bigint (自增) | 全局唯一，不可变，DB 主键 |
| username | text | 可改的 display name |

- AI agent 预分配固定 user_id（seeds/migrations 写死）：
  - serina = 1
  - cortana = 2
  - roland = 3
- 人类用户：首次访问 hub2d 时由服务端生成 user_id，下发给客户端存 localStorage
- OpenClaw sessionKey：`nexus:{room_id}:{user_id}`（数字，稳定不变）

### room_id / room_name 分离

| 字段 | 类型 | 说明 |
|------|------|------|
| room_id | bigint (自增) | 全局唯一，不可变，DB 主键 |
| room_name | text | display name，可改 |

- 初始映射（seeds）：general=1, boss=2
- Redis stream key：`stream:{room_id}`（迁移期双写兼容）
- UI 侧栏显示 room_name，subscribe/send 全用 room_id

### 协议字段规范（v1）

新增字段（向后兼容，v0 字段保留）：

**event.new / room.send：**
```
actor_id:   bigint   // 发送者 user_id（新增）
room_id:    bigint   // 数字 room_id（新增，v0 用字符串 room_id）
from:       string   // display name（保留，v0 兼容）
username:   string   // 同 from，语义更清晰（新增）
```

**reply.update：**
```
actor_id:   bigint   // 回复者 user_id（新增）
from:       string   // display name（保留）
```

- `from`/`to` 保留字符串语义（display），deprecated in v2
- 新字段：`actor_id`（发送者）、`recipient_id`（回复目标），类型 bigint

### DB Schema 变动

```sql
-- 新增 users 表
CREATE TABLE users (
  user_id    BIGSERIAL PRIMARY KEY,
  username   TEXT NOT NULL,
  user_type  TEXT NOT NULL DEFAULT 'human', -- 'human' | 'agent'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- seeds: AI agents
INSERT INTO users (user_id, username, user_type) VALUES
  (1, 'Serina', 'agent'),
  (2, 'Cortana', 'agent'),
  (3, 'Roland', 'agent')
ON CONFLICT DO NOTHING;

-- 新增 rooms 表
CREATE TABLE rooms (
  room_id    BIGSERIAL PRIMARY KEY,
  room_name  TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- seeds: initial rooms
INSERT INTO rooms (room_id, room_name) VALUES
  (1, 'general'),
  (2, 'boss')
ON CONFLICT DO NOTHING;

-- events 表新增字段
ALTER TABLE events ADD COLUMN actor_id BIGINT REFERENCES users(user_id);
ALTER TABLE events ADD COLUMN room_id_int BIGINT REFERENCES rooms(room_id);

-- replies 表新增字段
ALTER TABLE replies ADD COLUMN actor_id BIGINT REFERENCES users(user_id);
ALTER TABLE replies ADD COLUMN recipient_id BIGINT REFERENCES users(user_id);
```

### 迁移策略

- **v0 → v1 过渡期**：hub2d 做 name→id 自动映射，字符串字段保留
- **Redis stream key**：双写期读 `stream:{room_name}` + 写 `stream:{room_id}`，切换完成后仅用 `stream:{room_id}`
- **sessionKey**：plugin v2 切换到 `nexus:{room_id}:{user_id}`

## 选型理由

- **自增 bigint vs 雪花**：v1 先用自增（简单可读），对外当不透明 ID；有多实例需求时再切雪花
- **actor_id vs user_id**：协议层用 `actor_id` 避免"from 字段是 id 还是 name"的歧义（Cortana 建议）
- **向后兼容**：旧字段只增不删，v0 客户端无感知

## 影响

- hub2d：新增 users/rooms 表 + migration + seed
- plugin：sessionKey 更新
- UI：room.subscribe 传 room_id（数字）+ 首次访问生成/读取 user_id
- 协议：event.new / reply.update 新增 actor_id 字段

## 下一步

1. 写 migration 002（users + rooms 表 + seeds + ALTER TABLE）
2. hub2d 实现 name→id 映射中间件
3. UI 实现首次访问 user_id 生成（服务端接口或本地生成）
4. plugin 更新 sessionKey 规则
