# WebSIG — Commune urbaine de Labé

Système d'information géographique web de la commune urbaine de Labé (Guinée) :

- **Carte publique** : consultation libre, sans compte, en lecture seule (limites, 28 quartiers,
  voirie, bâti, hydrographie, équipements, données validées par la mairie).
- **Espace agents** : les agents des services communaux créent leur compte, puis saisissent des données
  (points, lignes, surfaces, photos, import GeoJSON).
- **Administration** : activation des comptes, rôles, validation des saisies, tableau de bord, journal d'activité.

## Rôles

| Rôle | Droits |
|---|---|
| Public (sans compte) | Consulter la carte publique |
| Agent | Saisir des données ; modifier ou supprimer ses saisies tant qu'elles ne sont pas validées |
| Superviseur | + valider, rejeter (avec motif), modifier toutes les saisies ; tableau de bord |
| Administrateur | + activer / désactiver les comptes, attribuer les rôles, réinitialiser les mots de passe, journal |

Un agent s'inscrit depuis l'espace agents ; son compte reste **en attente** jusqu'à son activation par
un administrateur. Les saisies d'un agent sont publiées sur la carte publique **après validation**.

## Adressage

Numérotation **métrique** : le numéro d'un bâtiment est sa distance en mètres depuis le début de la voie,
**pair à droite**, **impair à gauche** (ex. « 124, Rue DK1-012 » est à environ 124 m du début de la rue).
Une construction nouvelle reçoit son numéro sans renuméroter les voisins.

- **Voies** : créées depuis la voirie OSM (onglet « Adressage » de l'espace agents → « Initialiser », une seule fois).
  Chaque voie a un **code** permanent par quartier (`DK1-012` = Daka 1, voie 12) et peut recevoir un **nom officiel**
  après délibération du conseil municipal (« Avenue Karamoko Alfa (DK1-012) »). Le début d'une voie est l'extrémité
  la plus proche du centre-ville (pastille noire) ; un superviseur peut l'inverser tant qu'aucune adresse n'est validée.
- **Adresses** : chaque bâtiment à moins de 50 m d'une voie reçoit une adresse **proposée** ; un superviseur la **valide**
  après vérification, l'agent de terrain indique **plaque posée**. Une adresse validée ne change plus jamais.
- **Outils** : « Adresse d'un point », ajout d'une adresse, tracé d'une nouvelle voie, renumérotation / validation par voie
  ou par quartier, exports CSV pour Excel (adresses pour la fabrication des plaques, registre des voies).
- **Carte publique** : voies, adresses validées, recherche d'adresse et outil ⌖ « Quelle est l'adresse de ce point ? ».

Tables : `adr.voies`, `adr.adresses`, `adr.quartiers` (codes des quartiers), `adr.parametres` (distance de rattachement).
GeoServer : `labe:voies_publiques`, `labe:adresses_publiques`.

## Identification des entités (bouton ⓘ)

Comme l'outil « Identifier les entités » de QGIS : cliquer sur **ⓘ** (barre d'outils à droite, sous le zoom),
puis sur la carte. Toutes les couches visibles sont interrogées autour du point (tolérance de 8 pixels) :
voirie, voies et adresses de l'adressage, cours d'eau, espaces verts, équipements, données de la mairie,
saisies des agents, bâti et quartiers. Le panneau liste les entités trouvées par couche, avec **tous leurs
attributs** et les mesures calculées (longueur, surface) ; un clic sur une entité la met en évidence,
« Zoomer sur l'entité » la cadre. Le mode reste actif jusqu'à un nouveau clic sur ⓘ ou la touche Échap.

Hors de ce mode, un clic simple ouvre la fiche de l'objet le plus précis (point, puis ligne — avec une
tolérance de 6 pixels —, puis bâtiment, puis quartier).

## Itinéraires

Onglet « Itinéraire » de la carte publique et de l'espace agents (calcul dans le navigateur, fonctionne aussi sur GitHub Pages) :

- plus court chemin **à pied** (4,5 km/h, sentiers compris) ou **en véhicule** (12 à 45 km/h selon le type de voie, sans les sentiers) ;
- **instructions pas à pas** avec les noms et codes des voies de l'adressage (« Tournez à gauche sur Rue KRL-005 ») ;
- **tournée** jusqu'à 12 étapes avec optimisation de l'ordre (plus proche voisin + 2-opt) et retour au départ en option :
  ramassage des ordures, pose des plaques d'adresse, visites de terrain ;
- étapes ajoutées par la recherche, « Point sur la carte », « Ma position » ou **clic droit** sur la carte (appui long sur téléphone) ;
  marqueurs déplaçables ; **export GPX** pour suivre le trajet sur téléphone (OsmAnd, Organic Maps…) ou GPS.

Limites : les sens uniques et la circulation ne sont pas pris en compte (données OSM sans sens de circulation).

## Sélection des données

Onglet « Sélection » de la carte publique et de l'espace agents (calcul dans le navigateur, fonctionne aussi sur GitHub Pages) :

- **couches** : bâtiments, voirie, voies et adresses de l'adressage, équipements, quartiers, cours d'eau ;
  champs calculés : surface au sol, longueur, quartier, densité ;
- **conditions attributaires** combinées en **ET** / **OU** : « est parmi » (valeurs à cocher, avec effectifs),
  contient, =, ≠, commence par, vide, >, ≥, <, ≤, entre ;
