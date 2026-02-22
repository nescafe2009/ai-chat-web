---
id: nexus-ux-design-spec-v1
title: "星辰枢纽 Nexus UX 设计规范 v1（专项）"
category: spec
created_at: 2026-02-22
author: serina
status: draft
tags: [ux, nexus, channel, session-split, token]
---

# 星辰枢纽 Nexus UX 设计规范 v1（专项）

> 在通用 UX 规范（ux-design-spec-v1.md）基础上，针对 Nexus 通道特性的专项设计规范
> 核心目标：channel 化 + 消除 session split + 减少 token 注入量

---

## 1. 背景与问题定义

### 1.1 现网架构问题（根因）

| 问题 | 现象 | 根因 |
|------|------|------|
| Session Split | 同一对话在不同 session 处理，上下文断裂，回复质量下降 | daemon session 与 main session 独立 |
| 单收件箱盲区 | Agent 只监听自己的 stream，错过多人讨论 | daemon 硬编码监听 `<self>:messages` |
| Token 超限 | 历史消息全量注入，导致 context 超长或截断 | 无上下文裁剪策略 |
| 枢纽1无感知 | 枢纽1（Web UI）群聊讨论不触发 Agent wake | boss:messages 无 agent 监听 |

### 1.2 设计目标

1. **统一上下文**：同一对话 thread 的上下文由同一 session 处理，消除 split
2. **多源收敛**：UI 聚合多个 stream（self + boss + channel），Agent 按需订阅
3. **Token 预算**：注入上下文有上限和裁剪策略，避免超限
4. **响应感知**：用户能感知 Agent 处理状态（在线/处理中/等待）

---

## 2. 信息架构

### 2.1 整体结构

```
Nexus Hub
├── Channel 列表（左侧）
│   ├── 📥 全局收件箱（聚合所有 stream）
│   ├── 💬 与 Boss 的对话
│   ├── 🤖 Serina ↔ Cortana
│   ├── 🤖 Serina ↔ Roland
│   └── ＃ 频道（自定义，如 #p0-incidents）
├── 消息流（中间）
│   ├── Thread 分组
│   ├── 消息气泡（Discord 风格，无气泡）
│   └── 流式输出光标
└── 上下文面板（右侧，可收折）
    ├── 当前 Thread 引用链
    ├── Token 预算指示条
    └── Agent 状态卡片
```

### 2.2 全局收件箱

聚合规则：
- 来源：`serina:messages` + `boss:messages` + 已订阅的 channel streams
- 排序：按 timestamp 降序
- 过滤：只显示 `to` 包含 self 或 `to=all` 的消息
- 分组：按日期分组，同人同 thread 合并显示

---

## 3. 消息摄取层（UX 对应）

### 3.1 消息来源标签

每条消息显示来源 stream，帮助用户理解消息路由：

```
[Serina]  serina:messages  · 09:15
收到你的问题，正在处理...

[Boss]    boss:messages    · 09:14
@serina 报告状态
```

来源标签样式：
- 小型 badge，`text-xs`，`--color-text-secondary`
- 点击可跳转到该 stream 的完整视图

### 3.2 订阅配置 UI

在设置页面暴露订阅规则：

```
┌─────────────────────────────────────────┐
│ 消息订阅设置                              │
│─────────────────────────────────────────│
│ ✅ 监听 serina:messages（自己的收件箱）    │
│ ✅ 监听 boss:messages（老板发的消息）      │
│ ☐  监听 cortana:messages（Cortana 消息） │
│ ☐  监听 roland:messages（Roland 消息）   │
│─────────────────────────────────────────│
│ boss:messages 过滤规则                    │
│ ● 仅处理 @我 的消息                      │
│ ○ 接收全部消息                           │
│ ○ 自定义（高级）                         │
└─────────────────────────────────────────┘
```

---

## 4. Thread（话题）模型

### 4.1 Thread 定义

一个 Thread = 围绕同一个 `req_id` 或同一话题的连续对话序列。

```
Thread: P0 修复讨论
├── Boss: @serina 完成 cortana 的任务      [09:00]
├── Serina: 收到 ✅ 正在处理...            [09:01]
├── Serina: P0 已修复，commit 5a69b40     [09:05]
└── Cortana: 收到，已验证 PASS            [09:10]
```

### 4.2 Thread UI

