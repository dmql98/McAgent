#!/usr/bin/env bash
# ============================================================
# 部署脚本（幂等，可重复执行）
#
# 用法：
#   bash scripts/deploy.sh              # 标准部署：拉代码 → 装依赖 → 构建 → 重载
#   bash scripts/deploy.sh --no-pull    # 不拉代码（本地已改好，只重新构建）
#   bash scripts/deploy.sh --with-preflight   # 先跑自检（推荐首次部署用）
#
# 前置：pm2 已安装且 ecosystem.config.js 至少启动过一次
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/server"

DO_PULL=1
WITH_PREFLIGHT=0
for arg in "$@"; do
  case "$arg" in
    --no-pull) DO_PULL=0 ;;
    --with-preflight) WITH_PREFLIGHT=1 ;;
    *) echo "未知参数：$arg"; exit 1 ;;
  esac
done

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[31m  ✗ %s\033[0m\n' "$1"; exit 1; }

echo "============================================================"
echo "「麦门知己」部署"
echo "路径：$ROOT"
echo "============================================================"

# ---------- 0. 环境检查 ----------
step "0/6 环境检查"
command -v node >/dev/null 2>&1 || die "找不到 node，请先安装 Node 22+"
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
[[ "$NODE_MAJOR" -ge 22 ]] || die "Node 版本 $(node -v) 过低，需要 ≥22"
ok "Node $(node -v)"

command -v pm2 >/dev/null 2>&1 || die "找不到 pm2，请先 npm i -g pm2"
ok "pm2 $(pm2 -v 2>/dev/null | tail -1)"

[[ -f "$SERVER_DIR/.env" ]] || die "server/.env 不存在，先 cp server/.env.example server/.env 并填写"
ok ".env 存在"

if [[ $WITH_PREFLIGHT -eq 1 ]]; then
  step "0.5 首启自检"
  bash "$ROOT/scripts/preflight.sh" || die "自检未通过，修好再部署"
fi

# ---------- 1. 拉代码 ----------
if [[ $DO_PULL -eq 1 ]]; then
  step "1/6 拉取代码"
  cd "$ROOT"
  if [[ -d .git ]]; then
    BEFORE="$(git rev-parse --short HEAD)"
    git pull --ff-only || die "git pull 失败（可能有本地改动冲突）"
    AFTER="$(git rev-parse --short HEAD)"
    if [[ "$BEFORE" == "$AFTER" ]]; then
      ok "已是最新（$AFTER）"
    else
      ok "更新 $BEFORE → $AFTER"
    fi
  else
    ok "非 git 仓库，跳过"
  fi
else
  step "1/6 跳过拉代码（--no-pull）"
fi

# ---------- 2. 安装依赖 ----------
step "2/6 安装依赖"
cd "$SERVER_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev 2>&1 | tail -3
  # 构建需要 devDependencies（typescript），所以再补装
  npm install --no-audit --no-fund 2>&1 | tail -3
else
  npm install --no-audit --no-fund 2>&1 | tail -3
fi
ok "依赖已就绪"

# ---------- 3. 构建 ----------
step "3/6 构建"
npm run build || die "构建失败，检查 TypeScript 错误"
[[ -f dist/index.js ]] || die "构建后 dist/index.js 仍不存在"
ok "构建完成"

# ---------- 4. 确保日志目录 ----------
step "4/6 准备日志目录"
mkdir -p "$SERVER_DIR/logs"
ok "logs/ 已就绪"

# ---------- 5. pm2 重载 ----------
step "5/6 重载进程"
cd "$SERVER_DIR"
if pm2 describe mcd-soulmate >/dev/null 2>&1; then
  pm2 reload ecosystem.config.js --update-env
  ok "已 reload（零停机）"
else
  pm2 start ecosystem.config.js
  ok "已 start"
  echo
  echo "  提示：首次启动后记得执行下面两条，让服务随服务器自启"
  echo "    pm2 startup"
  echo "    pm2 save"
fi

# ---------- 6. 健康检查 ----------
step "6/6 健康检查"
PORT_VAL="$(grep -E '^[[:space:]]*PORT[[:space:]]*=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' ')"
PORT_VAL="${PORT_VAL:-3000}"

HEALTHY=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if command -v curl >/dev/null 2>&1; then
    BODY="$(curl -sS --max-time 3 "http://127.0.0.1:$PORT_VAL/api/health" 2>/dev/null || true)"
    if echo "$BODY" | grep -q '"ok"'; then
      HEALTHY=1
      ok "健康检查通过：$BODY"
      break
    fi
  else
    HEALTHY=1
    printf '\033[2m     ⚠️  没有 curl，跳过健康检查\033[0m\n'
    break
  fi
done

if [[ $HEALTHY -eq 0 ]]; then
  echo
  printf '\033[31m  健康检查未通过，查看日志：\033[0m\n'
  pm2 logs mcd-soulmate --lines 40 --nostream || true
  die "部署后服务未就绪"
fi

# ---------- 完成 ----------
echo
echo "============================================================"
printf '\033[32m部署完成\033[0m\n'
echo "============================================================"
echo "  进程状态：pm2 status"
echo "  实时日志：pm2 logs mcd-soulmate"
echo "  重启服务：pm2 restart mcd-soulmate"
echo "  回滚代码：git checkout <上一个 commit> && bash scripts/deploy.sh --no-pull"
