@echo off
setlocal
cd /d "%~dp0"
echo.
echo ==========================================
echo  Sastha Infinite ERP - Local Setup
echo ==========================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed.
  echo Install Node.js 22 LTS from https://nodejs.org/
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm was not found. Reinstall Node.js.
  pause
  exit /b 1
)
where docker >nul 2>nul
if errorlevel 1 (
  echo ERROR: Docker was not found.
  echo Install Docker Desktop, open it, and run this file again.
  pause
  exit /b 1
)
echo Node version:
node --version
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\check-running-project.ps1"
if errorlevel 1 (
  echo Setup stopped because the ERP is still running. Close the Sastha ERP API/web windows and try again.
  pause
  exit /b 1
)
if not exist "api\.env" (
  echo Creating api\.env with a random JWT secret...
  node -e "const fs=require('fs'),crypto=require('crypto');const p='api/.env';const n=String.fromCharCode(10);const s=crypto.randomBytes(48).toString('hex');fs.writeFileSync(p,['DATABASE_URL=postgresql://sastha_app:local_dev_change_me@localhost:5432/sastha_erp?schema=public','JWT_SECRET='+s,'PORT=4000','WEB_ORIGIN=http://localhost:5173,http://127.0.0.1:5173','NODE_ENV=development'].join(n)+n);console.log('Created api/.env');"
  if errorlevel 1 (
    echo ERROR: Could not create api\.env
    pause
    exit /b 1
  )
) else (
  echo api\.env already exists. Existing settings will be kept.
)
node -e "const fs=require('fs');const s=fs.readFileSync('api/.env','utf8');const value=k=>{const m=s.match(new RegExp('^'+k+'=(.*)$','m'));return (m?m[1]:'').trim().split(String.fromCharCode(34)).join('').split(String.fromCharCode(39)).join('')};if(!/^(postgresql|postgres):\/\//.test(value('DATABASE_URL'))){console.error('ERROR: DATABASE_URL must be on its own line and start with postgresql:// or postgres://');process.exit(1)}if(value('JWT_SECRET').length<32){console.error('ERROR: JWT_SECRET is missing or too short');process.exit(1)}"
if errorlevel 1 (
  echo Fix api\.env using the instructions in README.md, then run setup again.
  pause
  exit /b 1
)
echo.
echo Starting local PostgreSQL...
docker compose up -d db
if errorlevel 1 (
  echo ERROR: Could not start PostgreSQL. Check Docker Desktop.
  pause
  exit /b 1
)
echo.
echo Installing API dependencies...
pushd api
call npm install
if errorlevel 1 goto api_error
if exist "node_modules\.prisma\client\index.js" (
  if exist "node_modules\.prisma\client\query_engine-windows.dll.node" (
    echo Existing Prisma Client found. Skipping regeneration to avoid Windows DLL lock errors.
  ) else (
    call npx prisma generate
    if errorlevel 1 goto api_error
  )
) else (
  call npx prisma generate
  if errorlevel 1 goto api_error
)
call npx prisma validate
if errorlevel 1 goto api_error
call npx prisma db push
if errorlevel 1 goto api_error
popd
echo.
echo Installing web dependencies...
pushd web
call npm install
if errorlevel 1 goto web_error
popd
echo.
echo ==========================================
echo Setup complete!
echo Next: double-click run-erp.bat OR run npm run dev from this folder
echo ==========================================
pause
exit /b 0
:api_error
popd
echo.
echo API setup failed. Read the error above. Do not reset the database.
pause
exit /b 1
:web_error
popd
echo.
echo Web setup failed. Read the error above.
pause
exit /b 1
