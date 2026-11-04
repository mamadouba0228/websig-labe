/* Réseaux : symbologie commune (carte publique et espace agents) et couches de la carte publique.
 * Carte publique : lampadaires et bornes-fontaines avec leur état (pas les pannes en cours).
 * Mode serveur : API /reseaux/public ; mode statique (GitHub Pages) : data/res_*.geojson. */
(function () {
  'use strict';

  var A = window.LabeApp, esc = A.esc;
  // Couleurs vérifiées pour les daltoniens (ambre ≠ sarcelle ≠ bleu des sources) ; lettre dans chaque symbole
  var LUMIERE = '#eda100', BORNE = '#00a3a3', GRIS = '#868e96', ALERTE = '#d03b3b', PANNE = '#212529';

  function rond(lettre, couleur, texte, o) {
    o = o || {};
    return L.divIcon({ className: 'dech-marker', iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -11],
      html: '<span class="dech-ico' + (o.ferme ? ' ferme' : '') + (o.alerte ? ' sature' : '') + '" style="--c:' + couleur + ';--t:' + texte + '">' +
        esc(lettre) + (o.alerte ? '<i title="' + esc(o.alerte) + '">!</i>' : '') + '</span>' });
  }
  function iconeLampadaire(p) {
    var hs = p.etat === 'Hors service' || p.etat === 'Volé / détruit';
    return rond('L', hs ? GRIS : LUMIERE, '#212529', { ferme: hs, alerte: p.etat === 'En panne' ? 'En panne' : null });
  }
  function iconeBorne(p) {
    var ferme = p.etat === 'Fermée';
    return rond('B', ferme ? GRIS : BORNE, '#fff', { ferme: ferme,
      alerte: p.etat === 'En panne' ? 'En panne' : p.etat === 'Débit faible' ? 'Débit faible' : null });
  }
  function iconeIntervention(p) {
    var close = p.statut === 'Réparée' || p.statut === 'Classée sans suite';
    // panne d'un lampadaire ou d'une borne : symbole décalé en haut à droite, l'équipement reste visible et cliquable
    var decale = !!p.equipement;
    return L.divIcon({ className: 'dech-marker', iconSize: [24, 24], iconAnchor: decale ? [-2, 26] : [12, 12], popupAnchor: decale ? [12, -25] : [0, -11],
      html: '<span class="res-panne' + (close ? ' close' : '') + (p.urgence === 'Urgente' && !close ? ' urgente' : '') +
        (p.en_retard && !close ? ' retard' : '') + '">' + (p.reseau === 'Eau' ? 'F' : 'P') + '</span>' });
  }
  // rues : part de la longueur à portée d'un lampadaire en service
  function styleVoie(p) {
    var pct = p.pct || 0;
    if (pct >= 75) return { color: LUMIERE, weight: 4, opacity: 0.95 };
    if (pct >= 25) return { color: LUMIERE, weight: 3, opacity: 0.9, dashArray: '6 5' };
    return { color: GRIS, weight: 1.5, opacity: 0.7 };
  }
  var LEGENDE_VOIES = [['Rue éclairée (75 % et plus)', LUMIERE, 'line'], ['Rue éclairée en partie (25 à 75 %, tirets)', LUMIERE, 'line'],
    ['Rue pas ou peu éclairée', GRIS, 'line']];
  var LEGENDE_LAMPADAIRES = [['L lampadaire en service', LUMIERE, 'dot'], ['En panne (anneau rouge et « ! »)', ALERTE, 'dot'], ['Hors service', GRIS, 'dot']];
  var LEGENDE_BORNES = [['B borne-fontaine, kiosque, forage équipé', BORNE, 'dot'], ['En panne ou débit faible (anneau rouge et « ! »)', ALERTE, 'dot'], ['Fermée', GRIS, 'dot']];

  window.LabeResCarte = { LUMIERE: LUMIERE, BORNE: BORNE, GRIS: GRIS, ALERTE: ALERTE, PANNE: PANNE, iconeLampadaire: iconeLampadaire,
    iconeBorne: iconeBorne, iconeIntervention: iconeIntervention, styleVoie: styleVoie, LEGENDE_VOIES: LEGENDE_VOIES,
    LEGENDE_LAMPADAIRES: LEGENDE_LAMPADAIRES, LEGENDE_BORNES: LEGENDE_BORNES };

  // ---------- Carte publique ----------
  function lire(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  function publique() {
    A.ready.then(function () {
      if (!A.STATIC) return lire('/api/reseaux/public');
      return Promise.all(['lampadaires', 'bornes'].map(function (k) { return lire('data/res_' + k + '.geojson'); }))
        .then(function (r) { return { lampadaires: r[0], bornes: r[1] }; });
    }).then(function (d) {
      var G = 'Réseaux';
      function couche(fc, icone, fiche, nom, libelle) {
        var g = A.markClicks(L.featureGroup());
        L.geoJSON(fc, {
          pointToLayer: function (f, ll) { return L.marker(ll, { icon: icone(f.properties), keyboard: false }); },
          onEachFeature: function (f, l) {
            var x = fiche(f.properties);
            l.bindPopup(A.popupHtml(x[0], x[1], x[2]) + (x[3] || ''));
            g.addLayer(l);
            if (libelle) A.searchIndex.push({ name: libelle(f.properties), type: nom, layer: l, parent: g });
          }
        });
        A.enregistrerIdentifiable(g, nom);
        return g;
      }
      var lamp = couche(d.lampadaires, iconeLampadaire, function (p) {
        return ['Lampadaire ' + p.numero, { alim: p.alimentation, etat: p.etat, voie: p.voie, quartier: p.quartier },
          { alim: 'Alimentation', etat: 'État', voie: 'Rue', quartier: 'Quartier' },
          p.etat === 'En panne' ? '<small class="muted">Panne connue de la mairie.</small>' : ''];
      }, 'Éclairage public', null);
      var bornes = couche(d.bornes, iconeBorne, function (p) {
        return [(p.nom || p.type) + ' (' + p.numero + ')', { type: p.type, etat: p.etat, gest: p.gestionnaire, payante: p.payante,
          prix: p.prix_gnf ? A.fmt(p.prix_gnf) + ' GNF le bidon de 20 l' : null, horaires: p.horaires, quartier: p.quartier },
          { type: 'Type', etat: 'État', gest: 'Gestionnaire', payante: 'Payante', prix: 'Prix', horaires: 'Horaires', quartier: 'Quartier' }];
      }, 'Bornes-fontaines', function (p) { return (p.nom ? p.nom + ' · ' : '') + p.numero; });
      var n = function (fc) { return fc.features.length; };
      A.addOverlay({ name: 'Éclairage public (' + n(d.lampadaires) + ')', layer: lamp, on: false, group: G,
        swatch: '<span class="swatch dot" style="background:' + LUMIERE + '"></span>', legend: LEGENDE_LAMPADAIRES });
      A.addOverlay({ name: 'Bornes-fontaines (' + n(d.bornes) + ')', layer: bornes, on: true, group: G,
        swatch: '<span class="swatch dot" style="background:' + BORNE + '"></span>', legend: LEGENDE_BORNES });
    }).catch(function () { /* données des réseaux pas encore publiées */ });
  }
  // espace agents : couches gérées par js/reseaux.js ; la couche publique sert aux agents sans ce service
  if (document.getElementById('tab-res')) (window.LabeCartesPubliques = window.LabeCartesPubliques || {}).res = publique;
  else publique();
})();
