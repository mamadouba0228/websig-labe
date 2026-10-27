/* Filtre et sélection des données : requêtes attributaires (ET / OU), sélection spatiale
 * (zone dessinée, cercle, proximité d'une autre couche), tableau des résultats, répartition, exports.
 * Calcul dans le navigateur : fonctionne en mode serveur comme sur GitHub Pages. */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc;
  var MAX_ROWS = 300;

  // ---------- Catalogue des couches interrogeables ----------
  // type de champ : 'liste' (valeurs à cocher), 'texte', 'nombre'
  var LAYERS = {
    batiments: { label: 'Bâtiments', src: 'batiments', geom: 'polygon', title: function (p) { return p.nature === 'NC' ? 'Bâtiment' : p.nature; },
      fields: [['nature', 'Nature', 'liste'], ['surface_m2', 'Surface au sol (m²)', 'nombre'], ['quartier', 'Quartier', 'liste']] },
    routes: { label: 'Voirie (tronçons)', src: 'routes', geom: 'line', title: function (p) { return p.nom && p.nom !== 'NC' ? p.nom : p.nature; },
      fields: [['nature', 'Type de voie', 'liste'], ['nom', 'Nom', 'texte'], ['longueur_m', 'Longueur (m)', 'nombre'], ['quartier', 'Quartier', 'liste']] },
    voies: { label: 'Voies (adressage)', src: function () { return A.STATIC ? 'voies' : 'voies_publiques'; }, geom: 'line',
      title: function (p) { return p.libelle; },
      fields: [['code', 'Code', 'texte'], ['type_voie', 'Type', 'liste'], ['nom', 'Nom', 'texte'], ['statut_nom', 'Dénomination', 'liste'],
        ['quartier', 'Quartier', 'liste'], ['longueur_m', 'Longueur (m)', 'nombre']] },
    adresses: { label: 'Adresses', src: function () { return A.STATIC ? 'adresses' : 'adresses_publiques'; }, geom: 'point',
      title: function (p) { return p.libelle; },
      fields: [['libelle', 'Adresse', 'texte'], ['code_voie', 'Code de la voie', 'texte'], ['cote', 'Côté', 'liste'],
        ['statut', 'Statut', 'liste'], ['quartier', 'Quartier', 'liste']] },
    equipements: { label: 'Équipements (OSM)', src: 'equipements', geom: 'point', title: function (p) { return p.nom || p.nature; },
      fields: [['categorie', 'Catégorie', 'liste'], ['nature', 'Nature', 'liste'], ['nom', 'Nom', 'texte'], ['quartier', 'Quartier', 'liste']] },
    quartiers: { label: 'Quartiers', src: 'quartiers', geom: 'polygon', title: function (p) { return p.nom; },
      fields: [['nom', 'Nom', 'texte'], ['superficie_km2', 'Superficie (km²)', 'nombre'], ['nb_batiments', 'Bâtiments', 'nombre'],
        ['densite', 'Bâtiments / km²', 'nombre']] },
    cours_eau: { label: 'Cours d\'eau', src: 'cours_eau', geom: 'line', title: function (p) { return p.nom || 'Cours d\'eau'; },
      fields: [['nom', 'Nom', 'texte'], ['regime', 'Régime', 'liste'], ['longueur_m', 'Longueur (m)', 'nombre'], ['quartier', 'Quartier', 'liste']] }
  };
  var OPS = {
    liste: [['in', 'est parmi'], ['notin', 'n\'est pas parmi']],
    texte: [['contient', 'contient'], ['eq', '='], ['ne', '≠'], ['debut', 'commence par'], ['vide', 'est vide'], ['nonvide', 'n\'est pas vide']],
    nombre: [['gt', '>'], ['ge', '≥'], ['lt', '<'], ['le', '≤'], ['eq', '='], ['entre', 'entre']]
  };

  // ---------- Géométrie (projection locale en mètres) ----------
  var LAT0 = 11.32, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110574;
  function m(c) { return [c[0] * KX, c[1] * KY]; }
  function ringArea(r) {
    var a = 0;
    for (var i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * KX) * (r[i][1] * KY) - (r[i][0] * KX) * (r[j][1] * KY);
    return Math.abs(a / 2);
  }
  function lineLen(c) {
    var l = 0;
    for (var i = 1; i < c.length; i++) l += Math.hypot((c[i][0] - c[i - 1][0]) * KX, (c[i][1] - c[i - 1][1]) * KY);
    return l;
  }
  function inRing(x, y, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function segDist(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    var t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  // sommets (lon/lat) et lignes d'une géométrie quelconque
  function parts(g) {
    var t = g.type, c = g.coordinates || [];
    if (t === 'Point') return c.length ? { pts: [c], lines: [] } : { pts: [], lines: [] };
    if (t === 'MultiPoint') return { pts: c, lines: [] };
    if (t === 'LineString') return { pts: c, lines: [c] };
    if (t === 'MultiLineString') return { pts: [].concat.apply([], c), lines: c };
    if (t === 'Polygon') return c[0] && c[0].length ? { pts: c[0], lines: [c[0]], rings: [c] } : { pts: [], lines: [] };
    if (t === 'MultiPolygon') {
      var polys = c.filter(function (p) { return p && p[0] && p[0].length; });
      return { pts: [].concat.apply([], polys.map(function (p) { return p[0]; })), lines: polys.map(function (p) { return p[0]; }), rings: polys };
    }
    return { pts: [], lines: [] };
  }

  // ---------- Quartier d'un point (avec emprises pour aller vite) ----------
  var QIDX = null;
  function quartierIndex() {
    return A.loadOnce('quartiers').then(function (fc) {
      if (QIDX) return QIDX;
      QIDX = fc.features.map(function (f) {
        var polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
        var bb = [Infinity, Infinity, -Infinity, -Infinity];
        polys.forEach(function (p) { p[0].forEach(function (c) {
          bb[0] = Math.min(bb[0], c[0]); bb[1] = Math.min(bb[1], c[1]); bb[2] = Math.max(bb[2], c[0]); bb[3] = Math.max(bb[3], c[1]);
        }); });
        return { nom: f.properties.nom, polys: polys, bb: bb };
      });
      return QIDX;
    });
  }
  function quartierOf(c) {
    for (var i = 0; i < QIDX.length; i++) {
      var q = QIDX[i];
      if (c[0] < q.bb[0] || c[0] > q.bb[2] || c[1] < q.bb[1] || c[1] > q.bb[3]) continue;
      for (var j = 0; j < q.polys.length; j++) {
        var p = q.polys[j];
        if (inRing(c[0], c[1], p[0]) && !p.slice(1).some(function (h) { return inRing(c[0], c[1], h); })) return q.nom;
      }
    }
    return null;
  }

  // ---------- Préparation d'une couche : attributs calculés + point représentatif ----------
  var prepared = {};
  function prepare(key) {
    if (prepared[key]) return prepared[key];
    var def = LAYERS[key], src = typeof def.src === 'function' ? def.src() : def.src;
    prepared[key] = Promise.all([A.loadOnce(src), quartierIndex()]).then(function (r) {
      // les géométries vides ou incomplètes (ex. polygone réduit à rien par le découpage) sont ignorées
      return r[0].features.map(function (f) {
        if (!f.geometry || !f.geometry.coordinates) return null;
        var g = parts(f.geometry);
        if (!g.pts.length || !g.pts[0] || (def.geom !== 'point' && !(g.lines[0] && g.lines[0].length))) return null;
        var p = Object.assign({}, f.properties), rep;
        if (def.geom === 'point') rep = g.pts[0];
        else if (def.geom === 'line') {
          var l = g.lines[0]; rep = l[Math.floor(l.length / 2)];
          if (p.longueur_m == null) p.longueur_m = Math.round(g.lines.reduce(function (s, x) { return s + lineLen(x); }, 0));
        } else {
          var ring = g.lines[0], sx = 0, sy = 0, n = ring.length - 1 || 1;
          for (var i = 0; i < n; i++) { sx += ring[i][0]; sy += ring[i][1]; }
          rep = [sx / n, sy / n];
          if (key === 'batiments') p.surface_m2 = Math.round(g.rings.reduce(function (s, rg) { return s + ringArea(rg[0]); }, 0));
          if (key === 'quartiers') p.densite = p.superficie_km2 ? Math.round(p.nb_batiments / p.superficie_km2) : 0;
        }
        if (key !== 'quartiers' && p.quartier == null) p.quartier = quartierOf(rep);
        return { f: f, p: p, rep: rep, g: g };
      }).filter(Boolean);
    });
    return prepared[key];
  }

  // ---------- Index spatial en grille (pour « à moins de X m de… ») ----------
  function gridIndex(items, cell) {
    var grid = {};
    function add(i, j, v) { var k = i + ':' + j; (grid[k] = grid[k] || []).push(v); }
    items.forEach(function (it) {
      var segs = it.g.lines.length ? it.g.lines : [it.g.pts];
      segs.forEach(function (line) {
        if (line.length === 1) { var q = m(line[0]); add(Math.floor(q[0] / cell), Math.floor(q[1] / cell), [q, q]); return; }
        for (var s = 1; s < line.length; s++) {
          var a = m(line[s - 1]), b = m(line[s]);
          var i0 = Math.floor(Math.min(a[0], b[0]) / cell), i1 = Math.floor(Math.max(a[0], b[0]) / cell);
          var j0 = Math.floor(Math.min(a[1], b[1]) / cell), j1 = Math.floor(Math.max(a[1], b[1]) / cell);
          for (var i = i0; i <= i1; i++) for (var j = j0; j <= j1; j++) add(i, j, [a, b]);
        }
      });
    });
    return function near(p, d) {
      var i = Math.floor(p[0] / cell), j = Math.floor(p[1] / cell);
      for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) {
        var list = grid[(i + di) + ':' + (j + dj)];
        if (!list) continue;
        for (var k = 0; k < list.length; k++) if (segDist(p, list[k][0], list[k][1]) <= d) return true;
      }
      return false;
    };
  }

  // ---------- Interface : couche, conditions ----------
  function $(id) { return document.getElementById(id); }
  var selLayer = $('sel-layer'), condBox = $('sel-conds'), refLayer = $('sel-ref-layer');
  Object.keys(LAYERS).forEach(function (k) {
    selLayer.add(new Option(LAYERS[k].label, k));
    if (k !== 'quartiers' && k !== 'batiments' && k !== 'adresses') refLayer.add(new Option(LAYERS[k].label, k));
  });
  var current = null; // { key, items }
  var distinct = {};

  function distinctValues(items, field) {
    var cnt = {};
    items.forEach(function (it) { var v = it.p[field]; v = v == null || v === '' ? '(vide)' : String(v); cnt[v] = (cnt[v] || 0) + 1; });
    return Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a] || a.localeCompare(b); }).map(function (v) { return [v, cnt[v]]; });
  }

  function addCondition(preset) {
    if (!current) return;
    var def = LAYERS[current.key], row = document.createElement('div');
    row.className = 'sel-cond';
    var fSel = document.createElement('select');
    def.fields.forEach(function (f) { fSel.add(new Option(f[1], f[0])); });
    var oSel = document.createElement('select'), vBox = document.createElement('div'), rm = document.createElement('button');
    vBox.className = 'sel-val';
    rm.textContent = '✕'; rm.title = 'Retirer la condition'; rm.type = 'button';
    rm.onclick = function () { row.remove(); };
    function fieldType() { return def.fields.filter(function (f) { return f[0] === fSel.value; })[0][2]; }
    function renderOps() {
      oSel.innerHTML = '';
      OPS[fieldType()].forEach(function (o) { oSel.add(new Option(o[1], o[0])); });
      renderValue();
    }
    function renderValue() {
      var t = fieldType(), op = oSel.value;
      vBox.innerHTML = '';
      if (t === 'liste') {
        var key = current.key + '.' + fSel.value;
        var vals = distinct[key] || (distinct[key] = distinctValues(current.items, fSel.value));
        var ms = document.createElement('select');
        ms.multiple = true; ms.size = Math.min(6, Math.max(3, vals.length));
        vals.forEach(function (v) { ms.add(new Option(v[0] + ' (' + A.fmt(v[1]) + ')', v[0])); });
        vBox.appendChild(ms);
        var h = document.createElement('small'); h.className = 'muted'; h.textContent = 'Ctrl + clic pour en choisir plusieurs';
        vBox.appendChild(h);
      } else if (op !== 'vide' && op !== 'nonvide') {
        var i1 = document.createElement('input');
        i1.type = t === 'nombre' ? 'number' : 'text'; i1.step = 'any'; i1.placeholder = t === 'nombre' ? 'valeur' : 'texte';
        vBox.appendChild(i1);
        if (op === 'entre') {
          var i2 = document.createElement('input'); i2.type = 'number'; i2.step = 'any'; i2.placeholder = 'et';
          vBox.appendChild(i2);
        }
      }
    }
    fSel.onchange = renderOps; oSel.onchange = renderValue;
    var line = document.createElement('div'); line.className = 'sel-cond-line';
    line.appendChild(fSel); line.appendChild(oSel); line.appendChild(rm);
    row.appendChild(line); row.appendChild(vBox);
    condBox.appendChild(row);
    if (preset) fSel.value = preset;
    renderOps();
    row._read = function () {
      var t = fieldType(), ins = vBox.querySelectorAll('input'), ms = vBox.querySelector('select');
      return { field: fSel.value, type: t, op: oSel.value,
        values: ms ? Array.prototype.filter.call(ms.options, function (o) { return o.selected; }).map(function (o) { return o.value; }) : null,
        a: ins[0] ? ins[0].value : '', b: ins[1] ? ins[1].value : '',
        label: fSel.options[fSel.selectedIndex].text + ' ' + oSel.options[oSel.selectedIndex].text };
    };
  }

  function norm(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function test(c, p) {
    var v = p[c.field];
    if (c.type === 'liste') {
      var sv = v == null || v === '' ? '(vide)' : String(v), inList = c.values.indexOf(sv) >= 0;
      return c.op === 'in' ? inList : !inList;
    }
    if (c.type === 'texte') {
      var s = norm(v), q = norm(c.a);
      switch (c.op) {
        case 'contient': return s.indexOf(q) >= 0;
        case 'eq': return s === q;
        case 'ne': return s !== q;
        case 'debut': return s.indexOf(q) === 0;
        case 'vide': return v == null || v === '' || v === 'NC';
        case 'nonvide': return !(v == null || v === '' || v === 'NC');
      }
    }
    var x = Number(v), a = Number(c.a), b = Number(c.b);
    if (v == null || isNaN(x)) return false;
    switch (c.op) {
      case 'gt': return x > a; case 'ge': return x >= a; case 'lt': return x < a; case 'le': return x <= a;
      case 'eq': return x === a; case 'entre': return x >= Math.min(a, b) && x <= Math.max(a, b);
    }
    return true;
  }

  selLayer.addEventListener('change', function () { chooseLayer(selLayer.value); });
  function chooseLayer(key) {
    condBox.innerHTML = '';
    current = null;
    $('sel-builder').classList.add('hidden');
    if (!key) return;
    $('sel-status').textContent = 'Chargement de la couche…';
    prepare(key).then(function (items) {
      current = { key: key, items: items };
      $('sel-status').textContent = A.fmt(items.length) + ' objets dans la couche.';
      $('sel-builder').classList.remove('hidden');
      addCondition();
      renderGroupBy();
    }).catch(function (e) { $('sel-status').textContent = 'Couche indisponible : ' + e.message; });
  }
  $('sel-add-cond').addEventListener('click', function () { addCondition(); });

  // ---------- Contrainte spatiale ----------
  var zone = null; // { type: 'poly', ring: [[lon,lat]] } | { type: 'cercle', c: [lon,lat], r }
  var zoneLayer = L.layerGroup().addTo(map);
  function setZone(z) {
    zone = z;
    zoneLayer.clearLayers();
    if (z && z.type === 'poly') L.polygon(z.ring.map(function (c) { return [c[1], c[0]]; }), { color: '#e64980', weight: 2, dashArray: '6 4', fillOpacity: 0.05, interactive: false }).addTo(zoneLayer);
    if (z && z.type === 'cercle') L.circle([z.c[1], z.c[0]], { radius: z.r, color: '#e64980', weight: 2, dashArray: '6 4', fillOpacity: 0.05, interactive: false }).addTo(zoneLayer);
    $('sel-zone-info').textContent = !z ? 'Aucune zone.' : z.type === 'poly' ? 'Zone dessinée (' + (z.ring.length - 1) + ' sommets).' : 'Cercle de ' + A.fmt(z.r) + ' m.';
    $('sel-zone-clear').classList.toggle('hidden', !z);
  }
  $('sel-zone-poly').addEventListener('click', function () {
    A.startSketch('area', { label: 'Zone de sélection', onFinish: function (pts) {
      var ring = pts.map(function (p) { return [p.lng, p.lat]; }); ring.push(ring[0]);
      setZone({ type: 'poly', ring: ring });
    } });
  });
  $('sel-zone-circle').addEventListener('click', function () {
    var r = Number($('sel-radius').value) || 500;
    A.startSketch('point', { label: 'Centre du cercle (' + r + ' m)', onFinish: function (pts) {
      setZone({ type: 'cercle', c: [pts[0].lng, pts[0].lat], r: r });
    } });
  });
  $('sel-zone-clear').addEventListener('click', function (e) { e.preventDefault(); setZone(null); });

  // Proximité : filtre optionnel sur la couche de référence (ex. voirie de type « Voie rapide »)
  var refVal = $('sel-ref-value');
  refLayer.addEventListener('change', function () {
    refVal.innerHTML = '<option value="">— tous les objets —</option>';
    $('sel-ref-opts').classList.toggle('hidden', !refLayer.value);
    if (!refLayer.value) return;
    var def = LAYERS[refLayer.value], f = def.fields.filter(function (x) { return x[2] === 'liste' && x[0] !== 'quartier'; })[0];
    if (!f) return;
    prepare(refLayer.value).then(function (items) {
      distinctValues(items, f[0]).forEach(function (v) { refVal.add(new Option(f[1] + ' : ' + v[0] + ' (' + v[1] + ')', f[0] + '\u0001' + v[0])); });
    });
  });

  // ---------- Exécution ----------
  var hlLayer = L.featureGroup().addTo(map);
  var result = null; // { key, items, desc }
  $('sel-run').addEventListener('click', run);
  function run() {
    if (!current) return;
    var conds = Array.prototype.map.call(condBox.children, function (r) { return r._read(); })
      .filter(function (c) { return c.type !== 'liste' || c.values.length; });
    var mode = document.querySelector('input[name="sel-combine"]:checked').value;
    var btn = $('sel-run'); btn.disabled = true; btn.textContent = 'Recherche…';
    var refReady = refLayer.value ? prepare(refLayer.value) : Promise.resolve(null);
    refReady.then(function (refItems) {
      var near = null, dist = Number($('sel-ref-dist').value) || 50, refDesc = '';
      if (refItems) {
        var rv = refVal.value.split('\u0001');
        if (refVal.value) refItems = refItems.filter(function (it) { return String(it.p[rv[0]]) === rv[1]; });
        near = gridIndex(refItems, Math.max(dist, 50));
        refDesc = 'à moins de ' + dist + ' m de : ' + LAYERS[refLayer.value].label.toLowerCase() + (refVal.value ? ' (' + rv[1] + ')' : '');
      }
      var zr = zone && zone.type === 'poly' ? zone.ring : null, zc = zone && zone.type === 'cercle' ? m(zone.c) : null;
      var geom = LAYERS[current.key].geom;
      var out = current.items.filter(function (it) {
        if (conds.length) {
          var ok = mode === 'et' ? conds.every(function (c) { return test(c, it.p); }) : conds.some(function (c) { return test(c, it.p); });
          if (!ok) return false;
        }
        // pour une ligne, un sommet suffit ; sinon le point représentatif
        var probes = geom === 'line' ? it.g.pts : [it.rep];
        if (zr && !probes.some(function (c) { return inRing(c[0], c[1], zr); })) return false;
        if (zc && !probes.some(function (c) { var q = m(c); return Math.hypot(q[0] - zc[0], q[1] - zc[1]) <= zone.r; })) return false;
        if (near && !probes.some(function (c) { return near(m(c), dist); })) return false;
        return true;
      });
      var desc = conds.map(function (c) {
        return c.label + ' ' + (c.type === 'liste' ? c.values.join(', ') : c.op === 'entre' ? c.a + ' et ' + c.b : c.op === 'vide' || c.op === 'nonvide' ? '' : '« ' + c.a + ' »');
      }).join(mode === 'et' ? ' ET ' : ' OU ');
      if (zone) desc += (desc ? ' · ' : '') + (zone.type === 'poly' ? 'dans la zone dessinée' : 'dans un cercle de ' + zone.r + ' m');
      if (refDesc) desc += (desc ? ' · ' : '') + refDesc;
      showResult({ key: current.key, items: out, desc: desc || 'tous les objets' });
    }).catch(function (e) { alert('Sélection impossible : ' + e.message); })
      .then(function () { btn.disabled = false; btn.textContent = 'Appliquer la sélection'; });
  }

  // ---------- Résultats : carte + tableau ----------
  var drawer = $('sel-drawer'), sortField = null, sortDir = 1;
  function showResult(r) {
    result = r;
    r.items.forEach(function (it, i) { it._ri = i; });
    sortField = null;
    hlLayer.clearLayers();
    var def = LAYERS[r.key];
    var style = { color: '#e64980', weight: def.geom === 'line' ? 5 : 2, opacity: 0.9, fillColor: '#e64980', fillOpacity: 0.35 };
    L.geoJSON({ type: 'FeatureCollection', features: r.items.map(function (it) { return it.f; }) }, {
      style: style, interactive: false,
      pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 6, color: '#fff', weight: 1.5, fillColor: '#e64980', fillOpacity: 1, interactive: false }); }
    }).eachLayer(function (l) { hlLayer.addLayer(l); });
    // repère au centre des petits polygones (bâtiments), visibles même à petite échelle
    if (r.key === 'batiments') r.items.forEach(function (it) {
      hlLayer.addLayer(L.circleMarker([it.rep[1], it.rep[0]], { radius: 3.5, color: '#fff', weight: 1, fillColor: '#e64980', fillOpacity: 1, interactive: false }));
    });
    hlLayer.bringToFront();
    renderSummary();
    renderTable();
    drawer.classList.remove('hidden');
    document.body.classList.add('drawer-open');
    // le panneau du bas réduit la carte : cadrage après redimensionnement
    setTimeout(function () {
      map.invalidateSize();
      if (r.items.length) map.fitBounds(hlLayer.getBounds(), { padding: [30, 30], maxZoom: 17 });
    }, 80);
  }
  function renderSummary() {
    var r = result, def = LAYERS[r.key], total = '';
    if (def.geom === 'line') total = ' · ' + A.fmtLen(r.items.reduce(function (s, it) { return s + (it.p.longueur_m || 0); }, 0));
    if (r.key === 'batiments') total = ' · ' + A.fmtArea(r.items.reduce(function (s, it) { return s + it.p.surface_m2; }, 0)) + ' au sol';
    $('sel-summary').innerHTML = '<b>' + A.fmt(r.items.length) + '</b> ' + esc(def.label.toLowerCase()) + total +
      ' <span class="muted">— ' + esc(r.desc) + '</span>';
    // répartition (une seule série → une seule couleur)
    var gf = $('sel-groupby').value, box = $('sel-groups');
    if (!gf || !r.items.length) { box.innerHTML = ''; return; }
    var vals = distinctValues(r.items, gf).slice(0, 12), max = vals.length ? vals[0][1] : 1;
    box.innerHTML = vals.map(function (v) {
      return '<div class="bar-row" title="' + esc(v[0]) + ' : ' + v[1] + ' (' + Math.round(100 * v[1] / r.items.length) + ' %)"><div class="lbl"><span>' +
        esc(v[0]) + '</span><span>' + A.fmt(v[1]) + '</span></div><div class="bar"><div style="width:' + (100 * v[1] / max).toFixed(1) + '%"></div></div></div>';
    }).join('');
  }
  function renderGroupBy() {
    var gb = $('sel-groupby'), def = LAYERS[current.key];
    gb.innerHTML = '<option value="">Répartition par…</option>';
    def.fields.filter(function (f) { return f[2] === 'liste'; }).forEach(function (f) { gb.add(new Option('Répartition par ' + f[1].toLowerCase(), f[0])); });
  }
  $('sel-groupby').addEventListener('change', function () { if (result) renderSummary(); });

  function renderTable() {
    var r = result, def = LAYERS[r.key], rows = r.items.slice();
    if (sortField) rows.sort(function (a, b) {
      var x = a.p[sortField], y = b.p[sortField];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sortDir;
      return String(x == null ? '' : x).localeCompare(String(y == null ? '' : y), 'fr', { numeric: true }) * sortDir;
    });
    var cols = def.fields;
    var html = '<table class="data-table"><thead><tr><th>#</th><th>Objet</th>' + cols.map(function (c) {
      return '<th data-sort="' + c[0] + '">' + esc(c[1]) + (sortField === c[0] ? (sortDir > 0 ? ' ▲' : ' ▼') : '') + '</th>';
    }).join('') + '</tr></thead><tbody>';
    rows.slice(0, MAX_ROWS).forEach(function (it, i) {
      html += '<tr data-i="' + it._ri + '"><td>' + (i + 1) + '</td><td>' + esc(def.title(it.p) || '') + '</td>' +
        cols.map(function (c) { var v = it.p[c[0]]; return '<td>' + esc(typeof v === 'number' ? A.fmt(v, 2) : v == null ? '' : v) + '</td>'; }).join('') + '</tr>';
    });
    html += '</tbody></table>';
    if (rows.length > MAX_ROWS) html += '<p class="hint">' + MAX_ROWS + ' premières lignes affichées sur ' + A.fmt(rows.length) + ' : exportez pour tout obtenir.</p>';
    if (!rows.length) html = '<p class="hint">Aucun objet ne correspond.</p>';
    $('sel-table').innerHTML = html;
  }
  $('sel-table').addEventListener('click', function (e) {
    var th = e.target.closest('th[data-sort]');
    if (th) {
      sortDir = sortField === th.dataset.sort ? -sortDir : 1;
      sortField = th.dataset.sort;
      return renderTable();
    }
    var tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    var it = result.items[+tr.dataset.i], l = L.geoJSON(it.f);
    var b = l.getBounds();
    if (b.getNorthEast().equals(b.getSouthWest())) map.flyTo(b.getCenter(), 18); else map.flyToBounds(b, { maxZoom: 18, padding: [40, 40] });
    var flash = L.geoJSON(it.f, { style: { color: '#ffd43b', weight: 7, fillOpacity: 0.5 },
      pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 11, color: '#ffd43b', weight: 4, fillOpacity: 0 }); }, interactive: false }).addTo(map);
    setTimeout(function () { map.removeLayer(flash); }, 3000);
  });

  // ---------- Exports ----------
  function download(content, name, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: type }));
    a.download = name; a.click();
  }
  $('sel-csv').addEventListener('click', function () {
    if (!result) return;
    var def = LAYERS[result.key], cols = def.fields;
    var q = function (v) { v = v == null ? '' : String(v); return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [['objet'].concat(cols.map(function (c) { return c[1]; }), ['latitude', 'longitude']).map(q).join(';')];
    result.items.forEach(function (it) {
      lines.push([def.title(it.p)].concat(cols.map(function (c) { return it.p[c[0]]; }), [it.rep[1].toFixed(6), it.rep[0].toFixed(6)]).map(q).join(';'));
    });
    download('﻿' + lines.join('\r\n'), 'selection_' + result.key + '.csv', 'text/csv;charset=utf-8');
  });
  $('sel-geojson').addEventListener('click', function () {
    if (!result) return;
    var fc = { type: 'FeatureCollection', features: result.items.map(function (it) {
      return { type: 'Feature', geometry: it.f.geometry, properties: it.p };
    }) };
    download(JSON.stringify(fc), 'selection_' + result.key + '.geojson', 'application/geo+json');
  });
  $('sel-zoom').addEventListener('click', function () { if (hlLayer.getLayers().length) map.fitBounds(hlLayer.getBounds(), { padding: [30, 30] }); });
  function closeDrawer() {
    drawer.classList.add('hidden');
    document.body.classList.remove('drawer-open');
    setTimeout(function () { map.invalidateSize(); }, 50);
  }
  $('sel-close').addEventListener('click', closeDrawer);
  $('sel-reset').addEventListener('click', function () {
    hlLayer.clearLayers(); setZone(null); result = null; closeDrawer();
    refLayer.value = ''; refLayer.dispatchEvent(new Event('change'));
    if (current) { condBox.innerHTML = ''; addCondition(); }
  });
})();
