#!/usr/bin/env bash
# 把使用版(打包 app)的数据库快照到开发版,用于复现真实数据上的问题。
# 单向:只从使用版拷向开发版,避免开发实验回灌真实数据。
# 用 sqlite3 在线备份而非 cp —— WAL 未 checkpoint 时直接 cp 会丢最近写入。
set -euo pipefail

SUPPORT="$HOME/Library/Application Support"
PROD="$SUPPORT/Duetlens/duetlens.db"
DEV="$SUPPORT/Duetlens-dev/duetlens.db"

if [ ! -f "$PROD" ]; then
  echo "找不到使用版数据库:$PROD" >&2
  echo "(使用版 = npm run package 产出的 Duetlens.app;开发版 npm start 写的是 Duetlens-dev)" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEV")"

if [ -f "$DEV" ]; then
  BAK="$DEV.bak-$(date +%Y%m%d-%H%M%S)"
  mv "$DEV" "$BAK"
  rm -f "$DEV-wal" "$DEV-shm"
  echo "旧开发库已备份:$BAK"
fi

sqlite3 "$PROD" ".backup '$DEV'"
echo "快照完成:$DEV"
echo "开发版下次启动即读到这份数据(已启动的请重启)。"
