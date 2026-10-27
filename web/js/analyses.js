/* Analyses spatiales : isochrones (zones atteignables en X minutes par le réseau de rues)
 * et tampons (zones à moins de X mètres). Les deux reposent sur un champ calculé sur une grille fine
 * (temps ou distance), dont les contours sont tracés par d3-contour. Calcul dans le navigateur. */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc;
  var KX = 111320 * Math.cos(11.32 * Math.PI / 180), KY = 110574;
  var HORS_RESEAU_M = 100;       // marche à pied possible entre la rue et le bâtiment
  var MAX_CELLS = 4e6;
  // Couleurs séquentielles (une teinte, du plus proche = foncé au plus loin = clair)
  var BLEUS = ['#1864ab', '#1c7ed6', '#4dabf7', '#a5d8ff', '#d0ebff'];
  var ORANGES = ['#d9480f', '#f76707', '#ff922b', '#ffc078', '#ffe8cc'];

  function $(id) { return document.getElementById(id); }
  function nombres(txt, max) {
    var v = String(txt).split(/[;,\s]+/).map(Number).filter(function (x) { return x > 0 && isFinite(x); });
    v = v.filter(function (x, i) { return v.indexOf(x) === i; }).sort(function (a, b) { return a - b; });
    return v.slice(0, max || 5);
  }
  function toM(c) { return [c[0] * KX, c[1] * KY]; }

  // ---------- Grille ----------
  function Grid(bb, cell) {
    while (((bb[2] - bb[0]) / cell) * ((bb[3] - bb[1]) / cell) > MAX_CELLS) cell *= 1.25;
    this.cell = cell; this.x0 = bb[0]; this.y0 = bb[1];
    this.w = Math.max(2, Math.ceil((bb[2] - bb[0]) / cell) + 1);
    this.h = Math.max(2, Math.ceil((bb[3] - bb[1]) / cell) + 1);
    this.v = new Float32Array(this.w * this.h).fill(Infinity);
  }
  Grid.prototype.at = function (px, py) {
    var i = Math.floor((px - this.x0) / this.cell + 0.5), j = Math.floor((py - this.y0) / this.cell + 0.5);
    return i < 0 || j < 0 || i >= this.w || j >= this.h ? Infinity : this.v[j * this.w + i];
  };
  // valeur = base + distance × parMetre, dans un rayon R autour d'un point
  Grid.prototype.splat = function (px, py, base, parMetre, R) {
    var c = this.cell, i0 = Math.max(0, Math.floor((px - R - this.x0) / c)), i1 = Math.min(this.w - 1, Math.ceil((px + R - this.x0) / c));
    var j0 = Math.max(0, Math.floor((py - R - this.y0) / c)), j1 = Math.min(this.h - 1, Math.ceil((py + R - this.y0) / c));
    for (var j = j0; j <= j1; j++) {
      var dy = this.y0 + j * c - py, row = j * this.w;
      for (var i = i0; i <= i1; i++) {
        var dx = this.x0 + i * c - px, d = Math.sqrt(dx * dx + dy * dy);
        if (d > R) continue;
        var val = base + d * parMetre;
        if (val < this.v[row + i]) this.v[row + i] = val;
      }
    }
  };
  // distance à un segment (pour les tampons)
  Grid.prototype.segment = function (a, b, R) {
    var c = this.cell, i0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - R - this.x0) / c)), i1 = Math.min(this.w - 1, Math.ceil((Math.max(a[0], b[0]) + R - this.x0) / c));
    var j0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - R - this.y0) / c)), j1 = Math.min(this.h - 1, Math.ceil((Math.max(a[1], b[1]) + R - this.y0) / c));
    var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    for (var j = j0; j <= j1; j++) {
      var py = this.y0 + j * c, row = j * this.w;
      for (var i = i0; i <= i1; i++) {
        var px = this.x0 + i * c;
        var t = l2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
        var d = Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
        if (d <= R && d < this.v[row + i]) this.v[row + i] = d;
      }
    }
  };
  // intérieur d'un polygone = distance 0
  Grid.prototype.fill = function (ringM) {
    var bb = [Infinity, Infinity, -Infinity, -Infinity];
    ringM.forEach(function (p) { bb[0] = Math.min(bb[0], p[0]); bb[1] = Math.min(bb[1], p[1]); bb[2] = Math.max(bb[2], p[0]); bb[3] = Math.max(bb[3], p[1]); });
    var c = this.cell;
    for (var j = Math.max(0, Math.floor((bb[1] - this.y0) / c)); j <= Math.min(this.h - 1, Math.ceil((bb[3] - this.y0) / c)); j++) {
      for (var i = Math.max(0, Math.floor((bb[0] - this.x0) / c)); i <= Math.min(this.w - 1, Math.ceil((bb[2] - this.x0) / c)); i++) {
        var x = this.x0 + i * c, y = this.y0 + j * c, inside = false;
        for (var a = 0, b = ringM.length - 1; a < ringM.length; b = a++) {
          if ((ringM[a][1] > y) !== (ringM[b][1] > y) && x < (ringM[b][0] - ringM[a][0]) * (y - ringM[a][1]) / (ringM[b][1] - ringM[a][1]) + ringM[a][0]) inside = !inside;
        }
        if (inside) this.v[j * this.w + i] = 0;
      }
    }
  };
  // Contours « valeur ≤ seuil » → MultiPolygon GeoJSON (lon/lat)
  Grid.prototype.contours = function (seuils) {
    var g = this, vals = new Float64Array(this.v.length);
    for (var k = 0; k < vals.length; k++) vals[k] = isFinite(this.v[k]) ? -this.v[k] : -1e12;
    return d3.contours().size([this.w, this.h]).smooth(true).thresholds(seuils.map(function (s) { return -s; }))(vals)
      .map(function (ct, k) {
        var coords = ct.coordinates.map(function (poly) { return poly.map(function (ring) {
          return ring.map(function (p) { return [+((g.x0 + (p[0] - 0.5) * g.cell) / KX).toFixed(6), +((g.y0 + (p[1] - 0.5) * g.cell) / KY).toFixed(6)]; });
        }); });
        return { seuil: -ct.value, geometry: { type: 'MultiPolygon', coordinates: coords } };
      }).sort(function (a, b) { return a.seuil - b.seuil; });
  };
  Grid.prototype.surface = function (seuil) {
    var n = 0;
    for (var k = 0; k < this.v.length; k++) if (this.v[k] <= seuil) n++;
    return n * this.cell * this.cell;
  };

  // ---------- Affichage commun ----------
  var resLayer = L.featureGroup().addTo(map);
  var srcLayer = L.layerGroup().addTo(map);
  var last = null; // { type, zones: [{seuil, geometry}], unite }

  function dessiner(zones, couleurs, etiquette) {
    resLayer.clearLayers();
    // du plus grand au plus petit, pour que les zones proches restent visibles au-dessus
    zones.slice().reverse().forEach(function (z) {
      var k = zones.indexOf(z);
      L.geoJSON(z.geometry, { style: { color: couleurs[k], weight: 1.5, fillColor: couleurs[k], fillOpacity: 0.35 } })
        .bindTooltip(etiquette(z.seuil), { sticky: true }).addTo(resLayer);
    });
    if (resLayer.getLayers().length) map.fitBounds(resLayer.getBounds(), { padding: [30, 30] });
  }

  // Comptages : bâtiments (et adresses) selon la valeur de la grille à leur point représentatif
  function compter(grid, seuils) {
    var S = A.selection;
    return Promise.all([S.prepare('batiments'), S.prepare('adresses').catch(function () { return []; })]).then(function (r) {
      function par(items) {
        var res = seuils.map(function () { return []; }), hors = [];
        items.forEach(function (it) {
          var p = toM(it.rep), v = grid.at(p[0], p[1]), placed = false;
          for (var k = 0; k < seuils.length; k++) if (v <= seuils[k]) { res[k].push(it); placed = true; }
          if (!placed) hors.push(it);
        });
        return { dans: res, hors: hors, total: items.length };
      }
      return { bati: par(r[0]), adr: par(r[1]) };
    });
  }

  // part en %, avec une décimale sous 1 % (« 0,4 % » plutôt que « 0 % »)
  function pct(n, total) {
    var p = 100 * n / Math.max(total, 1);
    return (p > 0 && p < 1 ? A.fmt(p, 1) : A.fmt(Math.round(p))) + ' %';
  }
  function tableau(box, zones, couleurs, cnt, libelle, descDans, descHors, grid) {
    var b = cnt.bati, a = cnt.adr;
    var html = '<table class="ana-table"><thead><tr><th></th><th>Surface</th><th>Bâtiments</th>' + (a.total ? '<th>Adresses</th>' : '') + '<th></th></tr></thead><tbody>';
    zones.forEach(function (z, k) {
      html += '<tr><td><span class="swatch" style="background:' + couleurs[k] + '"></span> ' + esc(libelle(z.seuil)) + '</td>' +
        '<td>' + A.fmtArea(grid.surface(z.seuil)) + '</td>' +
        '<td><b>' + A.fmt(b.dans[k].length) + '</b> <small>' + pct(b.dans[k].length, b.total) + '</small></td>' +
        (a.total ? '<td>' + A.fmt(a.dans[k].length) + '</td>' : '') +
        '<td><button data-k="' + k + '" title="Lister ces bâtiments">Voir</button></td></tr>';
    });
    if (descHors) html += '<tr class="ana-hors"><td>' + esc(descHors) + '</td><td></td><td><b>' + A.fmt(b.hors.length) + '</b> <small>' + pct(b.hors.length, b.total) + '</small></td>' + (a.total ? '<td>' + A.fmt(a.hors.length) + '</td>' : '') +
      '<td><button data-k="hors">Voir</button></td></tr>';
    html += '</tbody></table><p class="hint">Pourcentages calculés sur les ' + A.fmt(b.total) + ' bâtiments de la commune (point central de chaque bâtiment).</p>';
    box.innerHTML = html;
    box.querySelectorAll('button[data-k]').forEach(function (btn) {
      btn.onclick = function () {
        var k = btn.dataset.k;
        if (k === 'hors') A.selection.afficher('batiments', b.hors, descHors);
        else A.selection.afficher('batiments', b.dans[+k], descDans(zones[+k].seuil));
      };
    });
  }

  function exporter(nom, prop) {
    if (!last) return;
    var fc = { type: 'FeatureCollection', features: last.zones.map(function (z) {
      var p = {}; p[prop] = last.unite === 'min' ? z.seuil / 60 : z.seuil;
      return { type: 'Feature', geometry: z.geometry, properties: Object.assign(p, last.props || {}) };
    }) };
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }));
    a.download = nom; a.click();
  }

  // ---------- Sous-onglets ----------
  document.querySelectorAll('.ana-switch button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.ana-switch button').forEach(function (x) { x.classList.toggle('active', x === b); });
      $('ana-iso').classList.toggle('hidden', b.dataset.ana !== 'iso');
      $('ana-buf').classList.toggle('hidden', b.dataset.ana !== 'buf');
    });
  });
  $('ana-clear').addEventListener('click', function () {
    resLayer.clearLayers(); srcLayer.clearLayers(); isoPoints = []; renderIsoPoints();
    $('iso-result').innerHTML = ''; $('buf-result').innerHTML = ''; last = null; bufDessin = null;
  });

  // =============================== ISOCHRONES ===============================
  var isoPoints = [];
  function renderIsoPoints() {
    srcLayer.clearLayers();
    var ul = $('iso-points'); ul.innerHTML = '';
    isoPoints.forEach(function (p, i) {
      L.circleMarker(p.latlng, { radius: 7, color: '#fff', weight: 2, fillColor: '#1864ab', fillOpacity: 1 }).addTo(srcLayer);
      var li = document.createElement('li');
      li.innerHTML = '<span>' + esc(p.label) + '</span>';
      var rm = document.createElement('button'); rm.textContent = '✕';
      rm.onclick = function () { isoPoints.splice(i, 1); renderIsoPoints(); };
      li.appendChild(rm); ul.appendChild(li);
    });
  }
  $('iso-pick').addEventListener('click', function () {
    A.startSketch('point', { label: 'Point de départ de l\'isochrone', onFinish: function (pts) {
      isoPoints.push({ latlng: pts[0], label: 'Point ' + (isoPoints.length + 1) }); renderIsoPoints();
    } });
  });
  $('iso-gps').addEventListener('click', function () {
    navigator.geolocation && navigator.geolocation.getCurrentPosition(function (p) {
      isoPoints.push({ latlng: L.latLng(p.coords.latitude, p.coords.longitude), label: 'Ma position' }); renderIsoPoints();
    }, function () { alert('Position introuvable.'); });
  });
  var isoSrc = $('iso-source');
  function majSourceIso() { $('iso-points-box').classList.toggle('hidden', isoSrc.value !== 'points'); }
  isoSrc.addEventListener('change', majSourceIso);
  // catégories d'équipements disponibles
  A.ready.then(function () { return A.selection.prepare('equipements'); }).then(function (items) {
    var cats = {};
    items.forEach(function (it) { cats[it.p.categorie] = (cats[it.p.categorie] || 0) + 1; });
    Object.keys(cats).sort().forEach(function (c) { isoSrc.add(new Option('Tous les équipements : ' + c + ' (' + cats[c] + ')', 'eq:' + c)); });
  }).catch(function () {});

  function sourcesIso() {
    var v = isoSrc.value;
    if (v === 'points') return Promise.resolve({ pts: isoPoints.map(function (p) { return p.latlng; }), desc: isoPoints.length + ' point(s)' });
    if (v === 'sel') {
      var r = A.selection.resultat();
      if (!r || !r.items.length) return Promise.reject(new Error('aucune sélection en cours (onglet « Sélection »)'));
      return Promise.resolve({ pts: r.items.slice(0, 500).map(function (it) { return L.latLng(it.rep[1], it.rep[0]); }), desc: 'la sélection (' + r.items.length + ')' });
    }
    var cat = v.slice(3);
    return A.selection.prepare('equipements').then(function (items) {
      var pts = items.filter(function (it) { return it.p.categorie === cat; }).map(function (it) { return L.latLng(it.rep[1], it.rep[0]); });
      return { pts: pts, desc: 'équipements « ' + cat + ' »' };
    });
  }

  $('iso-run').addEventListener('click', function () {
    var minutes = nombres($('iso-minutes').value, 5);
    if (!minutes.length) return alert('Indiquez au moins une durée, par exemple : 5, 10, 15');
    var mode = document.querySelector('input[name="iso-mode"]:checked').value;
    var btn = this; btn.disabled = true; btn.textContent = 'Calcul…';
    $('iso-result').innerHTML = '<p class="hint">Calcul en cours…</p>';
    var t0 = performance.now(), src;
    Promise.all([sourcesIso(), A.reseau.pret()]).then(function (r) {
      src = r[0];
      if (!src.pts.length) throw new Error('aucun point de départ : ajoutez un point ou choisissez une catégorie');
      if (isoSrc.value !== 'points') {
        srcLayer.clearLayers();
        src.pts.forEach(function (ll) { L.circleMarker(ll, { radius: 6, color: '#fff', weight: 2, fillColor: '#1864ab', fillOpacity: 1 }).addTo(srcLayer); });
      }
      var R = A.reseau, G = R.graphe(), walk = R.VITESSE_PIETON / 3.6;
      var snaps = [], init = [];
      src.pts.forEach(function (ll) { var s = R.accrocher(ll, mode); if (s) { snaps.push(s); init.push(s.d / walk); } });
      if (!snaps.length) throw new Error('aucun point de départ à moins de 400 m d\'une voie');
      var seuils = minutes.map(function (m) { return m * 60; }), Tmax = seuils[seuils.length - 1];
      var D = R.parcourir(snaps, mode, Tmax, init);
      // échantillons le long des rues atteintes (temps interpolé sur chaque tronçon)
      var samples = [], bb = [Infinity, Infinity, -Infinity, -Infinity], step = 25;
      function add(x, y, t) {
        samples.push(x, y, t);
        if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y;
      }
      G.seg.forEach(function (s) {
        var ta = D.dist[s.a], tb = D.dist[s.b];
        if (ta > Tmax && tb > Tmax) return;
        var c = R.cout(s, 1, mode);
        if (!isFinite(c)) return;
        var n = Math.max(1, Math.ceil(s.len / step));
        for (var k = 0; k <= n; k++) {
          var f = k / n, t = Math.min(ta + c * f * s.len, tb + c * (1 - f) * s.len);
          if (t <= Tmax) add(G.nx[s.a] + f * (G.nx[s.b] - G.nx[s.a]), G.ny[s.a] + f * (G.ny[s.b] - G.ny[s.a]), t);
        }
      });
      src.pts.forEach(function (ll) { var p = toM([ll.lng, ll.lat]); add(p[0], p[1], 0); });
      if (!samples.length) throw new Error('aucune rue atteinte');
      var grid = new Grid([bb[0] - HORS_RESEAU_M, bb[1] - HORS_RESEAU_M, bb[2] + HORS_RESEAU_M, bb[3] + HORS_RESEAU_M], 20);
      for (var i = 0; i < samples.length; i += 3) {
        var t = samples[i + 2], R2 = Math.min(HORS_RESEAU_M, (Tmax - t) * walk);
        if (R2 > 0) grid.splat(samples[i], samples[i + 1], t, 1 / walk, R2);
      }
      var zones = grid.contours(seuils);
      var lib = function (s) { return 'moins de ' + Math.round(s / 60) + ' min'; };
      dessiner(zones, BLEUS, function (s) { return lib(s) + (mode === 'pied' ? ' à pied' : ' en véhicule'); });
      last = { zones: zones, unite: 'min', props: { mode: mode === 'pied' ? 'à pied' : 'véhicule', depart: src.desc } };
      return compter(grid, seuils).then(function (cnt) {
        $('iso-result').innerHTML = '<p class="ana-head"><b>Accessibilité ' + (mode === 'pied' ? 'à pied' : 'en véhicule') + '</b> depuis ' + esc(src.desc) +
          ' <small class="muted">(' + Math.round(performance.now() - t0) + ' ms)</small></p><div id="iso-table"></div>' +
          '<p class="hint">Temps par les rues (' + (mode === 'pied' ? '4,5 km/h' : '12 à 45 km/h selon la voie') + ') + jusqu\'à ' + HORS_RESEAU_M +
          ' m à pied entre la rue et le bâtiment.</p><div class="row"><button id="iso-export">Exporter (GeoJSON)</button></div>';
        tableau($('iso-table'), zones, BLEUS, cnt, lib,
          function (s) { return 'bâtiments à moins de ' + Math.round(s / 60) + ' min ' + (mode === 'pied' ? 'à pied' : 'en véhicule') + ' de ' + src.desc; },
          'Au-delà de ' + minutes[minutes.length - 1] + ' min (non desservis)', grid);
        $('iso-export').onclick = function () { exporter('isochrones_labe.geojson', 'minutes'); };
      });
    }).catch(function (e) { $('iso-result').innerHTML = '<p class="form-msg">Calcul impossible : ' + esc(e.message) + '</p>'; })
      .then(function () { btn.disabled = false; btn.textContent = 'Calculer les isochrones'; });
  });

  // =============================== TAMPONS ===============================
  var bufSrc = $('buf-source'), bufVal = $('buf-value'), bufDessin = null;
  A.ready.then(function () {
    var L2 = A.selection.LAYERS;
    Object.keys(L2).forEach(function (k) { bufSrc.add(new Option(L2[k].label, 'layer:' + k)); });
  });
  bufSrc.addEventListener('change', function () {
    var v = bufSrc.value;
    bufVal.innerHTML = '<option value="">— tous les objets —</option>';
    bufVal.classList.toggle('hidden', v.indexOf('layer:') !== 0);
    $('buf-draw-box').classList.toggle('hidden', v.indexOf('draw:') !== 0);
    if (v.indexOf('layer:') !== 0) return;
    var key = v.slice(6), def = A.selection.LAYERS[key];
    var f = def.fields.filter(function (x) { return x[2] === 'liste' && x[0] !== 'quartier'; })[0];
    if (!f) return;
    A.selection.prepare(key).then(function (items) {
      var cnt = {};
      items.forEach(function (it) { var x = it.p[f[0]]; cnt[x] = (cnt[x] || 0) + 1; });
      Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; }).forEach(function (x) {
        bufVal.add(new Option(f[1] + ' : ' + x + ' (' + cnt[x] + ')', f[0] + '\u0001' + x));
      });
    });
  });
  $('buf-draw').addEventListener('click', function () {
    var mode = bufSrc.value.slice(5);
    A.startSketch(mode, { label: 'Objet autour duquel calculer le tampon', onFinish: function (pts) {
      var c = pts.map(function (p) { return [p.lng, p.lat]; });
      bufDessin = mode === 'point' ? { pts: c, lines: [] } : mode === 'line' ? { pts: c, lines: [c] } : { pts: c, lines: [c.concat([c[0]])], rings: [[c.concat([c[0]])]] };
      srcLayer.clearLayers();
      if (mode === 'point') L.circleMarker(pts[0], { radius: 6, color: '#d9480f' }).addTo(srcLayer);
      else (mode === 'line' ? L.polyline(pts, { color: '#d9480f', weight: 3 }) : L.polygon(pts, { color: '#d9480f', weight: 2 })).addTo(srcLayer);
      $('buf-draw-info').textContent = 'Objet dessiné.';
    } });
  });

  function sourcesBuf() {
    var v = bufSrc.value;
    if (v === 'sel') {
      var r = A.selection.resultat();
      if (!r || !r.items.length) return Promise.reject(new Error('aucune sélection en cours (onglet « Sélection »)'));
      return Promise.resolve({ geoms: r.items.map(function (it) { return it.g; }), desc: r.desc, poly: A.selection.LAYERS[r.key].geom === 'polygon' });
    }
    if (v.indexOf('draw:') === 0) {
      if (!bufDessin) return Promise.reject(new Error('dessinez d\'abord l\'objet'));
      return Promise.resolve({ geoms: [bufDessin], desc: 'l\'objet dessiné', poly: v === 'draw:area' });
    }
    var key = v.slice(6), def = A.selection.LAYERS[key], fv = bufVal.value.split('\u0001');
    return A.selection.prepare(key).then(function (items) {
      if (bufVal.value) items = items.filter(function (it) { return String(it.p[fv[0]]) === fv[1]; });
      return { geoms: items.map(function (it) { return it.g; }), desc: def.label.toLowerCase() + (bufVal.value ? ' (' + fv[1] + ')' : ''), poly: def.geom === 'polygon' };
    });
  }

  $('buf-run').addEventListener('click', function () {
    var dists = nombres($('buf-dist').value, 5);
    if (!dists.length) return alert('Indiquez au moins une distance en mètres, par exemple : 30 ou 50, 100');
    var btn = this; btn.disabled = true; btn.textContent = 'Calcul…';
    $('buf-result').innerHTML = '<p class="hint">Calcul en cours…</p>';
    var t0 = performance.now(), src;
    sourcesBuf().then(function (s) {
      src = s;
      if (!src.geoms.length) throw new Error('aucun objet source');
      var Dmax = dists[dists.length - 1], bb = [Infinity, Infinity, -Infinity, -Infinity];
      src.geoms.forEach(function (g) { g.pts.forEach(function (c) {
        var p = toM(c); bb[0] = Math.min(bb[0], p[0]); bb[1] = Math.min(bb[1], p[1]); bb[2] = Math.max(bb[2], p[0]); bb[3] = Math.max(bb[3], p[1]);
      }); });
      var grid = new Grid([bb[0] - Dmax - 20, bb[1] - Dmax - 20, bb[2] + Dmax + 20, bb[3] + Dmax + 20], Math.max(Dmax / 10, 2.5));
      src.geoms.forEach(function (g) {
        if (g.lines.length) g.lines.forEach(function (line) {
          for (var i = 1; i < line.length; i++) grid.segment(toM(line[i - 1]), toM(line[i]), Dmax);
        });
        else g.pts.forEach(function (c) { var p = toM(c); grid.segment(p, p, Dmax); });
        if (src.poly && g.rings) g.rings.forEach(function (rg) { grid.fill(rg[0].map(toM)); });
      });
      var zones = grid.contours(dists);
      var lib = function (d) { return 'moins de ' + A.fmt(d) + ' m'; };
      dessiner(zones, ORANGES, function (d) { return lib(d) + ' de ' + src.desc; });
      last = { zones: zones, unite: 'm', props: { autour_de: src.desc } };
      return compter(grid, dists).then(function (cnt) {
        $('buf-result').innerHTML = '<p class="ana-head"><b>Tampon</b> autour de ' + esc(src.desc) +
          ' <small class="muted">(' + A.fmt(src.geoms.length) + ' objet(s), ' + Math.round(performance.now() - t0) + ' ms, précision ≈ ' +
          A.fmt(grid.cell, 1) + ' m)</small></p><div id="buf-table"></div><div class="row"><button id="buf-export">Exporter (GeoJSON)</button></div>';
        tableau($('buf-table'), zones, ORANGES, cnt, lib,
          function (d) { return 'bâtiments à moins de ' + d + ' m de ' + src.desc; }, null, grid);
        $('buf-export').onclick = function () { exporter('tampons_labe.geojson', 'distance_m'); };
      });
    }).catch(function (e) { $('buf-result').innerHTML = '<p class="form-msg">Calcul impossible : ' + esc(e.message) + '</p>'; })
      .then(function () { btn.disabled = false; btn.textContent = 'Calculer le tampon'; });
  });
})();
