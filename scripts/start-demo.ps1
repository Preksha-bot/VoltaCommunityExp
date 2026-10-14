$ErrorActionPreference = 'Stop'
$workspacePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$demoUrl = 'http://127.0.0.1:5173'

function Test-DemoReady {
  try {
    $context = Invoke-RestMethod -Uri "$demoUrl/api/demo-info" -TimeoutSec 2 -ErrorAction Stop
    return $context.environment -eq 'DEMO' -and $context.accounts.Count -eq 29
  } catch { return $false }
}

if (Test-DemoReady) {
  Write-Output "Volta Pulse demo is already running: $demoUrl"
  exit 0
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$tsxPath = Join-Path $workspacePath 'node_modules/tsx/dist/cli.mjs'
$serverPath = Join-Path $workspacePath 'src/server/local.ts'
if (-not (Test-Path -LiteralPath $tsxPath -PathType Leaf)) { throw 'Install dependencies with npm ci before starting the demo.' }

$runtimePath = Join-Path $workspacePath '.pulse-local'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$stdoutPath = Join-Path $runtimePath 'server.stdout.log'
$stderrPath = Join-Path $runtimePath 'server.stderr.log'
$arguments = @('"' + $tsxPath + '"', '"' + $serverPath + '"')
$serverProcess = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $workspacePath -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru

for ($attempt = 0; $attempt -lt 20; $attempt++) {
  if (Test-DemoReady) {
    Set-Content -LiteralPath (Join-Path $runtimePath 'server.pid') -Value $serverProcess.Id -Encoding ascii
    Write-Output "Volta Pulse demo is running in the background: $demoUrl"
    Write-Output "PID: $($serverProcess.Id). Logs: $runtimePath"
    exit 0
  }
  $serverProcess.Refresh()
  if ($serverProcess.HasExited) { throw "The demo exited during startup. Check $stderrPath" }
  Start-Sleep -Milliseconds 250
}
throw "The demo did not become ready. Check $stderrPath"
