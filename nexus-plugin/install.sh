#!/usr/bin/env bash
# install.sh - Nexus Plugin 一键安装脚本
# 用法: ./install.sh [--agent-name <name>] [--hub2d-url <url>]
#
# 前置条件: openclaw 已安装并可运行
# 效果: 复制 plugin 到 ~/.openclaw/extensions/nexus/，提示配置，重启 gateway

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSIONS_DIR="${HOME}/.openclaw/extensions"
PLUGIN_DIR="${EXTENSIONS_DIR}/nexus"
CONFIG_FILE="${HOME}/.openclaw/openclaw.json"

# 默认值
AGENT_NAME=""
HUB2D_URL=""

# 解析参数
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-name) AGENT_NAME="$2"; shift 2 ;;
    --hub2d-url)  HUB2D_URL="$2"; shift 2 ;;
    -h|--help)
      echo "用法: ./install.sh [--agent-name <name>] [--hub2d-url <url>]"
      echo "  --agent-name  agent 名称（如 serina/cortana/roland）"
      echo "  --hub2d-url   hub2d 服务地址（如 http://111.231.105.183:9800）"
      exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

echo "=== Nexus Plugin 安装 ==="
echo ""

# 1. 检测 openclaw
if ! command -v openclaw &>/dev/null; then
  echo "❌ 未检测到 openclaw，请先安装: npm i -g openclaw"
  exit 1
fi
echo "✅ openclaw 已安装: $(openclaw --version 2>/dev/null || echo 'unknown')"

# 2. 创建 extensions 目录
mkdir -p "$PLUGIN_DIR"
echo "✅ 插件目录: $PLUGIN_DIR"

# 3. 复制 plugin 文件
cp "$SCRIPT_DIR/index.ts" "$PLUGIN_DIR/"
cp "$SCRIPT_DIR/package.json" "$PLUGIN_DIR/"
cp "$SCRIPT_DIR/openclaw.plugin.json" "$PLUGIN_DIR/"
echo "✅ 插件文件已复制"

# 4. 检查/更新 openclaw.json 配置
if [ ! -f "$CONFIG_FILE" ]; then
  echo "⚠️  未找到 $CONFIG_FILE，请先运行 openclaw setup"
  echo ""
  echo "安装完成后需要手动配置以下内容到 openclaw.json："
  echo ""
  cat "$SCRIPT_DIR/config-template.json"
  exit 0
fi

# 检查是否已有 nexus 配置
HAS_NEXUS=$(python3 -c "
import json
with open('$CONFIG_FILE') as f:
    d = json.load(f)
ch = d.get('channels', {})
pl = d.get('plugins', {}).get('entries', {})
print('yes' if 'nexus' in ch else 'no')
" 2>/dev/null || echo "no")

if [ "$HAS_NEXUS" = "yes" ]; then
  echo "✅ openclaw.json 已有 nexus 配置"
else
  echo "⚠️  openclaw.json 缺少 nexus 配置"
  echo ""
  echo "请将以下内容合并到 openclaw.json："
  echo ""
  echo '--- 最小必改配置 snippet ---'
  echo ''
  if [ -n "$AGENT_NAME" ]; then
    DISPLAY_AGENT="$AGENT_NAME"
  else
    DISPLAY_AGENT="YOUR_AGENT_NAME"
  fi
  if [ -n "$HUB2D_URL" ]; then
    DISPLAY_URL="$HUB2D_URL"
  else
    DISPLAY_URL="http://YOUR_HUB2D_HOST:9800"
  fi
  cat <<SNIPPET
  "channels": {
    "nexus": {
      "enabled": true,
      "hub2dUrl": "${DISPLAY_URL}",
      "roomId": "general",
      "agentName": "${DISPLAY_AGENT}",
      "longTextThreshold": 4000
    }
  },
  "plugins": { "entries": { "nexus": { "enabled": true } } },
  "gateway": { "http": { "endpoints": { "chatCompletions": { "enabled": true } } } }
SNIPPET
  echo ''
  echo '--- P0: plugins.entries.nexus.enabled + chatCompletions.enabled 必须开启 ---'
  echo ''
  echo "完整模板参考: ${SCRIPT_DIR}/config-template.json"
fi

# 5. 重启 gateway
echo ""
echo "正在重启 openclaw gateway..."
if openclaw gateway restart 2>/dev/null; then
  echo "✅ gateway 已重启"
else
  echo "⚠️  gateway 重启失败，请手动运行: openclaw gateway restart"
fi

echo ""
echo "=== 安装完成 ==="
echo ""
echo "验证步骤："
echo "  1. openclaw status          # 确认 gateway 运行"
echo "  2. 检查日志中是否有 [nexus] SSE connected"
echo "  3. curl \$HUB2D_URL/healthz  # 确认 clients 数增加"
echo "  4. 运行回归脚本: ./nexus-regression.sh"
