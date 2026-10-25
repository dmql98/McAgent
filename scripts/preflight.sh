#!/usr/bin/env bash
# ============================================================
# 首启自检 —— 部署前跑一遍，有问题直接退出非 0
#
# 用法：bash scripts/preflight.sh
#       bash scripts/preflight.sh --silent   # 只输出失败项
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/server"
ENV_FILE="$SERVER_DIR/.env"
SILENT=0
[[ "${1:-}" == "--silent" ]] && SILENT=1

FAIL=0
PASS=0

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
dim()   { printf '\033[2m%s\033[0m\n' "$1"; }

ok() {
  PASS=$((PASS + 1))
  [[ $SILENT -eq 0 ]] && green "  ✅ $1"
  return 0
}
ng() {
  FAIL=$((FAIL + 1))
  red "  ❌ $1"
  [[ -n "${2:-}" ]] && dim "     → $2"
  return 0
}

echo "============================================================"
echo "「麦门知己」首启自检"
echo "============================================================"

# ---------- 1. Node ----------
echo
echo "[1/7] 运行时"
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v)"
  NODE_MAJOR="${NODE_VER#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [[ "$NODE_MAJOR" -ge 22 ]]; then
    ok "Node $NODE_VER（需要 ≥22，因为用了内置 node:sqlite）"
  else
    ng "Node $NODE_VER 版本过低" "本项目用 node:sqlite（Node 22+ 内置），请升级到 22 或更高"
  fi
else
  ng "找不到 node" "安装 Node 22+：https://nodejs.org"
fi

