/* Gestion des déchets : symbologie commune (carte publique et espace agents) et couches de la carte publique.
 * Carte publique : points de collecte et dépotoirs vérifiés par la mairie, tournées actives avec leurs jours de passage.
 * Mode serveur : API /dechets/public ; mode statique (GitHub Pages) : data/dechets_*.geojson. */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc;
  // 3 classes (couleurs vérifiées pour les daltoniens) ; la lettre dans le symbole donne le type exact
  var CLASSES = [
    { nom: 'Dépôts sauvages', couleur: '#eb6834', texte: '#fff', types: ['Dépôt sauvage'] },
    { nom: 'Collecte de proximité (bacs, points de regroupement)', couleur: '#1baf7a', texte: '#0b2e22', types: ['Bac / conteneur', 'Point de regroupement'] },
    { nom: 'Dépotoirs et installations', couleur: '#6250d6', texte: '#fff', types: ['Dépotoir autorisé', 'Centre de transfert', 'Décharge finale'] }
  ];
  var SYMBOLE = { 'Dépôt sauvage': 'S', 'Dépotoir autorisé': 'D', 'Bac / conteneur': 'B', 'Point de regroupement': 'R',
    'Centre de transfert': 'T', 'Décharge finale': 'F' };
  var GRIS = '#868e96', SATURE = '#d03b3b', TOURNEE = '#343a40';

  function classe(type) {
    for (var i = 0; i < CLASSES.length; i++) if (CLASSES[i].types.indexOf(type) >= 0) return CLASSES[i];
    return CLASSES[0];
  }
  function ferme(p) { return p.etat === 'Fermé' || p.etat === 'Résorbé'; }
  // o.aVerifier : bord en tirets ; o.ordre : numéro de passage à la place de la lettre ; o.choisi : anneau jaune
  function icone(p, o) {
    o = o || {};
    var c = classe(p.type), f = ferme(p);
    var cls = 'dech-ico' + (f ? ' ferme' : '') + (p.etat === 'Saturé' ? ' sature' : '') + (o.aVerifier ? ' a-verifier' : '') + (o.choisi ? ' choisi' : '');
    var txt = o.ordre != null ? String(o.ordre) : SYMBOLE[p.type] || '?';
    return L.divIcon({ className: 'dech-marker', iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -11],
      html: '<span class="' + cls + '" style="--c:' + (f ? GRIS : c.couleur) + ';--t:' + (f ? GRIS : c.texte) + '">' + esc(txt) +
        (p.etat === 'Saturé' ? '<i title="Saturé">!</i>' : '') + '</span>' });
  }
  function legende() {
    return CLASSES.map(function (c) { return [c.nom, c.couleur, 'dot']; })
      .concat([['Saturé (anneau rouge et « ! »)', SATURE, 'dot'], ['Fermé ou résorbé', GRIS, 'dot']]);
  }
  function legendeTypes() {
    return Object.keys(SYMBOLE).map(function (t) { return SYMBOLE[t] + ' = ' + t; }).join(' · ');
  }
  function styleTournee(p) {
    return { color: TOURNEE, weight: 3, opacity: p && p.active === false ? 0.45 : 0.85, dashArray: p && p.active === false ? '6 6' : null };
  }
  function dateFr(d) { return d ? new Date(d).toLocaleDateString('fr-FR') : ''; }

  window.LabeDechetsCarte = { CLASSES: CLASSES, SYMBOLE: SYMBOLE, GRIS: GRIS, SATURE: SATURE, TOURNEE: TOURNEE,
    classe: classe, ferme: ferme, icone: icone, legende: legende, legendeTypes: legendeTypes, styleTournee: styleTournee };

  // ---------- Carte publique ----------
  if (document.getElementById('tab-dech')) return; // espace agents : couches gérées par js/dechets.js

  function lire(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  A.ready.then(function () {
    return A.STATIC ? Promise.all([lire('data/dechets_points.geojson'), lire('data/dechets_tournees.geojson')])
      .then(function (r) { return { points: r[0], tournees: r[1] }; }) : lire('/api/dechets/public');
  }).then(function (d) {
    var points = A.markClicks(L.featureGroup()), tournees = A.markClicks(L.featureGroup());
    L.geoJSON(d.tournees, {
      style: function () { return styleTournee(); },
      onEachFeature: function (f, l) {
        var p = f.properties;
        l.bindPopup(A.popupHtml('Tournée de collecte ' + p.code, {
          nom: p.nom, jours: p.jours, heure: p.heure_depart ? 'à partir de ' + p.heure_depart.replace(':', ' h ') : null,
          moyen: p.moyen, quartiers: p.quartiers, points: p.points ? p.points + ' point(s) de collecte' : null
        }, { nom: 'Secteur', jours: 'Passage', heure: 'Horaire', moyen: 'Moyen', quartiers: 'Quartiers', points: 'Arrêts' }));
        tournees.addLayer(l);
        A.searchIndex.push({ name: 'Tournée ' + p.code + ' · ' + p.nom, type: 'Collecte des déchets · ' + p.jours, layer: L.featureGroup([l]), parent: tournees });
      }
    });
    L.geoJSON(d.points, {
      pointToLayer: function (f, ll) { return L.marker(ll, { icon: icone(f.properties), keyboard: false }); },
      onEachFeature: function (f, l) {
        var p = f.properties;
        l.bindPopup(A.popupHtml((p.nom || p.type) + ' (' + p.numero + ')', {
          type: p.type, etat: p.etat, acces: p.acces, quartier: p.quartier, constat: dateFr(p.constat)
        }, { type: 'Type', etat: 'État', acces: 'Accès', quartier: 'Quartier', constat: 'Dernier constat' }) +
          '<small class="muted">Un dépôt d\'ordures à signaler ? Contactez le service Hygiène et salubrité de la mairie.</small>');
        points.addLayer(l);
        A.searchIndex.push({ name: (p.nom ? p.nom + ' · ' : '') + p.numero, type: p.type + ' · ' + (p.quartier || ''), layer: l, parent: points });
      }
    });
    A.enregistrerIdentifiable(points, 'Points de collecte et dépotoirs');
    A.enregistrerIdentifiable(tournees, 'Tournées de collecte');
    A.addOverlay({ name: 'Points de collecte et dépotoirs (' + d.points.features.length + ')', layer: points, on: true, group: 'Gestion des déchets',
      swatch: '<span class="swatch dot" style="background:' + CLASSES[1].couleur + '"></span>', legend: legende() });
    A.addOverlay({ name: 'Tournées de collecte (' + d.tournees.features.length + ')', layer: tournees, on: false, group: 'Gestion des déchets',
      swatch: '<span class="swatch line" style="background:' + TOURNEE + '"></span>' });
  }).catch(function () { /* données des déchets pas encore publiées */ });
})();
