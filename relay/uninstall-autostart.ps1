# Stops and removes the 'Jam Relay' scheduled task (run as Administrator).
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "Please run this script as Administrator." -ForegroundColor Yellow; exit 1 }
Stop-ScheduledTask -TaskName "Jam Relay" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "Jam Relay" -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*jam-relay.js*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host "Removed scheduled task 'Jam Relay'."
