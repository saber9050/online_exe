@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist node_modules (
  echo [online-exe] 首次运行，安装依赖...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [online-exe] 依赖安装失败，请检查网络或使用镜像。
    pause
    exit /b 1
  )
)

echo [online-exe] 启动服务：http://127.0.0.1:8080
echo [online-exe] 管理页：http://127.0.0.1:8080/admin
echo.
node server.js
pause
