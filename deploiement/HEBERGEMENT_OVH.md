# Mettre le WebSIG de Labé en ligne sur un VPS OVH

Ce guide installe **l'application complète** (accueil, carte publique, espace agents, administration, GeoServer pour
QGIS) sur un serveur loué chez OVH, avec une adresse en **https**. Compter environ **1 heure** la première fois.

Ce qu'il faut : une carte bancaire, ce poste Windows avec Docker démarré (pour copier la base), et ce dossier.

---

## 1. Commander le VPS

1. Sur **ovhcloud.com** → *Bare Metal & VPS* → **VPS**.
2. Choisir le **premier modèle ayant au moins 4 Go de mémoire (RAM)** ; 8 Go si le prix est proche
   (GeoServer et la base sont plus à l'aise).
3. Options :
   - **Système** : *Ubuntu 24.04* (sans application préinstallée).
   - **Localisation** : France (Gravelines, Roubaix ou Strasbourg).
   - **Durée** : *sans engagement / mensuel* (on peut résilier à tout moment).
   - **Clé SSH** : facultatif ; sans clé, OVH envoie par e-mail l'utilisateur (`ubuntu`) et le mot de passe.
4. Payer. Sous 10 à 30 minutes, OVH envoie un e-mail avec :
   - l'**adresse IP** du serveur (ex. `51.75.12.34`) ;
   - son **nom** (ex. `vps-1a2b3c4d.vps.ovh.net`) ;
   - l'utilisateur `ubuntu` et le mot de passe.

## 2. (Facultatif) Un nom de domaine

Sans domaine, on utilise le nom fourni par OVH (`vps-….vps.ovh.net`) : ça marche, https compris, mais c'est peu lisible.

Avec un domaine (ex. `sig-labe.org`, environ 10 € par an chez OVH) :

1. Commander le domaine sur ovhcloud.com.
2. Espace client → *Noms de domaine* → le domaine → *Zone DNS* → **Ajouter une entrée** de type **A** :
   sous-domaine vide (ou `www`), cible = **l'adresse IP du VPS**.
3. Attendre que l'entrée soit active (de quelques minutes à quelques heures).

Dans la suite, **`<domaine>`** = votre domaine, ou le nom `vps-….vps.ovh.net`.

## 3. Copier la base du poste (avec vos modifications QGIS)

Sur ce poste, dans le dossier `C:\Users\DELL\Documents\Labe`, Docker démarré :

```powershell
powershell -ExecutionPolicy Bypass -File scripts\exporter_base.ps1
```

Cela crée `telechargements\labe.dump`, une copie complète de la base : bâti modifié dans QGIS, adressage, foncier,
saisies, **comptes** (vous gardez votre e-mail et votre mot de passe). Ce fichier contient des données personnelles :
ne pas le diffuser.

Envoyer ce fichier et le script d'installation sur le serveur (PowerShell, remplacer l'IP) :

```powershell
scp telechargements\labe.dump scripts\serveur\installer.sh ubuntu@51.75.12.34:~/
```

Au premier envoi, répondre `yes`, puis saisir le mot de passe reçu d'OVH.

## 4. Installer

Se connecter au serveur :

```powershell
ssh ubuntu@51.75.12.34
```

(À la première connexion, OVH peut demander de changer le mot de passe : en choisir un solide et le noter.)

Puis lancer l'installation (remplacer le domaine) :

```bash
sudo bash installer.sh <domaine> mamadouba0228@gmail.com ~/labe.dump
```

Le script fait tout, en 5 à 15 minutes :

