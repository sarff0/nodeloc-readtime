param(
  [string]$CookieFile = (Join-Path $PSScriptRoot 'cookies.json'),
  [int]$TargetMinutes = 600
)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'nodeloc-readtime.mjs'
$log = Join-Path $PSScriptRoot 'nodeloc-readtime.log'
$state = Join-Path $PSScriptRoot 'nodeloc-readtime-state.json'

if (-not (Test-Path -LiteralPath $CookieFile)) {
  Write-Host "未找到 Cookie 文件：$CookieFile" -ForegroundColor Yellow
  Write-Host "请用 Cookie-Editor 导出 cookies.json 到本目录，或修改 -CookieFile 参数。" -ForegroundColor Yellow
  exit 1
}

$nodeArgs = @(
  $script,
  '--cookie-file', $CookieFile,
  '--target', $TargetMinutes,
  '--log', $log,
  '--state', $state
)

$process = Start-Process -FilePath $node -ArgumentList $nodeArgs -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'nodeloc-readtime.out.log') -RedirectStandardError (Join-Path $PSScriptRoot 'nodeloc-readtime.err.log')
Set-Content -LiteralPath (Join-Path $PSScriptRoot 'nodeloc-readtime.pid') -Value $process.Id -Encoding ascii
Write-Host "已在后台启动，PID=$($process.Id)"
Write-Host "日志：$log"
Write-Host "状态：$state"
