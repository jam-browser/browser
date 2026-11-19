# Jam E2E runner: two app instances (off-screen, CDP), local test site, optional local relay, log error scan.
#
#   powershell -ExecutionPolicy Bypass -File test\e2e-jam\run.ps1                 # all tests
#   powershell -ExecutionPolicy Bypass -File test\e2e-jam\run.ps1 -Tests ping,files
#   ... -Packaged        # use dist\win-unpacked\Jam Browser.exe (run `npx electron-builder --win --dir` first)
#   ... -Relay <path to jam-relay.js>   # default: ..\jam-backend-build\jam-relay.js next to this repo, or $env:JAM_E2E_RELAY
param(
  [string[]]$Tests = @('nearby', 'vault', 'mirror', 'mirror-security', 'mirror-aspect', 'files', 'settings', 'ping', 'ping-wheel', 'relay-cap', 'siteguard', 'resume', 'smoke'),
  [switch]$Packaged,
  [string]$Relay = $env:JAM_E2E_RELAY
)
$ErrorActionPreference = 'Continue'
# -File 로 실행하면 "a,b" 가 문자열 하나로 들어오므로 쉼표로 나눔
$Tests = @($Tests | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$here = $PSScriptRoot
$app = (Resolve-Path "$here\..\..").Path
$P = @{ host = $(if ($env:JAM_E2E_HOST_PORT) { $env:JAM_E2E_HOST_PORT } else { 9301 }); guest = $(if ($env:JAM_E2E_GUEST_PORT) { $env:JAM_E2E_GUEST_PORT } else { 9302 }) }
if (-not $Relay) { $cand = Join-Path (Split-Path $app -Parent) 'jam-backend-build\jam-relay.js'; if (Test-Path $cand) { $Relay = $cand } }
# tests that go through a local relay, and the relay's per-guest limit for each
$viaRelay = @{ resume = 0; 'nearby' = 0; 'mirror' = 0; 'files' = 0; 'relay-cap' = 0.5 }
$exe = if ($Packaged) { "$app\dist\win-unpacked\Jam Browser.exe" } else { "$app\node_modules\electron\dist\electron.exe" }
if (-not (Test-Path $exe)) { Write-Host "App not found: $exe" -ForegroundColor Red; exit 2 }
New-Item -ItemType Directory -Force "$here\out" | Out-Null
node "$here\make-fixtures.js" | Out-Null

function Stop-Apps { Get-Process electron, 'Jam Browser' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$app*" } | Stop-Process -Force -Confirm:$false }
function Wait-Http($url, $sec) { $end = (Get-Date).AddSeconds($sec); while ((Get-Date) -lt $end) { try { Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 2 | Out-Null; return $true } catch { Start-Sleep -Milliseconds 400 } }; return $false }

# local test site (127.0.0.1:8766)
$site = Start-Process -FilePath node -ArgumentList "`"$here\jam-site.js`"" -PassThru -WindowStyle Hidden -RedirectStandardOutput "$here\out\site.log" -RedirectStandardError "$here\out\site.err"
if (-not (Wait-Http 'http://127.0.0.1:8766/' 10)) { Write-Host 'Test site did not start (port 8766 busy?)' -ForegroundColor Red; Stop-Process -Id $site.Id -Force; exit 2 }

$results = @()
foreach ($t in $Tests) {
  $script = "$here\$t.e2e.js"
  if (-not (Test-Path $script)) { Write-Host "no such test: $t" -ForegroundColor Yellow; continue }
  Write-Host "== $t" -ForegroundColor Cyan
  Stop-Apps; Start-Sleep -Seconds 2
  foreach ($d in @("$here\ud-host", "$here\ud-guest")) { if (Test-Path $d) { Remove-Item -Recurse -Force $d -Confirm:$false } }
  $relayProc = $null; $relayPort = ''
  if ($viaRelay.ContainsKey($t)) {
    if (-not $Relay) { Write-Host "  skipped: needs a relay (set -Relay or JAM_E2E_RELAY)" -ForegroundColor Yellow; $results += "$t SKIPPED"; continue }
    $relayPort = '43131'
    $env:PORT = $relayPort
    if ($viaRelay[$t] -gt 0) { $env:JAM_RELAY_GUEST_MBPS = "$($viaRelay[$t])" }
    $relayProc = Start-Process -FilePath node -ArgumentList "`"$Relay`"" -PassThru -WindowStyle Hidden -RedirectStandardOutput "$here\out\relay.log" -RedirectStandardError "$here\out\relay.err"
    Remove-Item Env:PORT -ErrorAction SilentlyContinue; Remove-Item Env:JAM_RELAY_GUEST_MBPS -ErrorAction SilentlyContinue
    if (-not (Wait-Http "http://127.0.0.1:$relayPort/version" 10)) { Write-Host '  relay did not start' -ForegroundColor Red }
  }
  $env:JAM_TEST_OFFSCREEN = '1'
  $env:JAM_TEST_BLOCKLIST = "$here\fixtures\blocklist.txt"  # 추적기 차단: 인터넷 목록 대신 테스트 목록
  $env:JAM_TEST_DIALOG_FILE = "$here\out\account-backup.jvault"  # 계정 백업 · 불러오기: 파일 창 대신 이 경로
  $flags = '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'
  # 인자는 꼭 배열로 (원소 하나짜리 배열은 PowerShell 이 문자열로 풀어서, 앱 경로와 다음 인자가 한 덩어리로 붙어 버림)
  [string[]]$pre = @()
  if (-not $Packaged) { $pre += "`"$app`"" }
  [string[]]$hostArgs = $pre + @("--remote-debugging-port=$($P.host)", "--user-data-dir=`"$here\ud-host`"") + $flags
  [string[]]$guestArgs = $pre + @("--remote-debugging-port=$($P.guest)", "--user-data-dir=`"$here\ud-guest`"") + $flags
  Start-Process -FilePath $exe -ArgumentList $hostArgs -RedirectStandardOutput "$here\host.log" -RedirectStandardError "$here\host.err" | Out-Null
  Start-Process -FilePath $exe -ArgumentList $guestArgs -RedirectStandardOutput "$here\guest.log" -RedirectStandardError "$here\guest.err" | Out-Null
  Remove-Item Env:JAM_TEST_OFFSCREEN -ErrorAction SilentlyContinue; Remove-Item Env:JAM_TEST_BLOCKLIST -ErrorAction SilentlyContinue
  if (-not ((Wait-Http "http://127.0.0.1:$($P.host)/json/list" 40) -and (Wait-Http "http://127.0.0.1:$($P.guest)/json/list" 40))) { Write-Host '  apps did not open their debug ports' -ForegroundColor Red; $results += "$t FAILED (start)"; Stop-Apps; continue }
  Start-Sleep -Seconds 3
  node $script $app $relayPort
  $code = $LASTEXITCODE
  Start-Sleep -Milliseconds 500
  & "$here\errscan.ps1" $here
  if ($LASTEXITCODE -ne 0) { $code = 1 }
  Stop-Apps
  if ($relayProc) { Stop-Process -Id $relayProc.Id -Force -ErrorAction SilentlyContinue }
  $results += $(if ($code -eq 0) { "$t OK" } else { "$t FAILED" })
}
Stop-Process -Id $site.Id -Force -ErrorAction SilentlyContinue
Write-Host "`n== results" -ForegroundColor Cyan
$results | ForEach-Object { Write-Host "  $_" }
if ($results -match 'FAILED') { exit 1 }
exit 0
