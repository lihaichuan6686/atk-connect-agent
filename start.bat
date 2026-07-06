@echo off
chcp 65001 >nul
echo ========================================
echo  ATK Agent - AI-Powered Space Mission Control
echo ========================================
echo.

cd /d "%~dp0"

if exist .venv\Scripts\activate.bat (
    call .venv\Scripts\activate.bat
)

python atk_agent.py
pause
