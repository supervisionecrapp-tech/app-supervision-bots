# Corrida especial de las 07:00 - carga el dia ANTERIOR completo, igual
# que la corrida de las 11:00 UTC en el workflow de GitHub Actions (ver
# .github/workflows/presentismo-sync.yml).
$ErrorActionPreference = "Stop"
$env:FECHA = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd")
& (Join-Path $PSScriptRoot "run-local.ps1")
exit $LASTEXITCODE
