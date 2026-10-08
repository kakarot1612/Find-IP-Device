$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configDirectory = Join-Path $projectRoot 'config'
$credentialFile = Join-Path $configDirectory 'credentials.json'

function Protect-Text {
  param([Parameter(Mandatory = $true)][string]$Value)
  $secureValue = ConvertTo-SecureString -String $Value -AsPlainText -Force
  return ConvertFrom-SecureString -SecureString $secureValue
}

Write-Host ''
Write-Host '=== Cisco Camera Port Tracer - Secure Credential Setup ===' -ForegroundColor Cyan
Write-Host 'Credential se duoc ma hoa bang Windows DPAPI cho user Windows hien tai.' -ForegroundColor DarkGray
Write-Host 'Khong dan mat khau vao chat, source code hoac file .env.' -ForegroundColor Yellow
Write-Host ''

$username = Read-Host 'Tai khoan SSH dung chung cho tat ca switch'
if ([string]::IsNullOrWhiteSpace($username)) {
  throw 'Tai khoan SSH khong duoc de trong.'
}

$password = Read-Host 'Mat khau SSH' -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}
if ([string]::IsNullOrEmpty($plainPassword)) {
  throw 'Mat khau SSH khong duoc de trong.'
}

$enablePassword = Read-Host 'Enable password (Enter neu khong dung)' -AsSecureString
$enablePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($enablePassword)
try {
  $plainEnablePassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($enablePointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($enablePointer)
}

New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
$payload = [ordered]@{
  version = 1
  username = Protect-Text -Value $username.Trim()
  password = Protect-Text -Value $plainPassword
  enablePassword = if ([string]::IsNullOrEmpty($plainEnablePassword)) { $null } else { Protect-Text -Value $plainEnablePassword }
  protectedFor = "$env:USERDOMAIN\$env:USERNAME"
  updatedAt = (Get-Date).ToString('o')
}
$payload | ConvertTo-Json | Set-Content -LiteralPath $credentialFile -Encoding utf8

$plainPassword = $null
$plainEnablePassword = $null
Write-Host ''
Write-Host "Da luu credential ma hoa: $credentialFile" -ForegroundColor Green
Write-Host 'Chi Windows user hien tai tren may nay moi giai ma duoc.' -ForegroundColor Green
