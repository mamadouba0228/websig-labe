# Met à jour la carte publique sur GitHub Pages :
#   1. exporte les données publiques depuis PostGIS (référence + saisies validées) vers data/public/
#   2. enregistre les changements dans Git et les envoie sur GitHub
#   3. GitHub reconstruit le site automatiquement (.github/workflows/pages.yml)
#
#   powershell -ExecutionPolicy Bypass -File scripts\publier.ps1

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host 'Export des données publiques depuis la base...' -ForegroundColor Cyan
docker compose --profile outils run --rm export
if ($LASTEXITCODE -ne 0) { throw "L'export a échoué. Les services Docker sont-ils démarrés ? (docker compose up -d)" }

git add data/public
git diff --cached --quiet -- data/public
if ($LASTEXITCODE -eq 0) {
    Write-Host 'Aucun changement depuis la dernière publication.' -ForegroundColor Yellow
    exit 0
}

$date = Get-Date -Format 'yyyy-MM-dd HH:mm'
git commit -m "Mise à jour de la carte publique ($date)" -- data/public
if ($LASTEXITCODE -ne 0) { throw 'Le commit a échoué.' }
git push
if ($LASTEXITCODE -ne 0) { throw "L'envoi vers GitHub a échoué (connexion, droits ?)." }

$url = gh api "repos/{owner}/{repo}/pages" --jq .html_url 2>$null
Write-Host "Publié. Le site sera à jour dans 1 à 2 minutes : $url" -ForegroundColor Green
