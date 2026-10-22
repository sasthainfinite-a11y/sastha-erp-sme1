$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
try {
  $running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($projectRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  }
} catch {
  Write-Host "WARNING: Could not check for active ERP Node.js processes: $($_.Exception.Message)" -ForegroundColor Yellow
  exit 0
}
if ($running) {
  Write-Host "An ERP Node.js process appears to be running from:" -ForegroundColor Yellow
  Write-Host $projectRoot
  Write-Host "Close this project's API and frontend terminal windows, then rerun the setup/repair script."
  Write-Host "No processes were stopped and your database was not changed."
  exit 1
}
exit 0
