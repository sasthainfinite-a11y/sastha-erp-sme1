@echo off
setlocal
cd /d "%~dp0"
echo Sastha Infinite ERP - Prisma Repair
 echo.
echo IMPORTANT: Close the ERP API terminal window first.
echo This repairs generated Prisma files only; it does not reset the database.
echo.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\check-running-project.ps1"
if errorlevel 1 (
  echo Close the Sastha ERP API and frontend windows before repairing Prisma.
  pause
  exit /b 1
)
pushd api
if not exist ".env" (
  echo ERROR: api\.env is missing. Run setup-local.bat first.
  popd
  pause
  exit /b 1
)
call npx prisma validate
if errorlevel 1 goto repair_error
if exist "node_modules\.prisma\client" rmdir /s /q "node_modules\.prisma\client"
call npx prisma generate
if errorlevel 1 goto repair_error
call npx prisma db push
if errorlevel 1 goto repair_error
popd
echo.
echo Prisma repair completed. Run run-erp.bat to start the system.
pause
exit /b 0
:repair_error
popd
echo Prisma repair failed. Read the error above. Database data was not reset.
pause
exit /b 1
