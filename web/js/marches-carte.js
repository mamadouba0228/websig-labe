/* Marchés et gares routières : symbologie commune (carte publique et espace agents) et couche de la carte publique.
 * Carte publique : sites avec jours, horaires, destinations et emplacements libres (ni occupants, ni recettes).
 * Mode serveur : API /marches/public ; mode statique (GitHub Pages) : data/mar_sites.geojson. */
(function () {
  'use strict';

  var A = window.LabeApp, esc = A.esc;
  // Mêmes teintes que les catégories Commerce et Transport des équipements ; lettre dans chaque symbole
  var MARCHE = '#e8590c', GARE = '#f2c230', GRIS = '#868e96', ALERTE = '#d03b3b';
  // Emplacements : libre / occupé / hors service (couleur + libellé dans la légende et les fiches)
  var LIBRE = '#2b8a3e', OCCUPEE = '#1c4e80';

  function estGare(p) { return p.type === 'Gare routière'; }
  function couleur(p) { return p.etat === 'Fermé' ? GRIS : estGare(p) ? GARE : MARCHE; }
  function iconeSite(p) {
    var ferme = p.etat === 'Fermé', gare = estGare(p);
    return L.divIcon({ className: 'dech-marker', iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12],
      html: '<span class="dech-ico mar-ico' + (ferme ? ' ferme' : '') + (p.etat === 'En travaux' ? ' sature' : '') + '" style="--c:' + couleur(p) +
        ';--t:' + (gare && !ferme ? '#212529' : '#fff') + '">' + (gare ? 'G' : 'M') + (p.etat === 'En travaux' ? '<i title="En travaux">!</i>' : '') + '</span>' });
  }
  function styleEmprise(p) {
    return { color: couleur(p), weight: 2, dashArray: '5 4', fillColor: couleur(p), fillOpacity: 0.12 };
  }
  function stylePlace(p) {
    var c = p.statut === 'Occupée' ? OCCUPEE : p.statut === 'Libre' ? LIBRE : GRIS;
    return { radius: 6, color: p.impaye ? ALERTE : '#fff', weight: p.impaye ? 3 : 1.5, fillColor: c, fillOpacity: 0.95 };
  }
  // un site en surface : emprise en tirets + symbole au centre ; un site ponctuel : symbole seul
  function dessinerSite(f, groupe, popup) {
    var p = f.properties, centre = p.centre || (f.geometry.type === 'Point' ? f.geometry : null), m;
    if (f.geometry.type !== 'Point') {
      var poly = L.geoJSON(f.geometry, { style: styleEmprise(p) });
      poly.eachLayer(function (l) { if (popup) l.bindPopup(popup, { maxWidth: 300 }); groupe.addLayer(l); });
      if (!centre) centre = { coordinates: [poly.getBounds().getCenter().lng, poly.getBounds().getCenter().lat] };
    }
    m = L.marker([centre.coordinates[1], centre.coordinates[0]], { icon: iconeSite(p), keyboard: false });
    if (popup) m.bindPopup(popup, { maxWidth: 300 });
    groupe.addLayer(m);
    return m;
  }
  var LEGENDE_SITES = [['M marché (quotidien, hebdomadaire, à bétail)', MARCHE, 'dot'], ['G gare routière', GARE, 'dot'],
    ['En travaux (anneau rouge et « ! »)', ALERTE, 'dot'], ['Fermé', GRIS, 'dot'], ['Emprise (tirets)', MARCHE, 'line']];
  var LEGENDE_PLACES = [['Libre', LIBRE, 'dot'], ['Occupé', OCCUPEE, 'dot'], ['Hors service', GRIS, 'dot'], ['Loyer impayé (anneau rouge)', ALERTE, 'dot']];

  window.LabeMarCarte = { MARCHE: MARCHE, GARE: GARE, GRIS: GRIS, ALERTE: ALERTE, LIBRE: LIBRE, OCCUPEE: OCCUPEE, iconeSite: iconeSite,
    styleEmprise: styleEmprise, stylePlace: stylePlace, dessinerSite: dessinerSite, couleur: couleur, LEGENDE_SITES: LEGENDE_SITES,
    LEGENDE_PLACES: LEGENDE_PLACES };

  // ---------- Carte publique ----------
  function lire(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  function publique() {
    A.ready.then(function () {
      return A.STATIC ? lire('data/mar_sites.geojson') : lire('/api/marches/public').then(function (d) { return d.sites; });
    }).then(function (fc) {
      var g = A.markClicks(L.featureGroup());
      fc.features.forEach(function (f) {
        var p = f.properties;
        var html = A.popupHtml(p.nom + ' (' + p.numero + ')', {
          type: p.type, etat: p.etat, jours: p.jours, horaires: p.horaires, destinations: p.destinations,
          capacite: p.capacite ? p.capacite + ' véhicules' : null,
          places: p.places ? p.places + ' dont ' + p.libres + ' libre(s)' : null, gestion: p.gestion, quartier: p.quartier
        }, { type: 'Type', etat: 'État', jours: 'Jours', horaires: 'Horaires', destinations: 'Destinations', capacite: 'Capacité',
          places: 'Emplacements', gestion: 'Gestion', quartier: 'Quartier' }) +
          (p.libres ? '<small class="muted">Pour louer un emplacement libre, adressez-vous à la mairie.</small>' : '');
        var m = dessinerSite(f, g, html);
        A.searchIndex.push({ name: p.nom, type: p.type, layer: m, parent: g });
      });
      A.enregistrerIdentifiable(g, 'Marchés et gares routières');
      A.addOverlay({ name: 'Marchés et gares routières (' + fc.features.length + ')', layer: g, on: false, group: 'Économie',
        swatch: '<span class="swatch dot" style="background:' + MARCHE + '"></span>', legend: LEGENDE_SITES });
    }).catch(function () { /* données des marchés pas encore publiées */ });
  }
  // espace agents : couches gérées par js/marches.js ; la couche publique sert aux agents sans ce service
  if (document.getElementById('tab-mar')) (window.LabeCartesPubliques = window.LabeCartesPubliques || {}).mar = publique;
  else publique();
})();
