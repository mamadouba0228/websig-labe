/* Outil ⓘ « Identifier des entités » (comme dans QGIS) : un clic interroge toutes les couches visibles
 * autour du point (tolérance en pixels) et liste les entités trouvées, couche par couche, avec leurs attributs. */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc;
  var TOLERANCE_PX = 8;

  // Libellés des attributs les plus courants (les autres sont affichés tels quels)
  var LIBELLES = {
    nature: 'Nature', nom: 'Nom', numero: 'Numéro', cl_admin: 'Classe administrative', regime: 'Régime',
    categorie: 'Catégorie', type: 'Type', code: 'Code', type_voie: 'Type de voie', statut_nom: 'Dénomination',
    quartier: 'Quartier', libelle: 'Libellé', longueur_m: 'Longueur (m)', superficie_km2: 'Superficie (km²)',
    nb_batiments: 'Bâtiments', num: 'Numéro', cote: 'Côté', statut: 'Statut', code_voie: 'Code de la voie',
    description: 'Description', auteur: 'Saisi par', service: 'Service', cree_le: 'Créé le', date: 'Date',
    modifie_le: 'Modifié le', valide_par_nom: 'Validé par', motif_rejet: 'Motif du rejet', deliberation: 'Délibération',
    nb_proposees: 'Adresses proposées', nb_validees: 'Adresses validées', nb_posees: 'Plaques posées',
    complement: 'Complément', name: 'Nom', area_km2: 'Superficie (km²)', suffixe: 'Suffixe'
  };
  var MASQUES = { photo_url: 1, cree_par: 1, voie_id: 1, batiment_gid: 1, a_photo: 1 };

  // ---------- Tests d'intersection en pixels ----------
  function flat(ll) { // aplatit les tableaux imbriqués de LatLng (Multi*)
    var out = [];
    (function walk(a) { if (!a.length) return; if (a[0] instanceof L.LatLng) out.push(a); else a.forEach(walk); })(ll);
    return out;
  }
  function inRingPx(p, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if ((ring[i].y > p.y) !== (ring[j].y > p.y) && p.x < (ring[j].x - ring[i].x) * (p.y - ring[i].y) / (ring[j].y - ring[i].y) + ring[i].x) inside = !inside;
    }
    return inside;
  }
  // distance en pixels du clic à l'entité (0 = dedans pour une surface), ou Infinity
  function distancePx(l, p, clickBounds) {
    if (l.getLatLng) { // point (marqueur ou cercle)
      var q = map.latLngToContainerPoint(l.getLatLng());
      var r = l.getRadius ? l.getRadius() : 10;
      return Math.max(0, p.distanceTo(q) - r);
    }
    if (!l.getLatLngs || !l.getBounds) return Infinity;
    if (!clickBounds.intersects(l.getBounds())) return Infinity;
    var parts = flat(l.getLatLngs()), isPoly = l instanceof L.Polygon, best = Infinity;
    var pxParts = parts.map(function (part) { return part.map(function (ll) { return map.latLngToContainerPoint(ll); }); });
    pxParts.forEach(function (pts) {
      var n = pts.length;
      for (var i = 1; i < n + (isPoly ? 1 : 0); i++) {
        var a = pts[i - 1], b = pts[i % n];
        var d = L.LineUtil.pointToSegmentDistance(p, a, b);
        if (d < best) best = d;
      }
    });
    if (isPoly) {
      // dedans : anneau extérieur sans être dans un trou (approximation par parties)
      var inside = pxParts.some(function (pts) { return inRingPx(p, pts); });
      if (inside) return 0;
    }
    return best;
  }

  // ---------- Interrogation ----------
  function visible(entry) { return map.hasLayer(entry.parent || entry.couche); }
  function feuilles(groupe, out) {
    groupe.eachLayer(function (l) { if (l.eachLayer && !l.feature) feuilles(l, out); else out.push(l); });
    return out;
  }
  function interroger(latlng) {
    var p = map.latLngToContainerPoint(latlng);
    var t = TOLERANCE_PX, clickBounds = L.latLngBounds(map.containerPointToLatLng(p.subtract([t, t])), map.containerPointToLatLng(p.add([t, t])));
    var resultats = [];
    A.identifiables.forEach(function (entry) {
      if (!visible(entry)) return;
      feuilles(entry.couche, []).forEach(function (l) {
        if (!l.feature) return;
        var d = distancePx(l, p, clickBounds);
        if (d <= t) resultats.push({ couche: entry.nom, layer: l, feature: l.feature, d: d, rang: rang(l) });
      });
    });
    // bâtiment (calque à part : index sur la démo, GeoServer sur le serveur)
    var bati = !A.batiVisible() ? Promise.resolve(null)
      : A.STATIC ? Promise.resolve(A.batiAt(latlng)) : A.gfiBati(latlng).catch(function () { return null; });
    return bati.then(function (f) {
      if (f) resultats.push({ couche: 'Bâti', feature: f, d: 0, rang: 2 });
      // points d'abord, puis lignes, puis petites surfaces, puis grandes ; à rang égal, le plus proche
      resultats.sort(function (a, b) { return a.rang - b.rang || a.d - b.d; });
      return resultats;
    });
  }
  function rang(l) {
    if (l.getLatLng) return 0;
    if (l instanceof L.Polygon) return 3;
    return 1;
  }

  // ---------- Attributs ----------
  function titre(props, couche) {
    var t = props.libelle || props.nom || props.name || props.code || props.nature || props.categorie;
    if (couche === 'Quartiers' && props.nom) t = 'Quartier ' + props.nom;
    return t && t !== 'NC' ? t : couche;
  }
  function attributs(r) {
    var props = r.feature.properties || {}, rows = [];
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (MASQUES[k] || v == null || v === '' || v === 'NC') return;
      if (typeof v === 'number') v = A.fmt(v, 2);
      else if (/^\d{4}-\d{2}-\d{2}T/.test(v)) v = new Date(v).toLocaleString('fr-FR');
      rows.push([LIBELLES[k] || k, v]);
    });
    // mesures calculées
    var g = r.feature.geometry;
    if (g) {
      if (/LineString/.test(g.type) && r.layer) {
        var len = flat(r.layer.getLatLngs()).reduce(function (s, part) { return s + A.lineLength(part); }, 0);
        rows.push(['Longueur (calculée)', A.fmtLen(len)]);
      }
      if (/Polygon/.test(g.type)) {
        var area = A.polysOf(g).reduce(function (s, poly) {
          return s + A.polygonArea(poly[0].map(function (c) { return L.latLng(c[1], c[0]); }));
        }, 0);
        rows.push(['Surface (calculée)', A.fmtArea(area)]);
      }
      if (r.couche === 'Bâti') { var q = A.quartierAt(clicLatLng); if (q) rows.push(['Quartier', q]); }
    }
    return rows;
  }

  // ---------- Panneau de résultats ----------
  var panel = document.createElement('div');
  panel.className = 'identify-panel hidden';
  panel.innerHTML = '<div class="idf-head"><b>ⓘ Identification</b> <span id="idf-count"></span>' +
    '<button type="button" id="idf-close" title="Fermer">✕</button></div><div id="idf-body"></div>';
  document.body.appendChild(panel);
  L.DomEvent.disableClickPropagation(panel);
  L.DomEvent.disableScrollPropagation(panel);
  var body = panel.querySelector('#idf-body');
  var hl = L.layerGroup().addTo(map), marque = L.layerGroup().addTo(map), clicLatLng = null, derniers = [];

  function surligner(r, zoomer) {
    hl.clearLayers();
    if (!r.feature.geometry) return;
    var g = L.geoJSON(r.feature, {
      style: { color: '#f59f00', weight: 5, opacity: 0.95, fillColor: '#ffd43b', fillOpacity: 0.3 },
      pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 12, color: '#f59f00', weight: 4, fillOpacity: 0 }); },
      interactive: false
    }).addTo(hl);
    if (zoomer) {
      var b = g.getBounds();
      if (b.getNorthEast().equals(b.getSouthWest())) map.flyTo(b.getCenter(), Math.max(map.getZoom(), 17));
      else map.flyToBounds(b, { padding: [60, 60], maxZoom: 18 });
    }
  }
  function afficher(res) {
    derniers = res;
    panel.classList.remove('hidden');
    $('idf-count').textContent = res.length ? res.length + ' entité(s)' : '';
    if (!res.length) {
      body.innerHTML = '<p class="hint">Aucune entité à cet endroit dans les couches visibles. Cliquez plus près d\'un objet ou zoomez.</p>';
      hl.clearLayers();
      return;
    }
    var html = '', courante = null;
    res.forEach(function (r, i) {
      if (r.couche !== courante) {
        courante = r.couche;
        var n = res.filter(function (x) { return x.couche === courante; }).length;
        html += '<div class="idf-layer">' + esc(courante) + ' <small>(' + n + ')</small></div>';
      }
      var rows = attributs(r);
      html += '<details class="idf-item" data-i="' + i + '"' + (i === 0 ? ' open' : '') + '><summary>' + esc(titre(r.feature.properties || {}, r.couche)) +
        '</summary><table>' + rows.map(function (x) { return '<tr><td>' + esc(x[0]) + '</td><td>' + esc(x[1]) + '</td></tr>'; }).join('') +
        '</table><a href="#" class="idf-zoom" data-i="' + i + '">Zoomer sur l\'entité</a></details>';
    });
    body.innerHTML = html;
    surligner(res[0], false);
  }
  function $(id) { return document.getElementById(id); }
  body.addEventListener('click', function (e) {
    var z = e.target.closest('.idf-zoom');
    if (z) { e.preventDefault(); surligner(derniers[+z.dataset.i], true); return; }
    var d = e.target.closest('summary');
    if (d) surligner(derniers[+d.parentNode.dataset.i], false);
  });
  $('idf-close').addEventListener('click', function () { panel.classList.add('hidden'); hl.clearLayers(); marque.clearLayers(); });

  // ---------- Mode identification ----------
  var actif = false, btn = null;
  function onClic(e) {
    clicLatLng = e.latlng;
    marque.clearLayers();
    L.circleMarker(e.latlng, { radius: TOLERANCE_PX, color: '#f59f00', weight: 2, fill: false, interactive: false }).addTo(marque);
    body.innerHTML = '<p class="hint">Recherche…</p>';
    panel.classList.remove('hidden');
    interroger(e.latlng).then(afficher);
  }
  function activer(on) {
    actif = on;
    btn.classList.toggle('on', on);
    map.getContainer().classList.toggle('identify-cursor', on);
    if (on) { A.stopSketch(); A.capturerClic(onClic); }
    else { A.libererClic(onClic); marque.clearLayers(); }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && actif) activer(false); });

  var Ctrl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      var c = L.DomUtil.create('div', 'leaflet-bar tool-bar');
      btn = L.DomUtil.create('a', 'idf-btn', c);
      btn.href = '#'; btn.innerHTML = 'i'; btn.title = 'Identifier des entités (cliquez ensuite sur la carte) — Échap pour quitter';
      L.DomEvent.on(btn, 'click', function (ev) { L.DomEvent.stop(ev); activer(!actif); });
      L.DomEvent.disableClickPropagation(c);
      return c;
    }
  });
  var ctrl = new Ctrl();
  map.addControl(ctrl);
  // placé juste sous le zoom, en tête des outils
  var coin = ctrl.getContainer().parentNode;
  if (coin.children.length > 1) coin.insertBefore(ctrl.getContainer(), coin.children[1]);

  A.identification = { activer: activer, interroger: interroger };
})();
