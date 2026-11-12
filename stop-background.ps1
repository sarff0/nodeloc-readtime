$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'nodeloc-readtime.pid'

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host '没有找到后台进程记录。'
  exit 0
}

$savedPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid" -ErrorAction SilentlyContinue
if (-not $process) {
  Write-Host '后台进程已经结束。'
  Remove-Item -LiteralPath $pidFile -Force
  exit 0
}

if ($process.Name -ne 'node.exe' -or $process.CommandLine -notlike '*nodeloc-readtime.mjs*') {
  Write-Host 'PID 记录与脚本不匹配，已拒绝停止。'
  exit 1
}

Stop-Process -Id $savedPid -Force
Remove-Item -LiteralPath $pidFile -Force
Write-Host "已停止后台进程 PID=$savedPid"
