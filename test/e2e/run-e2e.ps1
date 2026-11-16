$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*jam-browser*" } | Stop-Process -Force -Confirm:$false
Start-Sleep -Seconds 2
$sp = $PSScriptRoot
$app = $args[1]
$exe = "$app\node_modules\electron\dist\electron.exe"
Start-Process -FilePath $exe -ArgumentList "`"$app`"","--remote-debugging-port=9301","--user-data-dir=`"$sp\ud-host`"" -RedirectStandardOutput "$sp\host.log" -RedirectStandardError "$sp\host.err" | Out-Null
Start-Process -FilePath $exe -ArgumentList "`"$app`"","--remote-debugging-port=9302","--user-data-dir=`"$sp\ud-guest`"" -RedirectStandardOutput "$sp\guest.log" -RedirectStandardError "$sp\guest.err" | Out-Null
$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline) { try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9301/json/list -TimeoutSec 2 | Out-Null; Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9302/json/list -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }
Start-Sleep -Seconds 4
node "$sp\$($args[0])" $app
