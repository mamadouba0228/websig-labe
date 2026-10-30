/* Modification de la forme des objets (déplacer, ajouter, supprimer des sommets) et
 * propositions de correction de la carte de référence (bâti, voirie), validées par un superviseur. */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc;
  var COULEUR = '#f2c230';

  // ---------- Éditeur de sommets ----------
  // geometry : Point, LineString ou Polygon (GeoJSON) ; opts : { label, onSave(geometry), onCancel }
  var ed = null;
  var boite = document.createElement('div');
  boite.className = 'measure-box edit-box hidden';
  document.body.appendChild(boite);
  L.DomEvent.disableClickPropagation(boite);

  function versLatLngs(g) {
    if (g.type === 'Point') return [L.latLng(g.coordinates[1], g.coordinates[0])];
    var c = g.type === 'Polygon' ? g.coordinates[0].slice(0, -1) : g.coordinates;
    return c.map(function (x) { return L.latLng(x[1], x[0]); });
  }
  function versGeometrie(type, pts) {
    var c = pts.map(function (p) { return [+p.lng.toFixed(7), +p.lat.toFixed(7)]; });
    if (type === 'Point') return { type: 'Point', coordinates: c[0] };
    if (type === 'LineString') return { type: 'LineString', coordinates: c };
    return { type: 'Polygon', coordinates: [c.concat([c[0]])] };
  }
  function icone(cls) { return L.divIcon({ className: 'edit-vertex ' + cls, iconSize: [16, 16], iconAnchor: [8, 8] }); }

  function editer(geometry, opts) {
    arreter();
    if (geometry.type === 'MultiPolygon') geometry = { type: 'Polygon', coordinates: geometry.coordinates[0] };
    if (geometry.type === 'MultiLineString') geometry = { type: 'LineString', coordinates: geometry.coordinates[0] };
    ed = { type: geometry.type, pts: versLatLngs(geometry), opts: opts || {}, layer: L.layerGroup().addTo(map), annuler: [], choisi: -1 };
    if (window.innerWidth < 700) document.body.classList.add('collapsed');
    var b = L.latLngBounds(ed.pts);
    if (!map.getBounds().contains(b)) map.fitBounds(b, { padding: [60, 60], maxZoom: 19 });
    dessiner();
  }
  function memoriser() { ed.annuler.push(ed.pts.map(function (p) { return L.latLng(p.lat, p.lng); })); }
  function dessiner() {
    var L0 = ed.layer, pts = ed.pts, ferme = ed.type === 'Polygon';
    L0.clearLayers();
    if (ed.type === 'LineString') L.polyline(pts, { color: COULEUR, weight: 4, interactive: false }).addTo(L0);
    if (ferme) L.polygon(pts, { color: COULEUR, weight: 3, fillOpacity: 0.15, interactive: false }).addTo(L0);
    pts.forEach(function (p, i) {
      var m = L.marker(p, { icon: icone(i === ed.choisi ? 'choisi' : ''), draggable: true, keyboard: false, zIndexOffset: 1000 }).addTo(L0);
      m.on('dragstart', function () { memoriser(); });
      m.on('drag', function (e) {
        pts[i] = e.target.getLatLng();
        L0.eachLayer(function (l) { if (l.setLatLngs) l.setLatLngs(pts); });
      });
      m.on('dragend', function () { ed.choisi = i; dessiner(); });
      m.on('click', function (e) { L.DomEvent.stop(e); ed.choisi = ed.choisi === i ? -1 : i; dessiner(); });
    });
    // poignées « + » au milieu des segments pour ajouter un sommet
    if (ed.type !== 'Point') {
      var n = pts.length;
      for (var i = 0; i < n - (ferme ? 0 : 1); i++) {
        (function (i) {
          var a = pts[i], b = pts[(i + 1) % n];
          var mil = L.marker(L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2), { icon: icone('milieu'), draggable: true, keyboard: false, zIndexOffset: 900 }).addTo(L0);
          function inserer(ll) { memoriser(); pts.splice(i + 1, 0, ll); ed.choisi = i + 1; dessiner(); }
          mil.on('click', function (e) { L.DomEvent.stop(e); inserer(mil.getLatLng()); });
          mil.on('dragend', function () { inserer(mil.getLatLng()); });
        })(i);
      }
    }
    var min = { Point: 1, LineString: 2, Polygon: 3 }[ed.type];
    var mesure = ed.type === 'LineString' ? ' · ' + A.fmtLen(A.lineLength(pts)) : ferme ? ' · ' + A.fmtArea(A.polygonArea(pts)) : '';
    boite.innerHTML = '<span><b>' + esc(ed.opts.label || 'Modifier la forme') + '</b>' + mesure + '<br><small>' +
      (ed.type === 'Point' ? 'Faites glisser le point.' : 'Faites glisser les sommets ; « + » pour en ajouter ; touchez un sommet pour le supprimer.') +
      '</small></span> ' +
      (ed.choisi >= 0 && pts.length > min ? '<button data-a="suppr" class="danger">Supprimer le sommet</button> ' : '') +
      '<button data-a="undo"' + (ed.annuler.length ? '' : ' disabled') + '>↶</button> ' +
      '<button data-a="ok" class="primary">Enregistrer</button> <button data-a="x" title="Annuler (Échap)">✕</button>';
    boite.classList.remove('hidden');
  }
  boite.addEventListener('click', function (e) {
    var a = e.target.dataset.a;
    if (!a || !ed) return;
    if (a === 'suppr') { memoriser(); ed.pts.splice(ed.choisi, 1); ed.choisi = -1; dessiner(); }
    if (a === 'undo' && ed.annuler.length) { ed.pts = ed.annuler.pop(); ed.choisi = -1; dessiner(); }
    if (a === 'x') { var cb = ed.opts.onCancel; arreter(); if (cb) cb(); }
    if (a === 'ok') {
      var g = versGeometrie(ed.type, ed.pts), save = ed.opts.onSave;
      arreter();
      if (save) save(g);
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ed) arreter(); });
  function arreter() {
    if (!ed) return;
    map.removeLayer(ed.layer);
    ed = null;
    boite.classList.add('hidden');
  }

  // ---------- Corrections de la carte de référence ----------
  var COUCHES = { 'Bâti': 'batiments', 'Voirie (tronçons OSM)': 'routes' };
  function gidDe(feature) {
    if (feature.properties && feature.properties.gid != null) return +feature.properties.gid;
    var m = /\.(\d+)$/.exec(feature.id || '');
    return m ? +m[1] : null;
  }
  function peutCorriger(r) { return !!(COUCHES[r.couche] && r.feature.geometry && gidDe(r.feature)); }
  // r : résultat de l'outil ⓘ ; action : 'forme' | 'supprimer'
  function corriger(r, action) {
    var couche = COUCHES[r.couche], gid = gidDe(r.feature), bati = couche === 'batiments';
    var ref = { couche: couche, gid: gid };
    if (action === 'supprimer') {
      return LabeContrib.nouvelle(r.feature.geometry.type.indexOf('Multi') === 0
        ? { type: r.feature.geometry.type.slice(5), coordinates: r.feature.geometry.coordinates[0] } : r.feature.geometry,
        { categorie: 'Correction de la carte', type: bati ? 'Bâtiment démoli' : 'Voie disparue', ref: ref });
    }
    editer(r.feature.geometry, {
      label: (bati ? 'Bâtiment' : 'Tronçon') + ' n° ' + gid + ' : nouvelle forme',
      onSave: function (g) {
        LabeContrib.nouvelle(g, { categorie: 'Correction de la carte', type: bati ? 'Bâtiment à modifier' : 'Voie à modifier', ref: ref });
      }
    });
  }

  window.LabeEdition = { editer: editer, arreter: arreter, peutCorriger: peutCorriger, corriger: corriger };
})();
