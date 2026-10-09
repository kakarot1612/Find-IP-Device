param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$credentialFile = Join-Path $projectRoot 'config\credentials.json'

function Unprotect-Text {
  param([Parameter(Mandatory = $true)][string]$EncryptedValue)
  $secureValue = ConvertTo-SecureString -String $EncryptedValue
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

if (-not (Test-Path -LiteralPath $credentialFile)) {
  Write-Host 'Chua co credential. Dang mo trinh cau hinh bao mat...' -ForegroundColor Yellow
  & (Join-Path $projectRoot 'setup-credentials.ps1')
}

$credentials = Get-Content -LiteralPath $credentialFile -Raw | ConvertFrom-Json
$env:CISCO_SSH_USERNAME = Unprotect-Text -EncryptedValue $credentials.username
$env:CISCO_SSH_PASSWORD = Unprotect-Text -EncryptedValue $credentials.password
if ($credentials.enablePassword) {
  $env:CISCO_ENABLE_PASSWORD = Unprotect-Text -EncryptedValue $credentials.enablePassword
} else {
  Remove-Item Env:CISCO_ENABLE_PASSWORD -ErrorAction SilentlyContinue
}
if ($credentials.adminUsername) {
  $env:ADMIN_USERNAME = Unprotect-Text -EncryptedValue $credentials.adminUsername
}
if ($credentials.adminPassword) {
  $env:ADMIN_PASSWORD = Unprotect-Text -EncryptedValue $credentials.adminPassword
}

Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath 'node_modules\ssh2\package.json')) {
  Write-Host 'Dang cai dependency SSH lan dau...' -ForegroundColor Cyan
  & npm install
  if ($LASTEXITCODE -ne 0) { throw 'Khong the cai dependency npm.' }
}

$listener = Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  $listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
  $listenerParent = Get-CimInstance Win32_Process -Filter "ProcessId=$($listenerProcess.ParentProcessId)"
  $normalizedCommandLine = ($listenerProcess.CommandLine -replace '/', '\').ToLowerInvariant()
  $normalizedParentCommandLine = ($listenerParent.CommandLine -replace '/', '\').ToLowerInvariant()
  $isTracerServer = (
    $listenerProcess.Name -eq 'node.exe' -and
    $normalizedCommandLine.Contains('src\server.js') -and
    $listenerParent.Name -in @('powershell.exe', 'pwsh.exe') -and
    $normalizedParentCommandLine.Contains('start-app.ps1')
  )
  if (-not $isTracerServer) {
    throw "Cong 3030 dang duoc tien trinh khac su dung: PID $($listener.OwningProcess)."
  }
  Write-Host "Dang khoi dong lai app cu PID $($listener.OwningProcess)..." -ForegroundColor Yellow
  Stop-Process -Id $listener.OwningProcess -Force
  Start-Sleep -Milliseconds 500
}

Write-Host 'Credential da duoc giai ma vao bien moi truong cua tien trinh app.' -ForegroundColor Green
Write-Host 'Dang chay tai http://127.0.0.1:3030' -ForegroundColor Cyan
if (-not $NoBrowser) {
  Start-Process 'http://127.0.0.1:3030'
}
& node 'src/server.js'
