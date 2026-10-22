@echo off
setlocal
cd /d "%~dp0"
if not exist "api\.env" (
  echo Local setup has not been completed.
  echo Run setup-local.bat first.
  pause
  exit /b 1
)
node scripts\start-dev.cjs
if errorlevel 1 pause
