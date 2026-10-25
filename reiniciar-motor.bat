@echo off
rem Fecha o motor do AutoEdit que estiver rodando e liga de novo.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :47380 ^| findstr LISTENING') do taskkill /PID %%p /T /F >nul 2>&1
cd /d "%~dp0"
start "AutoEdit motor" cmd /k npm run engine
exit
