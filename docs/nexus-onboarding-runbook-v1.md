---
id: nexus-onboarding-runbook-v1
title: Nexus Plugin 10 分钟新机验收清单 (标准化 v1)
category: runbook
created_at: 2026-02-22
author: serina
---

# Nexus Plugin — 10 分钟新机验收清单

## 基线信息

| 项目 | 值 |
|---|---|
| 插件基线 commit | `5a69b40` |
| 插件版本 | v0.3.0 |
| 回归脚本 WAIT 默认 | 60s (commit `10e76be`) |
| 仓库 | `nescafe2009/ai-chat-web` |
| 插件路径 | `plugins/openclaw-channel-nexus/` |

## Plugin ID 约定

- **openclaw.plugin.json → id**: `openclaw-channel-nexus`
- **openclaw.json → plugins.entries key**: `openclaw-channel-nexus`
- **openclaw.json → channels key**: `nexus`（channel 名仍为 nexus）
- **安装目录**: `~/.openclaw/extensions/openclaw-channel-nexus/`

> ⚠️ 旧版使用 `nexus` 作为 plugin id，会导致 id mismatch warning 和 duplicate plugin 告警。务必清理旧目录 `~/.openclaw/extensions/nexus/`。

## 步骤

### 1. 安装插件 (~3 min)

```bash
git clone https://github.com/nescafe2009/ai-chat-web.git
cd ai-chat-web/plugins/openclaw-channel-nexus
./install.sh --agent-name <YOUR_NAME> --hub2d-url http://111.231.105.183:9800
```

或手动：
```bash
mkdir -p ~/.openclaw/extensions/openclaw-channel-nexus
cp index.js package.json openclaw.plugin.json ~/.openclaw/extensions/openclaw-channel-nexus/
```

### 2. 配置 openclaw.json (~2 min)

合并以下 snippet（install.sh 会打印）：

```json
{
  "channels": {
    "nexus": {
      "enabled": true,
      "hub2dUrl": "http://111.231.105.183:9800",
      "roomId": "general",
      "agentName": "YOUR_AGENT_NAME",
      "longTextThreshold": 4000,
      "gatewayTimeoutMs": 60000
    }
  },
  "plugins": {
    "entries": {
      "openclaw-channel-nexus": { "enabled": true }
    }
  },
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true }
      }
    }
  }
}
```

**P0 必开项：**
- `plugins.entries.openclaw-channel-nexus.enabled: true`
- `gateway.http.endpoints.chatCompletions.enabled: true`

### 3. 清理旧版 + 重启 (~1 min)

```bash
# 清理旧 plugin 目录（如果存在）
rm -rf ~/.openclaw/extensions/nexus/

# 重启 gateway
openclaw gateway restart
```

### 4. 验证连接 (~1 min)

```bash
# 确认 gateway 运行
openclaw status

# 检查日志中是否有：
# [nexus] Nexus channel started v0.3.0 (gatewayTimeoutMs=60000)
# [nexus] SSE connected

# 确认 hub2d clients 数增加
curl http://111.231.105.183:9800/healthz
```

### 5. 回归测试 (~3 min)

```bash
cd ai-chat-web
NEXUS_TO_AGENT=<YOUR_NAME> ./nexus-regression.sh
```

默认 WAIT=60s。原因：部分 agent（如 roland）latency 可达 14s，30s 窗口会导致 `/v1/admin/replies` 读到空而误报 FAIL。

可通过环境变量覆盖：`NEXUS_WAIT_SEC=90 ./nexus-regression.sh`

## 验收口径

以 hub2d `/v1/admin/replies?event_id=<eid>` 返回为准。

示例：
```bash
curl "http://111.231.105.183:9800/v1/admin/replies?event_id=1771696470417-a5mjdb"
```

期望返回：
```json
{
  "replies": [{
    "reply_id": "1771696480277-bmtfxg",
    "event_id": "1771696470417-a5mjdb",
    "status": "ok",
    "latency_ms": 9838,
    "truncated": false
  }]
}
```

**PASS 条件：** `status=ok` 且 `reply_id` 非空。

**error 示例（结构化错误）：**
```json
{
  "replies": [{
    "status": "error",
    "error_code": "gateway_timeout_60s",
    "error_detail": "60s timeout exceeded"
  }]
}
```

## "不回应"排查清单

当 agent 收到消息但无回复时，按以下顺序排查：

1. **SSE 连接断开** — 检查日志是否有 `[nexus] SSE connected`
2. **embedded run start 但无 end** — 优先检查 model id / provider 配置是否正确（常见：model 名拼错、API key 过期、provider 不可达）
3. **gateway timeout** — 检查 `/v1/admin/replies` 是否有 `status=error, error_code=gateway_timeout_*`
4. **hub2d 不可达** — `curl $HUB2D_URL/healthz` 确认服务在线
5. **plugin 未加载** — 检查日志是否有 `[nexus] Nexus channel plugin registered`；确认 `plugins.entries` key 为 `openclaw-channel-nexus`

## 版本历史

| commit | 版本 | 变更 |
|---|---|---|
| `5a69b40` | v0.3.0 | 纯 JS + plugin id 对齐 openclaw-channel-nexus + 结构化 error |
| `10e76be` | - | 回归脚本 WAIT 30→60 |