# ---------- 2. .env ----------
echo
echo "[2/7] 配置文件"
if [[ -f "$ENV_FILE" ]]; then
  ok ".env 存在"

  # 读变量（不 source，避免执行任意代码）
  getenv() { grep -E "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/^"//;s/"$//'; }

  JWT="$(getenv JWT_SECRET)"
  KEY="$(getenv TOKEN_ENC_KEY)"

  if [[ -z "$JWT" ]]; then
    ng "JWT_SECRET 未设置" "生成：openssl rand -hex 32"
  elif [[ ${#JWT} -lt 32 ]]; then
    ng "JWT_SECRET 太短（${#JWT} 字符，需 ≥32）" "生成：openssl rand -hex 32"
  else
    ok "JWT_SECRET 已设置（${#JWT} 字符）"
  fi

  if [[ -z "$KEY" ]]; then
    ng "TOKEN_ENC_KEY 未设置" "生成：openssl rand -hex 32（必须是 64 位 hex）"
  elif [[ ! "$KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then
    ng "TOKEN_ENC_KEY 格式不对（当前长度 ${#KEY}，需 64 位 hex）" "生成：openssl rand -hex 32"
  else
    ok "TOKEN_ENC_KEY 格式正确（64 位 hex）"
  fi

  NODE_ENV_VAL="$(getenv NODE_ENV)"
  if [[ "$NODE_ENV_VAL" == "production" ]]; then
    ok "NODE_ENV=production"
  else
    dim "     ⚠️  NODE_ENV=${NODE_ENV_VAL:-未设置}（生产环境应为 production）"
  fi

  SKIP="$(getenv MCP_VERIFY_SKIP)"
  if [[ "$SKIP" == "1" ]]; then
    ng "MCP_VERIFY_SKIP=1" "生产环境必须为 0，否则任何人都能用假 Token 登录"
  else
    ok "MCP_VERIFY_SKIP 未开启"
  fi

  LLM_KEY="$(getenv LLM_API_KEY)"
  if [[ -z "$LLM_KEY" ]]; then
    dim "     ⚠️  LLM_API_KEY 未配置 —— 回复会走模板兜底（功能可用，但文案不够灵动）"
  else
    ok "LLM_API_KEY 已配置"
  fi
else
  ng ".env 不存在" "cp server/.env.example server/.env 然后填写"
fi

# ---------- 3. 数据目录 ----------
echo
echo "[3/7] 数据目录"
DATA_DIR="$(cd "$SERVER_DIR" 2>/dev/null && { [[ -f "$ENV_FILE" ]] && grep -E '^[[:space:]]*DATA_DIR[[:space:]]*=' "$ENV_FILE" | tail -1 | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; } || true)"
DATA_DIR="${DATA_DIR:-./data}"
[[ "$DATA_DIR" != /* ]] && DATA_DIR="$SERVER_DIR/${DATA_DIR#./}"

if [[ -d "$DATA_DIR" ]]; then
  if [[ -w "$DATA_DIR" ]]; then
    ok "数据目录可写：$DATA_DIR"
  else
    ng "数据目录不可写：$DATA_DIR" "chown -R $(whoami) $DATA_DIR"
  fi
else
  if mkdir -p "$DATA_DIR" 2>/dev/null; then
    ok "数据目录已创建：$DATA_DIR"
  else
    ng "无法创建数据目录：$DATA_DIR" "检查父目录权限"
  fi
fi

# ---------- 4. 端口 ----------
echo
echo "[4/7] 端口"
PORT_VAL="$(grep -E '^[[:space:]]*PORT[[:space:]]*=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' ')"
PORT_VAL="${PORT_VAL:-3000}"

port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
  else
    # 兜底：直接试连
    (echo >/dev/tcp/127.0.0.1/"$1") >/dev/null 2>&1
  fi
}

if port_busy "$PORT_VAL"; then
  ng "端口 $PORT_VAL 已被占用" "可能是旧进程：pm2 list / lsof -i :$PORT_VAL"
else
  ok "端口 $PORT_VAL 空闲"
fi

# ---------- 5. 麦当劳 MCP 连通性 ----------
echo
echo "[5/7] 麦当劳 MCP"
MCP_URL="$(grep -E '^[[:space:]]*MCP_ENDPOINT[[:space:]]*=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' ')"
MCP_URL="${MCP_URL:-https://mcp.mcd.cn}"

if command -v curl >/dev/null 2>&1; then
  # 只探 DNS + TCP + TLS，不带 Token，不发业务请求
  if curl -sS -o /dev/null --max-time 8 -w '' "$MCP_URL" 2>/dev/null; then
    ok "可连通：$MCP_URL"
  else
    HTTP_CODE="$(curl -sS -o /dev/null --max-time 8 -w '%{http_code}' "$MCP_URL" 2>/dev/null)"
    HTTP_CODE="${HTTP_CODE:-000}"
    if [[ "$HTTP_CODE" =~ ^[45][0-9][0-9]$ ]]; then
      ok "可连通（返回 $HTTP_CODE，服务在线即可）"
    else
      ng "连不上 $MCP_URL" "检查网络/防火墙；MCP 挂了服务仍可用（走离线兜底菜单）"
    fi
  fi
else
  dim "     ⚠️  没有 curl，跳过连通性检查"
fi

# ---------- 6. LLM endpoint ----------
echo
echo "[6/7] LLM 服务"
LLM_URL="$(grep -E '^[[:space:]]*LLM_BASE_URL[[:space:]]*=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' ')"
LLM_URL="${LLM_URL:-https://api.deepseek.com/v1}"
if command -v curl >/dev/null 2>&1; then
  # 注意：curl 失败时 -w 仍会输出 000，所以不要再 `|| echo 000`，否则变成 000000
  CODE="$(curl -sS -o /dev/null --max-time 8 -w '%{http_code}' "$LLM_URL/models" 2>/dev/null)"
  CODE="${CODE:-000}"
  if [[ "$CODE" =~ ^[234][0-9][0-9]$ ]]; then
    ok "可访问：$LLM_URL（HTTP $CODE）"
  else
    dim "     ⚠️  访问 $LLM_URL 返回 $CODE —— 不可用时会走模板兜底，不影响启动"
  fi
else
  dim "     ⚠️  没有 curl，跳过"
fi

# ---------- 7. 构建产物 ----------
echo
echo "[7/7] 构建产物"
if [[ -f "$SERVER_DIR/dist/index.js" ]]; then
  ok "dist/index.js 存在"
else
  ng "dist/index.js 不存在" "cd server && npm run build"
fi

if [[ -d "$SERVER_DIR/node_modules" ]]; then
  ok "node_modules 已安装"
else
  ng "node_modules 不存在" "cd server && npm ci"
fi

WEB_INDEX="$ROOT/web/index.html"
if [[ -f "$WEB_INDEX" ]]; then
  ok "前端入口存在：web/index.html"
else
  ng "web/index.html 不存在" "前端文件缺失，检查部署是否完整"
fi

# ---------- 汇总 ----------
echo
echo "============================================================"
if [[ $FAIL -eq 0 ]]; then
  green "全部通过（$PASS 项）"
  echo "============================================================"
  exit 0
else
  red "失败 $FAIL 项 · 通过 $PASS 项"
  echo "============================================================"
  exit 1
fi
