@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js。请先安装 Node.js（https://nodejs.org/）后重试。
    pause
    exit /b 1
)

if not exist node_modules (
    echo 首次运行，正在安装依赖（npm install）...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
)

rem 延迟约 2 秒后自动打开浏览器（等 server 就绪）
start "ofair-browser" /min cmd /c "ping 127.0.0.1 -n 3 >nul & start """" http://127.0.0.1:8787"

call npm run serve

echo.
echo （服务已停止，按任意键关闭窗口）
pause >nul
