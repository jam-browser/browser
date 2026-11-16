# Registers the relay to start automatically when Windows boots (run as Administrator).
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1 [-Port 3031] [-Pfx C:\certs\relay.pfx -PfxPass secret]
# Runs as the built-in LOCAL SERVICE account (least privilege) and restarts automatically if it stops.
param([int]$Port = 3031, [string]$Pfx = "", [string]$PfxPass = "")

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "Please run this script as Administrator." -ForegroundColor Yellow; exit 1 }

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "Node.js not found. Install Node.js LTS first (winget install OpenJS.NodeJS.LTS)." -ForegroundColor Yellow; exit 1 }
if (-not (Test-Path (Join-Path $dir "node_modules\ws"))) {
  Push-Location $dir; npm install --omit=dev --no-fund --no-audit; Pop-Location
}

# small launcher so environment variables (port, certificate) are set for the task
$launcher = Join-Path $dir "run-relay.cmd"
$lines = @("@echo off", "cd /d `"$dir`"", "set PORT=$Port")
if ($Pfx) { $lines += "set JAM_RELAY_PFX=$Pfx"; if ($PfxPass) { $lines += "set JAM_RELAY_PFX_PASS=$PfxPass" } }
$lines += "`"$node`" jam-relay.js >> relay.log 2>&1"
Set-Content -Path $launcher -Value $lines -Encoding ASCII

$action = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\LOCALSERVICE" -LogonType ServiceAccount
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName "Jam Relay" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

# LOCAL SERVICE needs write access for relay.log
icacls $dir /grant "*S-1-5-19:(OI)(CI)M" | Out-Null

Start-ScheduledTask -TaskName "Jam Relay"
Write-Host "Registered and started scheduled task 'Jam Relay' (port $Port). Log: $dir\relay.log"
