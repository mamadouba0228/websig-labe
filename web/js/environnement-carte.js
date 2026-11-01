/* Protection de l'environnement : symbologie commune (carte publique et espace agents) et couches de la carte publique.
 * Carte publique : zones protégées, plantations, sources et points d'eau, feux de brousse (pas les atteintes).
 * Mode serveur : API /environnement/public ; mode statique (GitHub Pages) : data/env_*.geojson. */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc;
  // Couleurs vérifiées pour les daltoniens ; la règle se lit au remplissage et au contour, le type dans la fiche
  var EAU = '#2a78d6', VERT = '#008300', RELIEF = '#eda100', FEU = '#e34948', GRIS = '#868e96', ALERTE = '#d03b3b', ATTEINTE = '#212529';
  var GROUPES = [
    { nom: 'Eau : berges, sources, bas-fonds', couleur: EAU, types: ['Berge de cours d\'eau', 'Périmètre de source', 'Bas-fond / zone humide'] },
    { nom: 'Végétation : forêts, boisements, espaces verts', couleur: VERT, types: ['Forêt classée', 'Boisement', 'Espace vert', 'Zone de reboisement'] },
    { nom: 'Relief : pentes fortes', couleur: RELIEF, types: ['Pente forte'] }
  ];
  var SYMBOLE_EAU = { 'Source': 'S', 'Puits': 'P', 'Forage': 'F', 'Mare / retenue': 'M' };

  function groupe(type) {
    for (var i = 0; i < GROUPES.length; i++) if (GROUPES[i].types.indexOf(type) >= 0) return GROUPES[i];
    return { nom: 'Autre', couleur: GRIS };
  }
  function styleZone(p) {
    var c = groupe(p.type).couleur, r = p.regle;
    if (p.active === false) return { color: GRIS, weight: 1, dashArray: '2 4', fillOpacity: 0, opacity: 0.7 };
    return { color: c, weight: r === 'Protection intégrale' ? 2.5 : 1.5, opacity: 0.9, fillColor: c,
      fillOpacity: r === 'Protection intégrale' ? 0.35 : r === 'Inconstructible' ? 0.2 : 0.07,
      dashArray: r === 'Constructible sous conditions' ? '5 4' : null };
  }
  function legendeZones() {
    return GROUPES.map(function (g) { return [g.nom, g.couleur]; })
      .concat([['Remplissage foncé : protection intégrale', '#495057'], ['Remplissage clair : inconstructible', '#ced4da'],
        ['Contour en tirets : constructible sous conditions', '#fff', 'line']]);
  }
  function rond(lettre, couleur, texte, o) {
    o = o || {};
    return L.divIcon({ className: 'dech-marker', iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -11],
      html: '<span class="dech-ico' + (o.ferme ? ' ferme' : '') + (o.alerte ? ' sature' : '') + (o.aVerifier ? ' a-verifier' : '') +
        '" style="--c:' + couleur + ';--t:' + texte + '">' + esc(lettre) + (o.alerte ? '<i title="' + esc(o.alerte) + '">!</i>' : '') + '</span>' });
  }
  function iconeEau(p) {
    var tari = p.etat === 'Tari';
    return rond(SYMBOLE_EAU[p.type] || '?', tari ? GRIS : EAU, tari ? GRIS : '#fff', { ferme: tari, alerte: p.etat === 'Pollué' ? 'Pollué' : null });
  }
  function iconePlantation() { return rond('A', VERT, '#fff'); }
  function iconeAtteinte(p) {
    var clos = p.statut === 'Close' || p.statut === 'Classée sans suite' || p.statut === 'Remise en état';
    return L.divIcon({ className: 'dech-marker', iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -11],
      html: '<span class="env-atteinte' + (clos ? ' close' : '') + (p.gravite === 'Grave' && !clos ? ' grave' : '') + '"><b>!</b></span>' });
  }
  function iconeFeu() { return rond('✸', FEU, '#fff'); }
  var STYLE_PLANTATION = { color: VERT, weight: 2.5, opacity: 0.9, fillColor: VERT, fillOpacity: 0.15, dashArray: '2 5' };
  var STYLE_FEU = { color: FEU, weight: 1.5, opacity: 0.9, fillColor: FEU, fillOpacity: 0.3 };
  function dateFr(d) { return d ? new Date(d).toLocaleDateString('fr-FR') : ''; }

  window.LabeEnvCarte = { EAU: EAU, VERT: VERT, RELIEF: RELIEF, FEU: FEU, GRIS: GRIS, ALERTE: ALERTE, ATTEINTE: ATTEINTE, GROUPES: GROUPES,
    groupe: groupe, styleZone: styleZone, legendeZones: legendeZones, iconeEau: iconeEau, iconePlantation: iconePlantation,
    iconeAtteinte: iconeAtteinte, iconeFeu: iconeFeu, STYLE_PLANTATION: STYLE_PLANTATION, STYLE_FEU: STYLE_FEU };

  // ---------- Carte publique ----------
  if (document.getElementById('tab-env')) return; // espace agents : couches gérées par js/environnement.js

  function lire(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  A.ready.then(function () {
    if (!A.STATIC) return lire('/api/environnement/public');
    return Promise.all(['zones', 'plantations', 'points_eau', 'feux'].map(function (k) { return lire('data/env_' + k + '.geojson'); }))
      .then(function (r) { return { zones: r[0], plantations: r[1], points_eau: r[2], feux: r[3] }; });
  }).then(function (d) {
    var G = 'Protection de l\'environnement';
    function couche(fc, opts, fiche, nom, libelle) {
      var g = A.markClicks(L.featureGroup());
      L.geoJSON(fc, {
        style: opts.style, pointToLayer: opts.point,
        onEachFeature: function (f, l) {
          var x = fiche(f.properties);
          l.bindPopup(A.popupHtml(x[0], x[1], x[2]) + (x[3] || ''));
          g.addLayer(l);
          if (libelle) A.searchIndex.push({ name: libelle(f.properties), type: nom, layer: l.getLatLng ? l : L.featureGroup([l]), parent: g });
        }
      });
      A.enregistrerIdentifiable(g, nom);
      return g;
    }
    var zones = couche(d.zones, { style: function (f) { return styleZone(f.properties); } }, function (p) {
      return ['Zone protégée ' + p.code, { nom: p.nom, type: p.type, regle: p.regle, ref: p.reference, sup: p.superficie_ha != null ? A.fmt(p.superficie_ha, 1) + ' ha' : null },
        { nom: 'Nom', type: 'Type', regle: 'Règle', ref: 'Référence', sup: 'Superficie' },
        '<small class="muted">Avant de construire ou d\'aménager, renseignez-vous auprès de la mairie.</small>'];
    }, 'Zones protégées', function (p) { return p.nom + ' · ' + p.code; });
    var eau = couche(d.points_eau, { point: function (f, ll) { return L.marker(ll, { icon: iconeEau(f.properties), keyboard: false }); } }, function (p) {
      return [(p.nom || p.type) + ' (' + p.numero + ')', { type: p.type, etat: p.etat, amenage: p.amenage, quartier: p.quartier },
        { type: 'Type', etat: 'État', amenage: 'Aménagé', quartier: 'Quartier' }];
    }, 'Sources et points d\'eau', function (p) { return (p.nom ? p.nom + ' · ' : '') + p.numero; });
    var plantations = couche(d.plantations, { style: function () { return STYLE_PLANTATION; },
      point: function (f, ll) { return L.marker(ll, { icon: iconePlantation(), keyboard: false }); } }, function (p) {
      return ['Plantation ' + p.numero, { type: p.type, espece: p.espece, plants: A.fmt(p.nombre_plants), date: dateFr(p.date), org: p.organisme,
        survie: p.survie_pct != null ? p.survie_pct + ' %' : null },
        { type: 'Type', espece: 'Espèces', plants: 'Plants', date: 'Plantée le', org: 'Organisme', survie: 'Taux de survie' }];
    }, 'Plantations', null);
    var feux = couche(d.feux, { style: function () { return STYLE_FEU; },
      point: function (f, ll) { return L.marker(ll, { icon: iconeFeu(), keyboard: false }); } }, function (p) {
      return ['Feu de brousse', { date: dateFr(p.date), saison: p.saison, origine: p.origine, cause: p.cause,
        surface: p.surface_ha ? A.fmt(p.surface_ha, 1) + ' ha' : null, quartier: p.quartier },
        { date: 'Date', saison: 'Saison', origine: 'Origine', cause: 'Cause', surface: 'Surface brûlée', quartier: 'Quartier' }];
    }, 'Feux de brousse', null);
    var n = function (fc) { return fc.features.length; };
    A.addOverlay({ name: 'Zones protégées (' + n(d.zones) + ')', layer: zones, on: false, group: G,
      swatch: '<span class="swatch" style="background:' + EAU + '"></span>', legend: legendeZones() });
    A.addOverlay({ name: 'Sources et points d\'eau (' + n(d.points_eau) + ')', layer: eau, on: true, group: G,
      swatch: '<span class="swatch dot" style="background:' + EAU + '"></span>',
      legend: [['S source · P puits · F forage · M mare', EAU, 'dot'], ['Pollué (anneau rouge et « ! »)', ALERTE, 'dot'], ['Tari', GRIS, 'dot']] });
    A.addOverlay({ name: 'Plantations (' + n(d.plantations) + ')', layer: plantations, on: true, group: G,
      swatch: '<span class="swatch dot" style="background:' + VERT + '"></span>' });
    A.addOverlay({ name: 'Feux de brousse (' + n(d.feux) + ')', layer: feux, on: false, group: G,
      swatch: '<span class="swatch" style="background:' + FEU + '"></span>' });
  }).catch(function () { /* données de l'environnement pas encore publiées */ });
})();
