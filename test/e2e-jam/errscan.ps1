# After each test: scan app logs. Main-process errors fail the test, renderer errors are shown as warnings.
param([string]$dir)
$bad = 0
foreach ($f in @("$dir\host.log", "$dir\host.err", "$dir\guest.log", "$dir\guest.err")) {
  if (-not (Test-Path $f)) { continue }
  $name = Split-Path $f -Leaf
  foreach ($l in (Get-Content $f -Encoding UTF8 | Select-String -Pattern '\[JAM-MAIN-ERROR\]|\[JAM-RENDERER-ERROR\]|Uncaught')) {
    if ($l -match 'JAM-MAIN-ERROR|Uncaught') { $bad++; Write-Output "  !! $name : $l" } else { Write-Output "  warn $name : $l" }
  }
}
if ($bad) { Write-Output "  !! $bad main-process error(s) in app logs -> FAIL"; exit 1 }
exit 0
