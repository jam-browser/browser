# Opens the relay port in Windows Firewall (run as Administrator).
#   powershell -ExecutionPolicy Bypass -File open-firewall.ps1 [-Port 3031]
param([int]$Port = 3031)

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "Please run this script as Administrator." -ForegroundColor Yellow; exit 1 }

$name = "Jam Relay (TCP $Port)"
if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) {
  Write-Host "Firewall rule already exists: $name"
} else {
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
  Write-Host "Firewall rule added: $name"
}
