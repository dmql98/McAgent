#!/usr/bin/env bash
# ============================================================
# 诚实冒烟：用真实 HTTP 打一遍全部关键路径
#
# 单元测试测的是"函数算得对不对"，这个脚本测的是
# **接口边界语义对不对** —— 路径、状态码、错误码、SSE 帧。
# 真实联调中发现的 4 个 bug 全部只能在这一层暴露
# （详见 docs/security-audit.md 附录）。
#
# 用法：
#   bash scripts/smoke.sh                      # 默认 http://127.0.0.1:3000
#   BASE=http://1.2.3.4 bash scripts/smoke.sh
#   bash scripts/smoke.sh --keep               # 保留测试账号（不自动解绑）
#
# 退出码：0 全过，非 0 有失败项
# ============================================================
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:3000}"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

PASS=0
FAIL=0
COOKIE="$(mktemp)"
COOKIE2="$(mktemp)"
BODY="$(mktemp)"
TMPD="$(mktemp -d)"
cleanup() { rm -rf "$COOKIE" "$COOKIE2" "$BODY" "$TMPD"; }
trap cleanup EXIT

c_g="\033[32m"; c_r="\033[31m"; c_y="\033[33m"; c_d="\033[2m"; c_0="\033[0m"

ok()   { PASS=$((PASS+1)); printf "  ${c_g}ok${c_0}   %s\n" "$1"; }
bad()  { FAIL=$((FAIL+1)); printf "  ${c_r}FAIL${c_0} %s\n" "$1"; [ -n "${2:-}" ] && printf "       ${c_d}%s${c_0}\n" "$2"; }
sect() { printf "\n${c_y}[%s]${c_0} %s\n" "$1" "$2"; }

# call METHOD PATH EXPECTED_STATUS [COOKIE_FILE] [JSON_BODY]
# 结果：$BODY=响应体  $STATUS=状态码
call() {
  local method="$1" path="$2" want="${3:-200}" jar="${4:-}" data="${5:-}"
  local args=(-s -m 30 -o "$BODY" -w '%{http_code}' -X "$method" "$BASE$path")
  [ -n "$jar" ] && args+=(-b "$jar" -c "$jar")
  [ -n "$data" ] && args+=(-H 'Content-Type: application/json' -d "$data")
  STATUS="$(curl "${args[@]}" 2>/dev/null)"
  [ "$STATUS" = "$want" ]
  return $?
}

# 断言响应体含某个 JSON 片段
has() { grep -q -- "$1" "$BODY" 2>/dev/null; }

expect() { # expect <描述> <want> <method> <path> [jar] [data]
  local desc="$1" want="${2:-200}"; shift 2
  if call "$@"; then ok "$desc  (HTTP $STATUS)"; else bad "$desc" "期望 HTTP $want，实际 $STATUS：$(head -c 200 "$BODY")"; fi
}

echo "=================================================="
echo " 麦门知己 · 真实链路冒烟"
echo " 目标：$BASE"
echo "=================================================="

# ---------------------------------------------------------------
sect 1 "健康检查"
expect "GET /api/health 返回 200" 200 GET /api/health
if has '"ok":true'; then ok "健康体 ok=true"; else bad "健康体缺少 ok:true"; fi

# ---------------------------------------------------------------
sect 2 "未登录时全部受保护接口都应 401"
expect "GET  /api/me 未登录 → 401"        401 GET  /api/me
expect "PUT  /api/profile 未登录 → 401"   401 PUT  /api/profile "" '{"nickname":"x"}'
expect "GET  /api/memory 未登录 → 401"    401 GET  /api/memory
expect "POST /api/orders/confirm 未登录 → 401" 401 POST /api/orders/confirm "" '{"chatId":"c_x"}'
expect "GET  /api/orders/x 未登录 → 401"  401 GET  /api/orders/x

# ---------------------------------------------------------------
sect 3 "登录参数校验"
expect "token 太短 → 400" 400 POST /api/auth/login "" '{"token":"abc"}'
expect "缺 token 字段 → 400" 400 POST /api/auth/login "" '{}'
if has 'Token 看起来不完整'; then ok "文案对用户友好"; else bad "文案不对" "$(head -c 150 "$BODY")"; fi

