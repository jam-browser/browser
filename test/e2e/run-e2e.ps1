$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*jam-browser*" } | Stop-Process -Force -Confirm:$false
Start-Sleep -Seconds 2
$sp = $PSScriptRoot
$app = $args[1]
$exe = "$app\node_modules\electron\dist\electron.exe"
# Ports: same env vars as ports.js (default 9301 / 9302)
$hostPort = if ($env:JAM_E2E_HOST_PORT) { $env:JAM_E2E_HOST_PORT } else { 9301 }
$guestPort = if ($env:JAM_E2E_GUEST_PORT) { $env:JAM_E2E_GUEST_PORT } else { 9302 }
# Start from clean profiles so tabs/settings from a previous run do not leak into this one
Remove-Item -Recurse -Force "$sp\ud-host", "$sp\ud-guest" -ErrorAction SilentlyContinue
Start-Process -FilePath $exe -ArgumentList "`"$app`"","--remote-debugging-port=$hostPort","--user-data-dir=`"$sp\ud-host`"" -RedirectStandardOutput "$sp\host.log" -RedirectStandardError "$sp\host.err" | Out-Null
Start-Process -FilePath $exe -ArgumentList "`"$app`"","--remote-debugging-port=$guestPort","--user-data-dir=`"$sp\ud-guest`"" -RedirectStandardOutput "$sp\guest.log" -RedirectStandardError "$sp\guest.err" | Out-Null
$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline) { try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$hostPort/json/list" -TimeoutSec 2 | Out-Null; Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$guestPort/json/list" -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }
if ((Get-Date) -ge $deadline) { Write-Host "Could not reach app debug ports $hostPort/$guestPort. See host.err. If Windows reserves them, set JAM_E2E_HOST_PORT / JAM_E2E_GUEST_PORT." -ForegroundColor Red; exit 2 }
Start-Sleep -Seconds 4
node "$sp\$($args[0])" $app
