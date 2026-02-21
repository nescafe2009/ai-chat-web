#!/usr/bin/env bash
# nexus-regression.sh - Nexus 三节点最小回归脚本
# 用法: ./nexus-regression.sh [hub2dUrl]
# 依赖: curl, jq (可选)
#
# 验收逻辑:
#   1. 向每个 agent 各发 1 条消息
#   2. 等待 30s 让 plugin 处理
#   3. 用 /v1/admin/replies 取证，打印 status/latency/truncated

set -euo pipefail

HUB2D_URL="${1:-http://111.231.105.183:9800}"
FROM_AGENT="${NEXUS_FROM_AGENT:-serina}"
WAIT_SEC="${NEXUS_WAIT_SEC:-30}"

# 支持单节点测试：NEXUS_TO_AGENT=roland ./nexus-regression.sh
if [ -n "${NEXUS_TO_AGENT:-}" ]; then
  AGENTS=("$NEXUS_TO_AGENT")
else
  AGENTS=("serina" "cortana" "roland")
fi
PASS=0
FAIL=0

echo "=== Nexus 三节点回归测试 ==="
echo "hub2dUrl: $HUB2D_URL"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# 1. 健康检查
echo "[1/3] 健康检查..."
HEALTH=$(curl -sf "$HUB2D_URL/healthz" || echo '{"status":"error"}')
STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null || echo "error")
CLIENTS=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('clients','?'))" 2>/dev/null || echo "?")
echo "  /healthz: status=$STATUS clients=$CLIENTS"
if [ "$STATUS" != "ok" ]; then
  echo "  ❌ hub2d 不健康，终止"
  exit 1
fi
echo "  ✅ hub2d 健康"
echo ""

# 2. 向每个 agent 发消息，收集 event_id
declare -A EVENT_IDS
echo "[2/3] 发送验收消息..."
for TO_AGENT in "${AGENTS[@]}"; do
  CONTENT="【回归测试】from=$FROM_AGENT to=$TO_AGENT ts=$(date +%s)"
  RESP=$(curl -sf -X POST "$HUB2D_URL/v1/send" \
    -H "Content-Type: application/json" \
    -d "{\"room_id\":\"general\",\"from\":\"$FROM_AGENT\",\"to\":\"$TO_AGENT\",\"content\":\"$CONTENT\"}" \
    || echo '{"ok":false}')
  EID=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('event_id','FAIL'))" 2>/dev/null || echo "FAIL")
  if [ "$EID" = "FAIL" ] || [ "$EID" = "None" ]; then
    echo "  ❌ $FROM_AGENT→$TO_AGENT: send 失败 resp=$RESP"
    FAIL=$((FAIL+1))
  else
    EVENT_IDS[$TO_AGENT]="$EID"
    echo "  ✅ $FROM_AGENT→$TO_AGENT: event_id=$EID"
  fi
done
echo ""

# 3. 等待 plugin 处理
echo "[3/3] 等待 ${WAIT_SEC}s 让 plugin 处理..."
sleep "$WAIT_SEC"
echo ""

# 4. 拉取回复证据
echo "=== 验收结果 ==="
for TO_AGENT in "${AGENTS[@]}"; do
  EID="${EVENT_IDS[$TO_AGENT]:-}"
  if [ -z "$EID" ]; then
    echo "  SKIP $TO_AGENT (send 失败)"
    continue
  fi

  REPLIES=$(curl -sf "$HUB2D_URL/v1/admin/replies?event_id=$EID" || echo '{"replies":[]}')
  COUNT=$(echo "$REPLIES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('replies',[])))" 2>/dev/null || echo "0")

  if [ "$COUNT" = "0" ]; then
    echo "  ❌ $FROM_AGENT→$TO_AGENT event_id=$EID: 无回复（agent 可能未处理）"
    echo "     原始响应: $REPLIES"
    FAIL=$((FAIL+1))
  else
    RSTATUS=$(echo "$REPLIES" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d['replies'][0]; print(r.get('status','?'))" 2>/dev/null || echo "?")
    LATENCY=$(echo "$REPLIES" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d['replies'][0]; print(r.get('latency_ms','?'))" 2>/dev/null || echo "?")
    TRUNC=$(echo "$REPLIES" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d['replies'][0]; print(r.get('truncated','?'))" 2>/dev/null || echo "?")
    ORIG_LEN=$(echo "$REPLIES" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d['replies'][0]; print(r.get('orig_len','null'))" 2>/dev/null || echo "?")
    REPLY_ID=$(echo "$REPLIES" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d['replies'][0]; print(r.get('reply_id','?'))" 2>/dev/null || echo "?")
    if [ "$RSTATUS" = "ok" ]; then
      echo "  ✅ $FROM_AGENT→$TO_AGENT: reply_id=$REPLY_ID status=$RSTATUS latency_ms=$LATENCY truncated=$TRUNC orig_len=$ORIG_LEN"
      PASS=$((PASS+1))
    else
      echo "  ❌ $FROM_AGENT→$TO_AGENT: reply_id=$REPLY_ID status=$RSTATUS latency_ms=$LATENCY"
      echo "     原始响应: $REPLIES"
      FAIL=$((FAIL+1))
    fi
  fi
done

echo ""
echo "=== 汇总 ==="
echo "  PASS: $PASS  FAIL: $FAIL"
if [ "$FAIL" = "0" ]; then
  echo "  🎉 全部通过"
  exit 0
else
  echo "  ❌ 有失败项，请检查对应 agent 的 openclaw 日志"
  exit 1
fi