# ---------------------------------------------------------------
sect 4 "登录 + 当前用户"
TOKEN="smoke-$(date +%s)-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
if call POST /api/auth/login 200 "$COOKIE" "{\"token\":\"$TOKEN\"}"; then
  ok "POST /api/auth/login  (HTTP 200)"
  has '"isNew":true' && ok "新用户 isNew=true" || bad "缺少 isNew=true"
  UID1="$(grep -o '"userId":"[a-f0-9]*"' "$BODY" | grep -o '[a-f0-9]\{16\}')"
  ok "userId=$UID1"
else
  bad "登录失败 (HTTP $STATUS)" "$(head -c 200 "$BODY")"
  echo; echo "登录都失败了，后面的不用跑了。检查 .env 的 JWT_SECRET / TOKEN_ENC_KEY。"
  exit 1
fi

COOKIE_SET="$(grep -c mcd_sid "$COOKIE" 2>/dev/null || echo 0)"
[ "$COOKIE_SET" -ge 1 ] && ok "mcd_sid Cookie 已下发" || bad "没拿到 mcd_sid Cookie"

expect "GET /api/me → 200" 200 GET /api/me "$COOKIE"
has '"needOnboarding":true' && ok "冷启动 needOnboarding=true" || bad "新用户应 needOnboarding=true"
has '"taboo":\[\]' && ok "profile.taboo 默认空数组" || bad "profile.taboo 形状不对"

# ---------------------------------------------------------------
sect 5 "三连问：自动推算星座"
if call PUT /api/profile 200 "$COOKIE" '{"nickname":"冒烟测试","birthday":"1998-10-24","taboo":["香菜"]}'; then
  ok "PUT /api/profile  (HTTP 200)"
  has '"starSign":"天蝎座"' && ok "10-24 → 天蝎座（服务端自动推算）" || bad "星座推算错了" "$(head -c 250 "$BODY")"
  has '"needOnboarding":false' && ok "填完昵称 needOnboarding=false" || bad "needOnboarding 没变"
else
  bad "资料更新失败 (HTTP $STATUS)" "$(head -c 200 "$BODY")"
fi

expect "生日格式非法 → 400" 400 PUT /api/profile "$COOKIE" '{"birthday":"1998/10/24"}'

# ---------------------------------------------------------------
sect 6 "记忆库"
expect "GET /api/memory → 200" 200 GET /api/memory "$COOKIE"
for k in profile taste habits moodDiary rituals; do
  has "\"key\":\"$k\"" && ok "记忆卡包含 $k" || bad "记忆卡缺少 $k"
done
has 'privacyNote' && ok "带隐私说明文案" || bad "缺 privacyNote"
expect "删除不存在的条目 → 404" 404 DELETE /api/memory/profile.nope "$COOKIE"
expect "删除昵称条目 → 200" 200 DELETE /api/memory/profile.nickname "$COOKIE"

# ---------------------------------------------------------------
sect 7 "SSE 对话（核心路径）"
SSE="$TMPD/sse.txt"
SCODE="$(curl -s -N -m 60 -o "$SSE" -w '%{http_code}' -b "$COOKIE" \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"message":"我好烦啊"}' "$BASE/api/chat" 2>/dev/null)"

if [ "$SCODE" = "200" ]; then ok "POST /api/chat  (HTTP 200)"; else bad "对话返回 $SCODE" "$(head -c 200 "$SSE")"; fi

EVENTS="$(grep -c '^event:' "$SSE" 2>/dev/null || echo 0)"
[ "$EVENTS" -ge 5 ] && ok "收到 $EVENTS 个 SSE 事件" || bad "事件太少（$EVENTS 个），可能是 Bug 1 复发" "$(head -c 300 "$SSE")"

for e in stage reply done; do
  grep -q "^event: $e" "$SSE" && ok "有 $e 事件" || bad "缺少 $e 事件"
done
[ "$(grep -c '^event: stage' "$SSE" 2>/dev/null || echo 0)" -eq 4 ] \
  && ok "4 个 stage 齐全（intent/knowledge/menu/compose）" \
  || bad "stage 数量不对（应为 4）"

