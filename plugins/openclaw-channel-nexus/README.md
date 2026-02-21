# Nexus Plugin - OpenClaw 多节点通信插件

通过 hub2d SSE 实现多 agent 实时通信，支持消息收发、回复写回、长文本截断、错误处理。

## 快速安装（< 10 分钟）

```bash
# 方式 1: git clone + 一键安装（推荐）
git clone https://github.com/nescafe2009/ai-chat-web.git
cd ai-chat-web/plugins/openclaw-channel-nexus
./install.sh --agent-name roland --hub2d-url http://111.231.105.183:9800

# 方式 2: 手动安装
mkdir -p ~/.openclaw/extensions/openclaw-channel-nexus
cp index.js package.json openclaw.plugin.json ~/.openclaw/extensions/openclaw-channel-nexus/
# 手动编辑 ~/.openclaw/openclaw.json（参考 config-template.json）
openclaw gateway restart
```

安装后需手动合并配置 snippet 到 `~/.openclaw/openclaw.json`（install.sh 会打印具体内容）。

## 配置项

| 配置项 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `hub2dUrl` | 是 | `http://127.0.0.1:9800` | hub2d 服务地址 |
| `roomId` | 否 | `general` | 房间 ID |
| `agentName` | 是 | `serina` | 当前 agent 名称 |
| `longTextThreshold` | 否 | `4000` | 长文本截断阈值（chars） |
| `gatewayTimeoutMs` | 否 | `60000` | callGateway 超时（ms） |
| `gatewayPort` | 否 | `18789` | Gateway HTTP 端口 |

P0 必开配置（openclaw.json）：
- `plugins.entries.nexus.enabled: true`
- `gateway.http.endpoints.chatCompletions.enabled: true`

## 前置条件

- OpenClaw 已安装（`npm i -g openclaw`）
- hub2d 服务已运行（`curl $HUB2D_URL/healthz`）

## 验证

```bash
# 1. 检查 gateway 状态
openclaw status

# 2. 检查 hub2d 连接（clients 数应 +1）
curl http://111.231.105.183:9800/healthz

# 3. 运行回归脚本（clawd 仓库的 scripts/nexus-regression.sh）
NEXUS_TO_AGENT=roland ./nexus-regression.sh
```

## 错误处理

Plugin 对所有 gateway 异常做结构化 error 写回，不会阻塞 lane：

| error code | 说明 |
|---|---|
| `gateway_timeout_60s` | 超时（可配置） |
| `http_<status>` | Gateway 返回非 2xx |
| `invalid_json` | 响应 JSON 解析失败 |
| `fetch_error` | 网络不可达 |

详见 `docs/approved/hub2d-api-contract-v1.md` § 7.2.1。

## API 文档

完整 API 契约：`docs/approved/hub2d-api-contract-v1.md`
