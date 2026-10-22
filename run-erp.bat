@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js 22 LTS from https://nodejs.org/
  pause
  exit /b 1
)
if not exist "api\.env" goto do_setup
if not exist "api\node_modules\.bin\tsx.cmd" goto do_setup
if not exist "api\node_modules\.bin\prisma.cmd" goto do_setup
if not exist "api\node_modules\.prisma\client\index.js" goto do_setup
if not exist "api\node_modules\.prisma\client\query_engine-windows.dll.node" goto do_setup
if not exist "web\node_modules\.bin\vite.cmd" goto do_setup
goto start_erp
:do_setup
echo First-time setup required. The setup may take several minutes.
call setup-local.bat
if errorlevel 1 (
  echo Setup failed. Read the error above and fix it before starting the ERP.
  pause
  exit /b 1
)
:start_erp
call node scripts\start-dev.cjs
if errorlevel 1 pause
