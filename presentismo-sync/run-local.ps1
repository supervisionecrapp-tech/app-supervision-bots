# Corre el sync de Presentismo localmente, cargando credenciales desde
# .env.local (no versionado, ver .env.local.example). Se usa en vez de
# GitHub Actions porque controltienda.com le muestra un captcha de
# Cloudflare Turnstile a las IPs de datacenter; con la IP residencial de
# este equipo es mucho menos probable que aparezca (ver la nota en
# src/scrape.mjs).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$envFile = Join-Path $PSScriptRoot ".env.local"
if (-not (Test-Path $envFile)) {
    throw "Falta $envFile - copia .env.local.example y completa las credenciales."
}

Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#=][^=]*)=(.*)$') {
        $name = $matches[1].Trim()
        $value = $matches[2].Trim()
        if ($value) {
            [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
        }
    }
}

foreach ($required in @("FRAX_USER", "FRAX_PASS", "SUPABASE_SERVICE_ROLE_KEY")) {
    if (-not [System.Environment]::GetEnvironmentVariable($required, "Process")) {
        throw "Falta la variable $required en .env.local"
    }
}

npm run sync
exit $LASTEXITCODE
