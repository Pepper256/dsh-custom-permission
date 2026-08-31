# dsh-custom-permission dev loop: rebuild lib/, restart the permtest GUI,
# and print its URL. Re-run after every source change — no reinstall needed
# (the profile holds a link dependency on this checkout).
#
# Usage:  .\scripts\dev-loop.ps1 [-DshHome C:\path] [-Port 3090]
#
# Defaults: DSH_HOME = %USERPROFILE%\.dsh-dev (isolated test home; the real
# web profile is never touched). Override -DshHome to use another home.

param(
  [string]$DshHome,
  [int]$Port = 3090
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$checkout = Split-Path -Parent $repoRoot
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '.dsh-dev' }
$env:DSH_HOME = $DshHome

# 1. Bridge runtime deps when the checkout sits outside the dsh closure.
if (-not (Test-Path (Join-Path $repoRoot 'node_modules\@deepseek-ai\cordis'))) {
  node (Join-Path $PSScriptRoot 'link-closure-deps.mjs')
}

# 2. Rebuild lib/ with the DSH checkout's tsc.
Write-Host "rebuilding lib/ ..."
Push-Location $checkout
try {
  pnpm exec tsc --build (Join-Path 'dsh-custom-permission' 'tsconfig.build.json')
} finally {
  Pop-Location
}

# 3. Stop any running permtest server (PID file first, then command line).
$pidFile = Join-Path $DshHome 'permtest.pid'
if (Test-Path $pidFile) {
  $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
  }
}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match '--profile permtest' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# 4. Start the GUI detached on the fixed port. `-NoNewWindow` on Windows
# PowerShell 5.1 keeps the parent's pipeline open while the server runs, so
# version 5.1 gets a hidden window instead; pwsh 7 uses the windowless form.
$dshShim = (Get-Command dsh -ErrorAction Stop).Source
$dshBin = Join-Path (Split-Path -Parent $dshShim) 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$logDir = Join-Path $DshHome 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stdout = Join-Path $logDir 'permtest.out.log'
$stderr = Join-Path $logDir 'permtest.err.log'
$startParams = @{
  FilePath = 'node'
  ArgumentList = @($dshBin, '--profile', 'permtest', '--port', $Port, '--no-open')
  RedirectStandardOutput = $stdout
  RedirectStandardError = $stderr
  PassThru = $true
}
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $startParams.NoNewWindow = $true
} else {
  $startParams.WindowStyle = 'Hidden'
}
$proc = Start-Process @startParams
Set-Content -Path $pidFile -Value $proc.Id

# 5. Wait for the web server line, then report.
$url = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 750
  if ($proc.HasExited) { break }
  $line = Select-String -Path $stdout -Pattern 'http://127\.0\.0\.1' -ErrorAction SilentlyContinue | Select-Object -Last 1
  if ($line) { $url = $line.Line.Trim(); break }
}
if (-not $url) {
  Write-Host "no URL line yet; logs at $stdout / $stderr" -ForegroundColor Yellow
  Write-Host "re-run this script to restart, or open http://127.0.0.1:$Port manually"
} else {
  Write-Host "permtest GUI: $url  (pid $($proc.Id), DSH_HOME=$DshHome)" -ForegroundColor Green
  Write-Host 'restart after edits: .\scripts\dev-loop.ps1'
}
