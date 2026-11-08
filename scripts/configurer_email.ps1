# Configure l'envoi des e-mails aux agents (identifiants, validation de l'adresse) sur le serveur en ligne,
# avec un « mot de passe d'application » Gmail. Le code est demandé dans une fenêtre Windows et transmis
# directement au serveur (jamais affiché ni enregistré sur ce poste). Un e-mail de test est ensuite envoyé.
#
#   powershell -ExecutionPolicy Bypass -File scripts\configurer_email.ps1
param([string]$serveur = 'ubuntu@167.114.66.246', [string]$adresse = 'mamadouba0228@gmail.com')
if ($env:TEST_CODE) { $code = $env:TEST_CODE } else {
    $c = Get-Credential -UserName $adresse -Message "Collez le mot de passe d'application Gmail (16 lettres, donné par Google)"
    if (-not $c) { Write-Host 'Annulé.'; exit 1 }
    $code = ($c.GetNetworkCredential().Password -replace '\s', '')
    $adresse = $c.UserName.Trim()
}
if ($code -notmatch '^[A-Za-z]{16}$') {
    Write-Host ("Ce n'est pas un mot de passe d'application Gmail : il faut 16 lettres (reçu : {0} caractères)." -f $code.Length) -ForegroundColor Red
    exit 1
}

# Sur le serveur : remplace les lignes SMTP_ du .env, recrée l'API, relance Nginx, envoie un e-mail de test.
$distant = @"
set -e
cd /opt/websig-labe
sudo sed -i '/^SMTP_/d' .env
printf 'SMTP_HOST=smtp.gmail.com\nSMTP_PORT=587\nSMTP_USER=%s\nSMTP_PASSWORD=%s\nSMTP_FROM=%s\n' '$adresse' "`$CODE" '$adresse' | sudo tee -a .env > /dev/null
C='docker compose -f docker-compose.yml -f docker-compose.prod.yml'
sudo `$C up -d api > /dev/null 2>&1
sudo `$C restart web > /dev/null 2>&1
sleep 3
sudo `$C exec -T api python -c "
import main
ok = main.envoyer_mail('$adresse', 'Test — WebSIG de Labé',
    'Ceci est un e-mail de test : l envoi des identifiants aux agents fonctionne.',
    '<p>Ceci est un e-mail de test : l envoi des identifiants aux agents <b>fonctionne</b>.</p>')
print('ENVOI_OK' if ok else 'ENVOI_ECHEC')
" 2>&1 | tail -n 3
"@
Write-Host "Enregistrement sur le serveur et envoi d'un e-mail de test à $adresse..."
$OutputEncoding = New-Object Text.UTF8Encoding $false
# 1re ligne envoyée : le code (lu dans la variable CODE) ; la suite : le script, exécuté ensuite.
$sortie = ($code + "`n" + ($distant -replace "`r", '')) |
    & ssh.exe -o BatchMode=yes $serveur 'IFS= read -r CODE; CODE=$(printf %s "$CODE" | tr -cd A-Za-z); export CODE; T=$(mktemp); tr -d \\r > "$T"; bash "$T"; rm -f "$T"' 2>&1 |
    ForEach-Object { "$_" } | Out-String
Write-Host $sortie
if ($sortie -match 'ENVOI_OK') {
    Write-Host "C'EST PRÊT : un e-mail de test vient d'être envoyé à $adresse (regardez aussi les spams)." -ForegroundColor Green
} elseif ($sortie -match '(?i)Username and Password not accepted|BadCredentials|535') {
    Write-Host "Gmail refuse ce code : vérifiez le mot de passe d'application (et que la validation en 2 étapes est active)." -ForegroundColor Red
} else {
    Write-Host "L'envoi de test n'a pas abouti : envoyez une capture à Claude." -ForegroundColor Red
}
