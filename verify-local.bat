@echo off
setlocal
cd /d "%~dp0"
echo Running Prisma and TypeScript checks...
echo.
pushd api
call npx prisma validate
if errorlevel 1 goto api_error
if not exist "node_modules\.prisma\client\index.js" (
  call npx prisma generate
  if errorlevel 1 goto api_error
) else (
  echo Existing Prisma Client found; skipping generation to avoid Windows DLL lock errors.
)
call npm run build
if errorlevel 1 goto api_error
popd
pushd web
call npm run build
if errorlevel 1 goto web_error
popd
echo.
echo ==========================================
echo All local compile checks passed.
echo ==========================================
pause
exit /b 0
:api_error
popd
echo API validation or build failed. Read the error above.
pause
exit /b 1
:web_error
popd
echo Frontend build failed. Read the error above.
pause
exit /b 1
