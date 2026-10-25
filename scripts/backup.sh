#!/usr/bin/env bash
# ============================================================
# SQLite 备份脚本
#
# 用法：
#   bash scripts/backup.sh                 # 备份到默认目录
#   bash scripts/backup.sh /mnt/backup     # 指定备份目录
#   bash scripts/backup.sh --keep 14       # 保留 14 天（默认 7）
#
# crontab（注意 % 必须转义为 \% ，这是最容易踩的坑）：
#   0 3 * * * bash /var/www/mcd-soulmate/scripts/backup.sh >> /var/www/mcd-soulmate/logs/backup.log 2>&1
#
# ⚠️ 为什么不能直接 cp mcd.db：
#    服务在跑的时候有 WAL 未落盘，直接 cp 会拷到不一致的快照。
#    sqlite3 .backup 用的是官方在线备份 API，能保证一致性。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/server"
ENV_FILE="$SERVER_DIR/.env"

KEEP=7
BACKUP_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP="${2:-7}"; shift 2 ;;
    *) BACKUP_DIR="$1"; shift ;;
  esac
done

# ---------- 定位数据库 ----------
DATA_DIR="$(grep -E '^[[:space:]]*DATA_DIR[[:space:]]*=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' ')"
DATA_DIR="${DATA_DIR:-./data}"
[[ "$DATA_DIR" != /* ]] && DATA_DIR="$SERVER_DIR/${DATA_DIR#./}"

# db/index.ts 里的数据库文件名
DB_FILE="$DATA_DIR/mcd.db"
if [[ ! -f "$DB_FILE" ]]; then
  # 兜底：找目录里唯一的 .db
  DB_FILE="$(find "$DATA_DIR" -maxdepth 1 -name "*.db" -type f 2>/dev/null | head -1)"
fi

if [[ -z "$DB_FILE" || ! -f "$DB_FILE" ]]; then
  echo "❌ 找不到数据库文件（DATA_DIR=$DATA_DIR）"
  echo "   服务是否启动过？路径是否正确？"
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
mkdir -p "$BACKUP_DIR"

TS="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/mcd-$TS.db"

echo "============================================================"
echo "「麦门知己」数据库备份"
echo "源：$DB_FILE"
echo "目标：$OUT"

# ---------- 执行备份 ----------
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_FILE" ".backup '$OUT'"
  echo "方式：sqlite3 .backup（在线一致性快照）"
else
  # 没有 sqlite3 就退化为文件拷贝，并明确告知风险
  echo "⚠️  未安装 sqlite3，退化为文件拷贝（可能不一致）"
  echo "    建议：apt install sqlite3"
  cp "$DB_FILE" "$OUT"
  [[ -f "$DB_FILE-wal" ]] && cp "$DB_FILE-wal" "$OUT-wal" 2>/dev/null || true
  [[ -f "$DB_FILE-shm" ]] && cp "$DB_FILE-shm" "$OUT-shm" 2>/dev/null || true
fi

# ---------- 校验 ----------
if [[ ! -s "$OUT" ]]; then
  echo "❌ 备份文件为空，备份失败"
  exit 1
fi

SIZE="$(du -h "$OUT" | cut -f1)"
echo "大小：$SIZE"

# 完整性检查（有 sqlite3 才做）
if command -v sqlite3 >/dev/null 2>&1; then
  RESULT="$(sqlite3 "$OUT" "PRAGMA integrity_check;" 2>&1 | head -1)"
  if [[ "$RESULT" == "ok" ]]; then
    echo "校验：integrity_check = ok"
  else
    echo "❌ 备份文件校验失败：$RESULT"
    exit 1
  fi
fi

# ---------- 清理旧备份 ----------
DELETED=0
if [[ -d "$BACKUP_DIR" ]]; then
  while IFS= read -r old; do
    rm -f "$old" && DELETED=$((DELETED + 1))
  done < <(find "$BACKUP_DIR" -name "mcd-*.db*" -type f -mtime "+$KEEP" 2>/dev/null)
fi

echo "清理：删除 $DELETED 个超过 ${KEEP} 天的旧备份"
echo "============================================================"
printf '\033[32m✅ 备份完成\033[0m\n'
