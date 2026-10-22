$ErrorActionPreference = 'Stop'
$failed = $false
Write-Host "Sastha Infinite ERP - Local Connection Check" -ForegroundColor Cyan
Write-Host ""

try {
  $health = Invoke-RestMethod -Uri 'http://localhost:4000/health' -TimeoutSec 5
  if ($health.status -eq 'ok' -and $health.database -eq 'connected') {
    Write-Host "PASS  API and PostgreSQL are responding." -ForegroundColor Green
  } else {
    Write-Host "FAIL  API responded, but its database health check was not successful." -ForegroundColor Red
    $failed = $true
  }
} catch {
  Write-Host "FAIL  API health check failed at http://localhost:4000/health" -ForegroundColor Red
  Write-Host "      Start the API with run-erp.bat and inspect the API error output."
  $failed = $true
}

try {
  $front = Invoke-WebRequest -Uri 'http://localhost:5173' -TimeoutSec 5 -UseBasicParsing
  if ($front.StatusCode -ge 200 -and $front.StatusCode -lt 400) {
    Write-Host "PASS  Frontend is responding at http://localhost:5173." -ForegroundColor Green
  } else {
    Write-Host "FAIL  Frontend returned HTTP $($front.StatusCode)." -ForegroundColor Red
    $failed = $true
  }
} catch {
  Write-Host "FAIL  Frontend is not responding at http://localhost:5173." -ForegroundColor Red
  Write-Host "      Make sure the web terminal started successfully."
  $failed = $true
}

try {
  $cors = Invoke-WebRequest -Uri 'http://localhost:4000/api/auth/register' -Method Options -Headers @{
    Origin = 'http://127.0.0.1:5173'
    'Access-Control-Request-Method' = 'POST'
    'Access-Control-Request-Headers' = 'content-type'
  } -TimeoutSec 5 -UseBasicParsing
  $allowed = $cors.Headers['Access-Control-Allow-Origin']
  if ($allowed -eq 'http://127.0.0.1:5173') {
    Write-Host "PASS  Browser CORS preflight accepts 127.0.0.1:5173." -ForegroundColor Green
  } else {
    Write-Host "WARN  CORS returned '$allowed' for 127.0.0.1:5173." -ForegroundColor Yellow
  }
} catch {
  Write-Host "WARN  CORS preflight could not be verified. Review API terminal output." -ForegroundColor Yellow
}

Write-Host ""
if ($failed) {
  Write-Host "Some checks failed. Copy this report and the API terminal's first error for troubleshooting." -ForegroundColor Red
  exit 1
}
Write-Host "Core local connection checks passed. This does not replace testing every business workflow." -ForegroundColor Green
exit 0
