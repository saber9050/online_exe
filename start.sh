#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "[online-exe] 首次运行，安装依赖..."
  npm install --no-audit --no-fund
fi

echo "[online-exe] 启动服务：http://127.0.0.1:8080"
echo "[online-exe] 管理页：http://127.0.0.1:8080/admin"
exec node server.js