- **sélection spatiale** : zone dessinée, cercle d'un rayon donné, **proximité** d'une autre couche
  (ex. bâtiments à moins de 30 m d'un cours d'eau, d'une route nationale…) ;
- **résultats** : mise en évidence sur la carte, total (nombre, longueur, surface), **répartition** par champ,
  tableau triable (clic sur une ligne = zoom), exports **CSV** (Excel) et **GeoJSON** (QGIS).

Exemples : bâtiments en construction de Daka 1 · bâtiments de plus de 300 m² · voies sans nom de Madina ·
adresses d'un quartier pour une tournée · bâtiments en zone inondable (proximité des cours d'eau).

## Analyses : isochrones et tampons

Onglet « Analyses » de la carte publique et de l'espace agents (calcul dans le navigateur, fonctionne aussi sur GitHub Pages).

- **Isochrones** : zones atteignables en X minutes (ex. 5, 10, 15) **par le réseau de rues**, à pied ou en véhicule,
  depuis des points choisis, **tous les équipements d'une catégorie** (ex. Santé → carte d'accessibilité aux soins)
  ou les objets de la sélection en cours. Tient compte d'une marche de 100 m maximum entre la rue et le bâtiment.
- **Tampons** : zones à moins de X m (un ou plusieurs anneaux, ex. 50, 100, 200) autour d'une couche
  (éventuellement filtrée, ex. routes nationales), de la sélection en cours, ou d'un point / ligne / surface dessiné.
- **Résultats** : surface de chaque zone, nombre et part des bâtiments (et des adresses) concernés,
  **bâtiments non desservis** ; bouton « Voir » pour les lister dans le tableau de sélection (tri, export CSV) ;
  export des zones en **GeoJSON** pour QGIS.

Méthode : champ de temps (Dijkstra multi-sources) ou de distance calculé sur une grille fine (20 m pour les isochrones,
≈ distance/10 pour les tampons), contours tracés avec d3-contour. Les bâtiments sont comptés par leur point central.

## Hébergement

| Partie | Où | Adresse |
|---|---|---|
| Carte publique (copie statique) | GitHub Pages | `https://<compte>.github.io/<dépôt>/` |
| Carte publique, espace agents, administration | Docker (poste ou serveur de la mairie) | http://localhost:8080 |

GitHub Pages ne sert que des fichiers statiques : la carte publique y lit des fichiers GeoJSON exportés
de la base (`data/public/`). L'espace agents et l'administration ont besoin de la base de données et
tournent donc avec Docker.

### Mettre à jour la carte publique sur GitHub

```powershell
powershell -ExecutionPolicy Bypass -File scripts\publier.ps1
```

Le script exporte les données publiques (référence + saisies validées, sans comptes ni photos),
les enregistre dans le dépôt et GitHub reconstruit le site (workflow `.github/workflows/pages.yml`).

Quand l'espace agents sera accessible en ligne, définir sa page dans la variable de dépôt `ESPACE_URL`
(GitHub → Settings → Secrets and variables → Actions → Variables), par exemple
`https://sig.mairie-labe.gn/espace.html` : le lien « Espace agents » apparaîtra sur la carte publique.

## Architecture Docker

| Service | Rôle | Accès |
|---|---|---|
| `db` | PostgreSQL 16 + PostGIS | `localhost:5433` (QGIS, pgAdmin) |
| `import` | Charge `data/*.geojson` dans le schéma `ref` (premier démarrage) | — |
| `geoserver` | WMS / WFS des couches | http://localhost:8080/geoserver |
| `geoserver-init` | Configure GeoServer (espace `labe`, couches, styles SLD) | — |
| `api` | API : comptes, saisies, administration (FastAPI) | http://localhost:8080/api/docs |
| `web` | Nginx : pages web + proxy | http://localhost:8080 |
| `export` | Export des données publiques pour GitHub Pages (à la demande) | — |

## Installation

1. Installer Docker Desktop.
2. Copier `.env.example` en `.env` et remplacer chaque `changez-moi` par un mot de passe robuste.
   `APP_ADMIN_EMAIL` / `APP_ADMIN_PASSWORD` définissent le premier compte administrateur.
3. Lancer :

```powershell
docker compose up -d            # démarrer (premier lancement : quelques minutes)
docker compose ps               # état des services
docker compose logs -f api      # journaux d'un service
docker compose down             # arrêter (les données sont conservées)
```

Pages : `/` carte publique · `/espace.html` espace agents · `/admin.html` administration.

Sauvegarder la base :

```powershell
docker compose exec db pg_dump -U labe -Fc labe > sauvegarde_labe.dump
```

Réimporter les données de référence (écrase le schéma `ref`) :

```powershell
$env:FORCE_IMPORT=1; docker compose run --rm import; Remove-Item Env:FORCE_IMPORT
docker compose run --rm geoserver-init
```

## Données

- `ref.*` : données de référence (OSM2IGEO mars 2023, limites OSM), découpées sur la commune.
- `contrib.contributions` : saisies des agents. Statuts `À valider` → `Validé` / `Rejeté` (`Traité` pour les signalements).
  Le quartier est renseigné automatiquement (déclencheur PostGIS).
- `app.utilisateurs`, `app.sessions`, `app.journal` : comptes (mots de passe hachés PBKDF2), sessions, journal.
- Vues GeoServer (saisies validées, sans données personnelles) :
  `labe:contributions_points`, `labe:contributions_lignes`, `labe:contributions_surfaces`.

## Sécurité

- Le fichier `.env` (mots de passe) n'est jamais versionné.
- Avant une mise en ligne sur Internet : HTTPS obligatoire devant Nginx (les mots de passe circulent
  dans les requêtes), et changer le mot de passe administrateur de GeoServer.

## Sources et licences

- © contributeurs OpenStreetMap, licence ODbL (via OSM2IGEO Guinée, mars 2023).
- Fonds de carte : OpenStreetMap, Esri World Imagery, OpenTopoMap, CARTO.