- mises à jour d'Ubuntu, pare-feu (seuls SSH, HTTP et HTTPS ouverts), protection contre les tentatives de connexion ;
- installation de Docker ;
- récupération du projet depuis GitHub dans `/opt/websig-labe` ;
- fichier `.env` avec des **mots de passe neufs** (différents de ceux du poste) ;
- restauration de votre base ;
- démarrage de tous les services, avec **certificat https automatique** (Let's Encrypt, renouvelé tout seul) ;
- **sauvegarde de la base chaque nuit** à 2 h 30 (14 jours gardés, dans `/opt/sauvegardes-labe`).

À la fin, il affiche les adresses :

| Page | Adresse |
|---|---|
| Accueil | `https://<domaine>/` |
| Carte publique | `https://<domaine>/carte.html` |
| Espace agents | `https://<domaine>/espace.html` |
| Administration | `https://<domaine>/admin.html` |

Une fois l'installation vérifiée, supprimer la copie de la base du dossier personnel : `rm ~/labe.dump`.

## 5. Relier la démo GitHub au vrai espace agents

Pour que les boutons « Espace agents » et « Administration » de la démo GitHub deviennent actifs : sur GitHub, dépôt
`websig-labe` → *Settings* → *Secrets and variables* → *Actions* → onglet *Variables* → **New repository variable** :
nom `ESPACE_URL`, valeur `https://<domaine>/espace.html`. La démo est mise à jour à la prochaine publication.

On peut aussi présenter directement `https://<domaine>/` : c'est la version complète.

## 6. Utilisation courante

Toutes les commandes se lancent sur le serveur, après `ssh ubuntu@<IP>`.

| Besoin | Commande |
|---|---|
| Mettre à jour l'application (après des changements envoyés sur GitHub) | `sudo /opt/websig-labe/scripts/serveur/mettre_a_jour.sh` |
| Faire une sauvegarde tout de suite | `sudo /opt/websig-labe/scripts/serveur/sauvegarder.sh` |
| Voir l'état des services | `cd /opt/websig-labe && sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml ps` |
| Voir les mots de passe du serveur | `sudo cat /opt/websig-labe/.env` |
| Redémarrer le serveur | `sudo reboot` (l'application redémarre seule) |

Récupérer une sauvegarde sur le poste (PowerShell) :

```powershell
scp ubuntu@51.75.12.34:/opt/sauvegardes-labe/labe-2026-11-05.dump .
```

(Les sauvegardes sont lisibles par `root` : si `scp` refuse, copier d'abord le fichier sur le serveur avec
`sudo cp /opt/sauvegardes-labe/<fichier> ~ && sudo chown ubuntu ~/<fichier>`.)

## 7. QGIS et administration de GeoServer

- **Flux publics WMS / WFS** (ouverts à tous, en https) : dans QGIS, nouvelle connexion WMS ou WFS avec l'adresse
  `https://<domaine>/geoserver/labe/ows`.
- **Base PostGIS et administration de GeoServer** : volontairement **fermées sur internet**. On y accède par un
  « tunnel » SSH. Sur le poste, dans PowerShell, laisser ouverte la fenêtre :

  ```powershell
  ssh -L 5433:localhost:5433 -L 8081:localhost:8080 ubuntu@51.75.12.34
  ```

  Pendant que cette fenêtre est ouverte :
  - QGIS → connexion PostGIS : hôte `localhost`, port `5433`, base `labe`, utilisateur et mot de passe
    `POSTGRES_USER` / `POSTGRES_PASSWORD` du `.env` du **serveur** ;
  - administration de GeoServer : `http://localhost:8081/geoserver/web/` (identifiants `GEOSERVER_ADMIN_*` du `.env`
    du serveur).

  Attention : la base du poste utilise aussi le port 5433. Arrêter Docker sur le poste pendant le tunnel, ou remplacer
  `5433:localhost:5433` par `5434:localhost:5433` et utiliser le port `5434` dans QGIS.

## 8. Arrêter l'hébergement

1. Faire une dernière sauvegarde et la récupérer sur le poste (section 6).
2. Espace client OVH → le VPS → **Résilier**. Le serveur et ses données sont effacés à la fin du mois payé.

## En cas de problème

| Symptôme | À vérifier |
|---|---|
| Le site ne répond pas en https | Le domaine pointe-t-il vers l'IP du VPS ? (`ping <domaine>`). Journal : `sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml logs caddy` (dans `/opt/websig-labe`) |
| « Impossible de charger les couches » | GeoServer démarre lentement (1 à 2 minutes) ; sinon `… logs geoserver` |
| Mot de passe administrateur de l'application oublié | Avec la base du poste, ce sont les identifiants du poste. Sinon : `sudo cat /opt/websig-labe/.env` (`APP_ADMIN_*`, valable si la base n'avait aucun administrateur) |
| Serveur lent | Mémoire insuffisante : passer au modèle supérieur depuis l'espace client OVH (sans réinstaller) |
