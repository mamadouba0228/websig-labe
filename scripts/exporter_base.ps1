# Copie complète de la base du poste (données de référence modifiées dans QGIS, saisies, comptes,
# adressage, foncier…) dans telechargements\labe.dump, pour l'installer sur le serveur en ligne.
#
#   powershell -ExecutionPolicy Bypass -File scripts\exporter_base.ps1
#
# Le fichier contient des données personnelles (comptes, titulaires) : ne pas le diffuser.

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$env_ = @{}
Get-Content .env | Where-Object { $_ -match '^\s*([A-Z_]+)=(.*)$' } | ForEach-Object { $env_[$Matches[1]] = $Matches[2] }
New-Item -ItemType Directory -Force telechargements | Out-Null

Write-Host 'Export de la base…' -ForegroundColor Cyan
docker compose exec -T db pg_dump -U $env_['POSTGRES_USER'] -d $env_['POSTGRES_DB'] -Fc -f /tmp/labe.dump
if ($LASTEXITCODE -ne 0) { throw "L'export a échoué. Les services Docker sont-ils démarrés ? (docker compose up -d)" }
docker compose cp db:/tmp/labe.dump telechargements/labe.dump
docker compose exec -T db rm -f /tmp/labe.dump

$f = Get-Item telechargements\labe.dump
Write-Host ("Base exportée : {0} ({1:N1} Mo)" -f $f.FullName, ($f.Length / 1MB)) -ForegroundColor Green
