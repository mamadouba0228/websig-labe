# WebSIG — Commune urbaine de Labé

Système d'information géographique web de la commune urbaine de Labé (Guinée) :

- **Carte publique** : consultation libre, sans compte, en lecture seule (limites, 28 quartiers,
  voirie, bâti, hydrographie, équipements, données validées par la mairie).
- **Espace agents** : les agents des services communaux, avec un compte créé par l'administrateur,
  saisissent des données (points, lignes, surfaces, photos, import GeoJSON).
- **Administration** : création et activation des comptes, rôles, validation des saisies, tableau de bord, journal d'activité.

## Rôles

| Rôle | Droits |
|---|---|
| Public (sans compte) | Consulter la carte publique et utiliser ses outils ; pas de création de compte |
| Agent | Saisir des données ; modifier ou supprimer ses saisies tant qu'elles ne sont pas validées |
| Superviseur | + valider, rejeter (avec motif), modifier toutes les saisies ; tableau de bord |
| Administrateur | + créer, activer / désactiver les comptes, attribuer les rôles et les services, réinitialiser les mots de passe, journal |

**Pas d'inscription libre** : seul un **administrateur** crée les comptes des agents (Administration → Comptes des
agents → **+ Nouveau compte**). Le compte est actif tout de suite, avec un mot de passe temporaire à transmettre à
l'agent, qui le change dans « Mon compte ». L'écran de connexion n'a plus de formulaire « Créer un compte » et l'API
n'a plus de route d'inscription.
Les saisies d'un agent sont publiées sur la carte publique **après validation**.

**Accès par service.** Tous les agents ont accès aux **outils** (saisie, suivi, itinéraire, sélection, analyses,
statistiques, mon compte). Les **services communaux** (Adressage, Foncier, Déchets, Environnement, Réseaux,
Marchés et gares routières) se donnent **compte par compte** : cases à cocher à la création du compte (proposées
d'office selon le service de l'agent) et bouton **Services** dans la liste des comptes. Un agent ne voit que les onglets de ses services ; l'API refuse les
autres (403). Les couches publiques des autres services restent visibles sur la carte. Superviseurs et
administrateurs voient tous les services. Dans un service, certaines actions restent réservées au service
compétent (ex. encaissements : Finances et recettes ; instruction foncière : Urbanisme et domaines).

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
- **Pose des plaques** : « 📍 Plaques à poser près de moi » liste les adresses validées sans plaque les plus proches
  (position GPS), numérotées sur la carte ; « ✓ Posée » enregistre la date et l'agent. Avancement par quartier
  (validées, posées) et suivi de la campagne (plaques par jour et par agent).
- **Certificat d'adresse** (`certificat.html?voie=KRL-026&num=47`) : page A4 imprimable ou enregistrable en PDF
  (en-tête de la commune, adresse, coordonnées GPS, carte de situation, QR code de vérification, signature du Maire).
  Délivré seulement pour une adresse **validée** ; sur la démo GitHub, document « spécimen ».

Tables : `adr.voies`, `adr.adresses`, `adr.quartiers` (codes des quartiers), `adr.parametres` (distance de rattachement).
GeoServer : `labe:voies_publiques`, `labe:adresses_publiques`.

## Travail sur le terrain (téléphone, hors connexion)

- **Application installable** : sur téléphone, « Ajouter à l'écran d'accueil » (manifeste + service worker `sw.js`,
  nécessite HTTPS en production). Pages, données consultées et fonds de carte déjà vus restent disponibles sans réseau.
- **Saisie hors connexion** : sans réseau, la saisie (avec sa photo) est gardée dans le téléphone (IndexedDB) et envoyée
  automatiquement au retour de la connexion ; un identifiant unique évite les doublons si l'envoi est répété.
