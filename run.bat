@echo off
chcp 950 >nul
title BEAST ESP32 數據監控中心啟動器

echo ===================================================
echo   BEAST ESP32 數據監控監測系統 - 一鍵啟動腳本
echo ===================================================
echo.

:: 1. 檢查 Python 是否安裝
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [錯誤] 找不到 Python！請確認已安裝 Python 並勾選 "Add Python to PATH"。
    echo 官方下載網址: https://www.python.org/
    pause
    exit /b
)

:: 2. 安裝/更新相依套件
echo [1/3] 正在檢查並安裝相依套件 (requirements.txt)...
pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo [警告] 套件安裝過程中出現問題，但系統仍會嘗試啟動。
)
echo.

:: 3. 獲取本機 IPv4 地址 (超強功能：讓手機連線)
echo [2/3] 正在獲取您的區域網路 IP，方便手機進行測試...
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| find "IPv4"') do (
    set LAN_IP=%%a
)
:: 移除 IP 前面的空白
set LAN_IP=%LAN_IP: =%

echo ===================================================
echo ?? 【手機測試專用網址】: http://%LAN_IP%:5000
echo ?? 【電腦本機測試網址】: http://127.0.0.1:5000
echo ===================================================
echo.

:: 4. 自動在瀏覽器開啟網頁
start http://127.0.0.1:5000
timeout /t 2 >nul

:: 5. 啟動 Flask 後端
echo [3/3] 正在啟動 Flask 後端伺服器...
echo ---------------------------------------------------
echo 提示: 請保持此視窗開啟以維持伺服器運作。
echo 結束請關閉此視窗或按下 Ctrl + C。
echo ---------------------------------------------------
echo.
python app.py

pause