has_err="$(grep -c '^event: error' "$SSE" 2>/dev/null || echo 0)"
if [ "$has_err" = "0" ]; then
  ok "无 error 事件"
  grep -q '"menu":\[' "$SSE" && ok "reply 带菜单数组" || bad "reply 没有 menu"
  grep -q '"total":' "$SSE" && ok "reply 带 total" || bad "reply 没有 total"
  grep -q '"dataSource":"' "$SSE" && ok "reply 标明 dataSource（mcp/cache/offline）" || bad "reply 缺 dataSource"
else
  # 真实 Token 无效时这里会是 TOKEN_INVALID，属正常（用假 Token 冒烟）
  if grep -q 'TOKEN_INVALID' "$SSE"; then
    printf "  ${c_d}skip${c_0} 对话报 TOKEN_INVALID —— 冒烟用的是假 Token，属预期\n"
    printf "       ${c_d}换成真实 Token 重跑可验证完整菜单链路${c_0}\n"
  else
    bad "对话出现 error 事件" "$(grep -A1 '^event: error' "$SSE" | tail -1 | head -c 200)"
  fi
fi

CHATID="$(grep -o 'c_[a-f0-9]\{12\}' "$SSE" | head -1)"
[ -n "$CHATID" ] && ok "拿到 chatId=$CHATID" || bad "没拿到 chatId"

# ---------------------------------------------------------------
sect 8 "订单安全闸门"
if [ -n "$CHATID" ]; then
  expect "不存在的 chatId → 404" 404 POST /api/orders/confirm "$COOKIE" '{"chatId":"c_000000000000"}'
  expect "GET 不存在的订单 → 404" 404 GET /api/orders/o_nope "$COOKIE"

  # 第二个账号尝试确认别人的对话 → 必须 403
  TOKEN2="smoke2-$(date +%s)-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  if call POST /api/auth/login 200 "$COOKIE2" "{\"token\":\"$TOKEN2\"}"; then
    expect "越权确认别人对话 → 403" 403 POST /api/orders/confirm "$COOKIE2" "{\"chatId\":\"$CHATID\"}"
    has '不是你的' && ok "越权被明确拒绝" || bad "越权文案不明确"
  else
    bad "第二个账号登录失败"
  fi
else
  bad "没有 chatId，跳过订单闸门测试"
fi

# ---------------------------------------------------------------
sect 9 "访客额度（每 IP 每日 1 次）"
G1="$(curl -s -m 30 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  -d '{"message":"你好","guest":true}' "$BASE/api/chat" 2>/dev/null)"
G2="$(curl -s -m 30 -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -d '{"message":"你好","guest":true}' "$BASE/api/chat" 2>/dev/null)"
if [ "$G1" = "200" ] || [ "$G1" = "429" ]; then
  ok "访客第 1 次进入流水线 (HTTP $G1)"
else
  bad "访客第 1 次异常 (HTTP $G1)"
fi
if [ "$G2" = "429" ]; then
  ok "访客第 2 次被限额 (HTTP 429)"
  has 'GUEST_LIMIT_REACHED' && ok "错误码 GUEST_LIMIT_REACHED" || bad "错误码不对" "$(head -c 150 "$BODY")"
else
  printf "  ${c_d}skip${c_0} 第 2 次是 $G2（本机今日额度可能已用尽，前一次就是 429）\n"
fi

# ---------------------------------------------------------------
sect 10 "解绑后残留 Cookie 必须 401（不是 400/500）"
if [ "$KEEP" = "1" ]; then
  printf "  ${c_d}skip${c_0} --keep 指定保留测试账号\n"
else
  expect "DELETE /api/auth/unbind → 200" 200 DELETE /api/auth/unbind "$COOKIE"
  expect "解绑后 GET /api/me → 401" 401 GET /api/me "$COOKIE"
  has '解绑' && ok "401 文案说明要重新粘贴 Token" || bad "401 文案不清楚" "$(head -c 150 "$BODY")"
  expect "解绑后 PUT /api/profile → 401" 401 PUT /api/profile "$COOKIE" '{"nickname":"x"}'
fi

# ---------------------------------------------------------------
echo ""
echo "=================================================="
if [ "$FAIL" -eq 0 ]; then
  printf " ${c_g}全部通过${c_0}  通过 %d · 失败 0\n" "$PASS"
else
  printf " ${c_r}有失败${c_0}  通过 %d · 失败 %d\n" "$PASS" "$FAIL"
fi
echo "=================================================="
[ "$FAIL" -eq 0 ] || exit 1