```
┌─── P0 修复讨论 ──────────────────────────┐
│  Boss  09:00                             │
│  @serina 完成 cortana 的任务              │
│                                          │
│  Serina  09:01                           │
│  收到 ✅ 正在处理...                      │
│                                          │
│  [展开更多 3 条]                          │
└──────────────────────────────────────────┘
```

- Thread 默认折叠超过 **5 条**的历史
- 点击展开，展开后可一键「引用此 Thread」到新消息

---

## 5. 上下文注入规范（降 Token）

### 5.1 上下文预算

| 场景 | 注入策略 | Token 估算 |
|------|---------|-----------|
| 普通问答 | 最近 5 条消息 | ~500 tokens |
| 任务执行 | 当前 Thread 全量 + 最近 5 条 | ~1500 tokens |
| 跨 Thread 引用 | 被引用片段（200字截断）| ~300 tokens |
| 紧急触发（P0）| 当前 Thread 全量 | ~2000 tokens |

### 5.2 Token 预算指示条（UI）

右侧面板显示：

```
上下文预算
████████░░░░░░░  54%
已用: ~2160 tokens / 预算: 4000 tokens

本次注入内容：
  ✓ 当前 Thread (8条，~1800 tokens)
  ✓ 系统规则 (~360 tokens)
  ✗ 历史消息（已超预算，跳过）

[调整预算]  [查看详情]
```

### 5.3 长消息处理

- 超过 **500 字**的消息，消息流中显示截断预览 + "展开全文"
- 注入上下文时超过 **400 字**的单条消息自动截断，添加 `[已截断，原文 NNN 字]` 标注
- 用户可手动选择是否注入完整消息

---

## 6. Agent 响应状态 UI

### 6.1 状态流转

```
消息发送
   ↓
Agent Wake 成功 → [处理中...] 动画
   ↓
LLM 生成开始 → [▋ 正在回复] 打字机效果
   ↓
生成完成 → 完整消息 + 时间戳
```

### 6.2 状态展示

**处理中状态**（Wake 后、LLM 开始前）：
```
Serina 正在处理...
[●●●] 动态省略号
```

**流式输出状态**（LLM 生成中）：
```
Serina
这是一段正在生成的回复▋
```

**超时/失败状态**：
```
Serina                      ⚠️ 响应超时
[重试]  [查看详情]
```

### 6.3 超时阈值

| 阶段 | 超时阈值 | 处理方式 |
|------|---------|---------|
| Wake 响应 | 5s | 显示警告，可重试 |
| LLM 首 token | 15s | 显示超时，可重试 |
| LLM 完成 | 120s | 显示部分结果 + 警告 |

---

## 7. 多设备适配（Nexus 专项）

### 7.1 手机端简化

手机端 Channel 列表使用扁平化：

```
全部消息    // 聚合收件箱
与 Boss    // 一对一对话
节点群组    // 多 agent 讨论
```

不显示 stream 来源标签（空间不足），改为颜色区分：
- Boss 消息：左侧蓝色条
- Agent 消息：左侧紫色条

### 7.2 桌面端增强

- 右侧面板展示 Token 预算 + Thread 引用链
- 支持键盘快捷键：`Ctrl+K` 快速切换 Channel，`Ctrl+/` 搜索消息

---

## 8. 验收指标

| 指标 | 目标值 |
|------|--------|
| 消息到达 → 用户可见 | < 2s（P50）/ < 5s（P95）|
| Agent Wake → 状态更新 | < 3s |
| 首屏加载 | < 2s（4G）|
| Token 注入量 | 平均 < 2000 tokens/请求 |
| Session Split 发生率 | 0%（同 Thread 由同 session 处理）|
| 手机端可用性 | 全功能可用，无横向滚动 |

---

## 9. 不做（Non-goals）v1

- 不做实时协作编辑
- 不做语音/视频通话
- 不做端对端加密（内部系统）
- 不做原生 App（Web 优先）
- 不做离线模式（需要 Redis 连接）

---

## 10. 与通用规范的关系

本文档是 `ux-design-spec-v1.md`（通用规范）的**专项补充**。
通用规范定义颜色/字体/间距/组件，本文档定义 Nexus 特有的：
- Channel/Stream 概念的 UI 呈现
- Token 预算可视化
- Thread 模型与折叠策略
- Agent 响应状态机

两份文档配合阅读，通用规范 > 专项规范（专项可覆盖通用）。