- **GPS** : « Point à ma position » (précision affichée, attente d'une bonne précision), « Ligne / Surface en marchant »
  (un sommet tous les 5 m).

## Modification des formes et corrections de la carte

- **Outil ✎** (barre d'outils, sous ⓘ) : cliquer l'outil puis l'objet — saisie modifiable, bâtiment ou rue.
- **Forme d'une saisie** : outil ✎ ou « ✎ Forme » dans sa fiche — déplacer, ajouter (« + ») ou supprimer des sommets.
  L'ancienne forme est gardée dans l'**historique** ; un superviseur peut la restaurer.
- **Carte de référence** (bâti, voirie OSM) : outil ⓘ, cliquer l'objet, « Proposer une correction » → redessiner,
  ou signaler un bâtiment démoli / une voie disparue ; « + Bâtiment manquant », « + Voie manquante » dans l'onglet Saisie.
  La correction est appliquée à `ref.batiments` / `ref.routes` **seulement quand un superviseur la valide** ;
  l'ancienne forme reste dans l'historique de la correction.

## Suivi des signalements

Circuit : **À valider** → **Validé** → **Affecté** à un service (priorité, échéance, consigne) → **En cours**
(pris en charge par un agent du service) → **Traité** (compte rendu et photo après intervention) ; ou **Rejeté** (motif).
Seul le service chargé (ou un superviseur) peut prendre en charge et traiter ; tout le monde peut commenter.

Onglet « Suivi » de l'espace agents : chiffres clés (nouveaux, à prendre en charge, en retard, délai moyen de traitement),
liste triée (retards et priorités d'abord), fiche avec historique complet et photos, indicateurs par service,
**points chauds** (signalements par maille de 250 m et par quartier). Tables : `contrib.contributions`
(colonnes `service_affecte`, `priorite`, `echeance`, `traite_le`…), `contrib.historique`.

## Foncier

Onglet « Foncier » de l'espace agents. Le registre communal sert au **recensement et au suivi** des terrains :
il ne remplace pas le titre foncier délivré par les services de l'État (Conservation foncière).

- **Registre des parcelles** : « ⬠ Recenser une parcelle » (dessin), « 🚶 En marchant (GPS) » ou import d'un levé
  (GeoJSON en WGS84, jusqu'à 500 parcelles). Numéro unique `LAB-<code du quartier>-00001`, superficie et périmètre
  calculés en UTM 28N, usage, statut juridique (titre foncier, permis d'habiter, attestation de cession, acte coutumier,
  domaine public, réserve communale, non documenté), référence de l'acte, lotissement et lot, origine et précision des limites.
  Une parcelle est **provisoire** jusqu'à sa validation par un superviseur (**enregistrée**) ; elle est **archivée**
  après un morcellement ou une fusion. Chaque changement (attributs, limites) est gardé dans l'historique.
- **Dossiers fonciers** : attribution, régularisation, morcellement (découpage par une ou plusieurs lignes), fusion,
  mutation (vente, succession, donation), bornage, changement d'usage. Circuit : **Déposé** → **En instruction**
  (service Urbanisme et domaines) → **Visite effectuée** (compte rendu, limites relevées) → **Avis favorable / défavorable**
  → **Approuvé** (superviseur, référence de la décision) ou **Rejeté**. La décision approuvée est appliquée au registre.
- **Contrôles** (`fon.controler`) au dessin, à la validation et à la décision : chevauchement avec une autre parcelle
  (bloquant au-delà de 2 m²), empiètement sur l'emprise des voies (largeur selon la classe), bande de 10 m le long des
  cours d'eau, plans d'eau, cimetières, zones inondables (MNT), pente (dans le navigateur), sortie de la commune.
  Un superviseur peut passer outre un contrôle bloquant en donnant un motif. Contrôle d'ensemble : chevauchements,
  parcelles à risque, bâtiments sans parcelle par quartier. Seuils modifiables (`fon.parametres`, administrateur).
- **Titulaires et pièces** : titulaires des droits de chaque parcelle (propriétaire, copropriétaire, héritier,
  occupant…, part, période), recherche d'une personne ; pièces jointes (PDF, JPEG, PNG, 5 Mo) aux parcelles, dossiers
  et litiges. À la décision d'un dossier, les droits suivent : mutation (ancien titulaire clos, nouveau inscrit),
  attribution, morcellement et fusion (titulaires reportés sur les nouvelles parcelles).
  **Données personnelles** (titulaires, pièces, parties d'un litige, coordonnées des demandeurs) : réservées au service
  Urbanisme et domaines et aux superviseurs ; chaque consultation de pièce et chaque recherche de personne est tracée
  dans le journal.
- **Litiges** : signalement (sur des parcelles ou un point hors registre), médiation, réunions et audiences,
  résolution à l'amiable ou transmission au tribunal, clôture. Un litige en cours **bloque la décision** des dossiers
  sur les parcelles concernées. Symbole ⚖ sur la carte.
- **Fiche parcellaire** (`fiche-parcelle.html?parcelle=…`) : page A4 imprimable ou en PDF (identification, plan avec
  les bornes et les voisines, titulaires, bornes en UTM 28N et WGS 84, longueur des côtés, contraintes et litiges).
  Délivrée seulement pour une parcelle enregistrée ; chaque délivrance reçoit un numéro `FP-AAAA-NNNNN` et un code.
  Le QR code mène à une **vérification publique** sans aucun nom, qui indique si les limites ont changé depuis.
- **Bilan** : parcelles par statut et par usage, part du bâti couvert, dossiers par type et délais, activité sur 12 mois,
  litiges par type et par quartier.
- **Fiscalité locale (estimation)** : montant indicatif par parcelle = (superficie × tarif terrain + emprise bâtie ×
  tarif bâti) × coefficient de l'usage, minimum par zone (A, B, C selon le quartier), exonérations (domaine public,
  réserve, équipement public, culte…). Rôle prévisionnel (CSV), paiements et quittances (service Finances et recettes),
  taux de recouvrement. **Le barème fourni est un exemple** : il doit être fixé par le service des finances selon la
  loi de finances en vigueur (modifiable par l'administrateur, puis « Marquer le barème comme validé »).
- Tables : `fon.parcelles`, `fon.parcelles_historique`, `fon.dossiers`, `fon.dossiers_historique`, `fon.titulaires`,
  `fon.pieces`, `fon.litiges`, `fon.litiges_historique`, `fon.fiches`, `fon.zones_fiscales`, `fon.bareme`,
  `fon.coef_usage`, `fon.paiements` (vue `fon.assiette`). Rien de tout cela n'est publié sur la carte publique.

## Gestion des déchets

Onglet **Déchets** de l'espace agents (schéma `dech`). Peuvent organiser (vérifier les points, créer les tournées,
annuler un passage, régler les paramètres) : les services **Hygiène et salubrité** et **Voirie et assainissement**,
et les superviseurs. Tous les agents peuvent saisir des points, faire des constats et relever les passages.

- **Points de collecte et dépotoirs** : dépôt sauvage, dépotoir autorisé, bac / conteneur, point de regroupement,
  centre de transfert, décharge finale. Placés sur la carte ou à la position GPS, avec état (actif, saturé, fermé,
  résorbé), volume estimé, capacité, accès (camion, tricycle, à pied), photo. Numéros par type : `DS-00001`,
  `BC-00001`… Un point à moins de 15 m d'un point existant demande confirmation (doublon). Chaque **constat** (état,
  volume, photo) est gardé dans l'historique du point. Un point saisi par un agent est **publié sur la carte publique
  après vérification** par le service (ceux du service sont vérifiés d'office). La couche part vide : les agents la
  remplissent sur le terrain.
- **Signalements « Dépôt d'ordures »** (onglet Saisie) : une fois validés, ils apparaissent dans l'onglet Déchets ;
  le service les convertit en dépôt sauvage (ou les rattache à un point existant à moins de 30 m). Le signalement
  passe « En cours » au service Hygiène, puis « Traité » quand le dépôt est résorbé.
- **Tournées** (`T-01`…) : nom, jours de passage, heure de départ, moyen, véhicule, équipe, prestataire. Les points
  se choisissent en cliquant sur la carte dans l'ordre de passage ; le trajet est **calculé sur les rues** (ordre
  optimisé, retour au départ en option) ou tracé à la main. Durée estimée = trajet (15 km/h en camion, 10 en tricycle,
  4 à pied) + un arrêt par point (5 min, réglable). Fiche : quartiers traversés, bâtiments desservis, passages, export GPX.
- **Terrain** : programme du jour ; « Démarrer » puis, à chaque point, ✓ collecté, ⚠ saturé (le point passe
  « Saturé ») ou ✗ non collecté avec un motif. **Fonctionne sans réseau** : relevés, constats et nouveaux points
  sont gardés dans le téléphone et envoyés au retour de la connexion, sans doublon.
- **Bilan** : dépôts sauvages ouverts par quartier, signalés et résorbés par mois, délai moyen de résorption, points
  saturés, points sans constat récent, réalisation des tournées sur 30 jours (passages faits / prévus, points collectés,
  jours manqués), motifs de non-collecte. **Couverture** : part des bâtiments à moins de 200 m (réglable) d'une tournée
  active ou d'un point de collecte, par quartier, et bâtiments non desservis sur la carte.
- Exports CSV des points et des tournées. Carte publique : points vérifiés en service et tournées actives avec leurs
  jours de passage (fichiers `dechets_points.geojson` et `dechets_tournees.geojson` sur GitHub Pages).
- Tables : `dech.points`, `dech.constats`, `dech.tournees`, `dech.passages`, `dech.passages_points`,
  `dech.parametres`, `dech.bati_quartier`.

## Protection de l'environnement

Onglet **Environnement** de l'espace agents (schéma `env`). Organisent (zones, mises en demeure, sanctions,
import satellite, paramètres) : le service **Environnement et cadre de vie** (nouveau service), l'**Hygiène et
salubrité** et les superviseurs. Tous les agents signalent, constatent, plantent et suivent.

- **Zones protégées** (`ZP-0001`…), avec une règle : protection intégrale, inconstructible ou constructible sous
  conditions. **Calculées** à partir des données de la commune : berges des cours d'eau (largeur du paramètre
  du foncier, 10 m), pentes de plus de 30 % (grille du relief, 30 m), bas-fonds (zones inondables d'aléa fort),
  boisements (OpenStreetMap) ; **dessinées** : forêts classées, espaces verts, zones de reboisement ; **périmètres
  des points d'eau** (50 m par défaut, inconstructibles), créés et mis à jour avec chaque source, puits ou forage.
  Les zones s'ajoutent aux **contrôles du foncier** : protection intégrale = contrôle bloquant, inconstructible =
  alerte. Fiche : bâtiments dans la zone (par quartier, sur la carte), parcelles concernées, atteintes.
- **Atteintes à l'environnement** (`AE-AAAA-0001`) : coupe d'arbres, feu, extraction de sable, occupation de berge,
  eaux usées, pollution d'une source, érosion, carrière sauvage. Signalées sur la carte (point ou surface) ou au GPS,
  avec photo ; zones protégées touchées indiquées dès la saisie. Circuit : Signalée → Constatée → Mise en demeure
  (délai) → Sanctionnée (amende) / Remise en état → Close, ou Classée sans suite ; délais dépassés signalés.
  La **personne mise en cause** n'est visible que du service et de l'agent qui l'a saisie. Les signalements
  « Coupe d'arbres », « Feu de brousse », « Atteinte à l'environnement » et « Inondation / érosion » de l'onglet
  Saisie deviennent des dossiers d'atteinte (puis « Traité » à la remise en état ou à la clôture).
- **Arbres et reboisement** (`PL-0001`) : arbre isolé, alignement (ligne), reboisement (surface), espèces, nombre de
  plants, organisme, campagne ; **suivis** (plants vivants, état, photo) et taux de survie.
- **Sources et points d'eau** (`SO-`, `PU-`, `FO-`, `RE-`) : état (permanent, tarit en saison sèche, tari, pollué),
  usage, aménagement ; constats (débit, qualité) ; bâtiments et dépôts d'ordures (module Déchets) dans le périmètre.
- **Feux de brousse** : saisis sur le terrain (point ou surface brûlée, cause) ou **importés de la NASA (FIRMS)** :
  télécharger le CSV des feux actifs (VIIRS ou MODIS) sur https://firms.modaps.eosdis.nasa.gov/download/ et
  l'importer ; seules les détections de la commune sont gardées, sans doublon. Saisons de novembre à octobre.
- **Bilan** : atteintes par type et par quartier, délais, mises en demeure dépassées ; plantations et survie par
  campagne ; points d'eau par état ; feux par saison et par mois ; bâtiments en zone protégée stricte par type de
  zone et par quartier (liste CSV) ; couverture végétale cartographiée par quartier.
- Saisies possibles sans réseau (même file d'attente que les déchets). Exports CSV de chaque couche.
- Carte publique : zones protégées, sources et points d'eau, plantations, feux (pas les atteintes).
  Fichiers `env_zones`, `env_points_eau`, `env_plantations`, `env_feux` (`.geojson`) sur GitHub Pages.
- Tables : `env.zones`, `env.atteintes`, `env.atteintes_historique`, `env.plantations`, `env.plantations_suivis`,
  `env.points_eau`, `env.points_eau_constats`, `env.feux`, `env.parametres`.

## Réseaux : éclairage public, bornes-fontaines, pannes et fuites

Onglet **Réseaux** de l'espace agents (schéma `res`). Gèrent (transmission, réparation, classement, paramètres) : les
**Services techniques**, la **Voirie et assainissement** et les superviseurs. Tous les agents recensent et signalent.
Les grands réseaux (lignes de l'EDG, conduites de la SEG) ne sont pas gérés ici.

- **Éclairage public** (`LP-0001`…) : lampadaires solaires ou raccordés, lampe, puissance, gestionnaire, état
  (en service, en panne, hors service, volé / détruit), rue la plus proche calculée. Un lampadaire à moins de 3 m
  d'un autre demande confirmation. **Rues éclairées** : part de la longueur de chaque rue à moins de 25 m d'un
  lampadaire en service (rue éclairée, en partie, pas ou peu éclairée).
- **Bornes-fontaines** (`BF-0001`…) : borne-fontaine, kiosque à eau ou forage équipé, gestionnaire, robinets,
  prix du bidon de 20 litres, horaires, état (en service, débit faible, en panne, fermée). **Bâtiments loin d'une
  borne** : à plus de 500 m d'une borne qui donne de l'eau, montrés en rouge.
- **Pannes et fuites** (`PA-AAAA-0001` pour l'éclairage, `FU-AAAA-0001` pour l'eau) : signalées depuis la fiche d'un
  lampadaire ou d'une borne, sur la carte ou au GPS, avec photo et urgence. Circuit : Signalée → Transmise (EDG, SEG,
  entreprise, équipe municipale) → En réparation → Réparée (coût), ou Classée sans suite ; délai visé de 7 jours
  (éclairage) et 3 jours (eau), dépassements signalés. L'état de l'équipement suit la panne : « En panne » tant
  qu'elle est ouverte, « En service » à la réparation. Un équipement recensé « En panne » ouvre une panne tout seul.
  Les signalements « Éclairage en panne » et « Fuite d'eau » de l'onglet Saisie deviennent des interventions,
  rattachées au lampadaire ou à la borne la plus proche (puis « Traité » à la réparation).
- **Bilan** : part des rues éclairées et des bâtiments desservis en eau, par quartier ; pannes en cours, en retard,
  délai moyen de réparation et dépenses par réseau ; pannes par nature et par quartier ; signalements par mois.
- Saisies possibles sans réseau (même file d'attente que les déchets). Exports CSV : lampadaires, bornes, pannes et
  fuites, tableau par quartier. Paramètres (portée d'un lampadaire, distance à une borne, délais) dans le Bilan.
- Carte publique : lampadaires et bornes-fontaines avec leur état (pas les pannes). Fichiers `res_lampadaires`,
  `res_bornes` (`.geojson`) sur GitHub Pages.
- Tables : `res.lampadaires`, `res.bornes`, `res.interventions`, `res.interventions_historique`, `res.parametres`.

## Marchés et gares routières

Onglet **Marchés** de l'espace agents (schéma `mar`). Gèrent (emplacements, occupants, encaissements, impayés, paramètres) :
le **Développement local**, les **Finances et recettes** et les superviseurs. Tous les agents recensent les sites.

- **Sites** (`MA-0001` marché, `GR-0001` gare routière) : marché quotidien, hebdomadaire, à bétail, gare routière ; point ou
  **emprise** dessinée, état (en activité, en travaux, fermé), gestion (régie, concession, syndicat), jours, horaires, responsable,
  destinations et capacité (gares), tarif du ticket journalier ou du droit de stationnement. Un site du même genre à moins de
  50 m demande confirmation. « Importer les marchés et gares de la carte » crée un site pour chaque équipement « Marché » ou
  « Gare routière » (une seule fois) ; les saisies validées « Marché » / « Gare routière » de l'onglet Saisie deviennent des sites.
- **Emplacements** (`MA-0001-001`…) : boutique, magasin, hangar ou étal, table, place au sol, kiosque, bureau de ligne,
  stationnement ; créés en série, surface, loyer mensuel, statut (libre, occupé, hors service), occupant, téléphone, activité,
  date de début (les loyers sont dus à partir de ce mois), position facultative sur la carte. **Occupants et téléphones** :
  service et superviseurs seulement (ni dans les fiches des autres agents, ni sur la carte publique).
- **Recettes** : loyer mensuel (un par emplacement et par mois), tickets journaliers et droits de stationnement (nombre × tarif
  du site), autres droits ; espèces, mobile money, chèque. Chaque encaissement reçoit une **quittance** `QM-AAAA-00001`
  imprimable (A5, ou PDF) ; il est possible sans réseau (même file d'attente que les déchets). Une quittance ne se supprime
  pas : un **superviseur** l'annule en donnant le motif (journal).
- **Impayés** : emplacements occupés dont le loyer d'un mois échu n'est pas encaissé (le mois en cours compte après le jour
  d'échéance, 10 par défaut), avec les mois dus ; encaissement direct depuis la liste.
- **Bilan** : sites, emplacements et occupation par site ; pour le service : recettes du mois et de 12 mois, part des loyers
  du mois encaissés, impayés, annulations, recettes par mois, par site, par nature, par agent, véhicules des gares (30 jours).
- Exports CSV : sites, emplacements et occupants, recettes d'une période, impayés. Paramètres (jour d'échéance, mois examinés)
  dans le Bilan.
- Carte publique : sites avec type, jours, horaires, destinations, emplacements libres (fichier `mar_sites.geojson`).
- Tables : `mar.sites`, `mar.places`, `mar.perceptions`, `mar.parametres`.

## Table attributaire (bouton ⊞)

Comme dans QGIS : dans l'onglet « Couches », le bouton ⊞ à droite d'une couche ouvre sa table attributaire en bas
de la carte (carte publique et espace agents ; bâti, voirie, quartiers, équipements, hydrographie, espaces verts,
zones inondables, voies et adresses, saisies, parcelles, litiges…).

- Tri en cliquant un titre de colonne (▲ / ▼), recherche dans toutes les colonnes, affichage de toutes les entités,
  de celles **visibles sur la carte** ou des **sélectionnées**.
- Sélection d'une ligne au clic, **Ctrl** + clic pour en ajouter, **Maj** + clic pour une plage ; les entités
  sélectionnées sont surlignées en jaune sur la carte. Double-clic : zoom sur l'entité et ouverture de sa fiche.
- « Zoomer » (sur la sélection ou les entités filtrées), « Colonnes » (colonnes affichées), « CSV » (entités
  filtrées ou sélectionnées, pour Excel), ⤢ pour agrandir.
- Surface ou longueur calculée ajoutée quand la couche n'en a pas. Défilement virtuel : le bâti (44 000 entités)
  s'affiche sans ralentir.

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
  tableau triable (clic sur une ligne = zoom), exports **CSV** (Excel) et **GeoJSON** (QGIS) ; **Désélectionner**
  (onglet ou tableau) retire la sélection de la carte, ✕ ferme seulement le tableau.

Exemples : bâtiments en construction de Daka 1 · bâtiments de plus de 300 m² · voies sans nom de Madina ·
adresses d'un quartier pour une tournée · bâtiments en zone inondable (proximité des cours d'eau).

**Sélection par localisation** (bouton « ⧉ Sélection par localisation… », comme l'outil de QGIS) : les objets d'une couche
dont la relation avec ceux d'une autre couche est **intersecte, touche, contient, chevauche, est disjoint, est à l'intérieur,
égal ou croise** (plusieurs prédicats cochés : l'un ou l'autre). Chacune des deux couches peut être restreinte à un objet ou à un
type d'objets (« Seulement les objets » : Nom : Sala, Type de voie : Voie rapide…, comme pour la proximité) ; exemples :
les quartiers qui intersectent la rivière Sala (8) ou qui la croisent (2), les bâtiments en construction en zone inondable
d'aléa fort (37). Chaque exécution remplace la sélection affichée. Couches : celles de la sélection,
plus les **zones inondables** (aléa fort et moyen du relief). Une couche comparée à elle-même : chaque objet est comparé aux
autres (ex. bâtiments qui touchent un autre bâtiment). Calcul dans le navigateur (`web/js/topologie.js`), en coordonnées
planes locales, avec une tolérance de contact de 5 cm (les coordonnées servies sont arrondies à environ 10 cm) : résultats
identiques à PostGIS, sauf pour les contacts de quelques centimètres (bâtiments voisins, rivière qui longe une limite de
quartier). Environ 1 s pour les 44 000 bâtiments comparés aux zones inondables.

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

## Relief et risques naturels

Modèle numérique de terrain **Copernicus GLO-30** (30 m, gratuit), traité par `scripts/relief/relief.py`
(conteneur GDAL, environ 30 s) :

```powershell
docker compose --profile outils run --rm relief    # écrit data/public/relief/ et la table ref.zones_inondables
```

- **Couches** (onglet « Couches », groupe « Relief et risques naturels ») : relief ombré, courbes de niveau (10 m),
  pentes (5 / 15 / 30 %), zones inondables.
- **Zones inondables** : méthode HAND (hauteur au-dessus du drainage le plus proche). Les écoulements sont calculés
  (comblement des cuvettes, réseau de drainage = cellules drainant plus de 0,5 km²) ; aléa **fort** à moins de 2 m
  au-dessus du drainage, **moyen** de 2 à 5 m.
- **Onglet Analyses → ⛰ Relief** : chiffres de la commune, **bâtiments exposés** (inondation, pentes fortes),
  seuils modifiables, détail **par quartier** (liste des bâtiments, export CSV), **profil en long** d'un tracé
  (altitude, dénivelés, pentes, export CSV).
- **Outil ⓘ** : altitude, pente, hauteur au-dessus du drainage et aléa au point cliqué (une fois le relief chargé).

Limite : Copernicus est un modèle de *surface* (une partie des arbres et des toits est incluse). Les résultats servent
à **repérer les secteurs à vérifier** sur le terrain, pas à établir un zonage réglementaire.

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
docker compose restart api      # remet en place les mises à jour automatiques du bâti
```

### Modifier le bâti et les cours d'eau dans QGIS

Connexion PostgreSQL dans QGIS : hôte `localhost`, port `5433`, base `labe`, utilisateur `labe`, mot de passe
`POSTGRES_PASSWORD` du fichier `.env`. Couches `ref.batiments` (polygones : `nature`) et `ref.cours_eau`
(lignes : `nom`, `regime` = `Permanent` ou `Intermittent`), en EPSG:4326. Ne pas remplir `gid` (numéro automatique).

Après chaque ajout, déplacement ou suppression d'un bâtiment, la base met à jour toute seule (déclencheurs de
`api/reference.sql`) : le centre du bâtiment pour l'adressage et le foncier, son quartier pour la couverture des
déchets, le nombre de bâtiments des quartiers, et détache l'adresse d'un bâtiment supprimé (l'adresse est gardée).
La carte locale est à jour immédiatement ; la carte publique GitHub après `scripts\publier.ps1`.

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
- Relief : Copernicus GLO-30 DEM, © DLR e.V. 2010-2014 et © Airbus Defence and Space GmbH 2014-2018, fourni dans le cadre du programme Copernicus.
