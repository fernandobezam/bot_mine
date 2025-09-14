@echo off
REM ===== Iniciar MC Render Bot =====

REM Navegar até a pasta do bot
cd /d "%~dp0"

REM Rodar o bot
echo 🚀 Iniciando MC Render Bot...
node mc_render_bot_fixed.js

pause
