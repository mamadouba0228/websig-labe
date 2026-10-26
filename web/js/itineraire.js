/* Itinéraires : plus court chemin sur le réseau de rues (Dijkstra), à pied ou en véhicule,
 * instructions avec les noms/codes des voies de l'adressage, tournée optimisée à étapes, export GPX.
 * Calcul entièrement dans le navigateur : fonctionne en mode serveur comme sur GitHub Pages. */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc;
  var MAX_ETAPES = 12, SNAP_MAX_M = 400;

  // Vitesses (km/h) — estimation en ville, Labé
  var VITESSE_VEHICULE = {
    'Voie rapide': 45, 'Route primaire': 40, 'Route secondaire': 35, 'Route tertiaire': 30,
    'Route non classifiée': 25, 'Route résidentielle': 20, 'Route d accès': 15, 'Chemin carrossable': 12
  };
  var VITESSE_PIETON = 4.5;
  var NOM_TYPE = {
    'Chemin non carrossable': 'le sentier', 'Chemin carrossable': 'la piste',
    'Route résidentielle': 'la rue sans nom', 'Route non classifiée': 'la voie sans nom', 'Route d accès': 'la voie d\'accès'
  };

  // ---------- Projection locale (mètres) ----------
  var LAT0 = 11.32, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110574;

  // ---------- Graphe ----------
  var G = null; // { nx[], ny[], adj[][], seg[] }
  function key(c) { return c[0] + ',' + c[1]; }

  function buildGraph(routes, voies) {
    // nom de chaque segment d'après les voies de l'adressage (mêmes sommets que la voirie)
    var nomSeg = {};
    (voies ? voies.features : []).forEach(function (f) {
      if (!f.geometry || f.geometry.type !== 'LineString') return;
      var c = f.geometry.coordinates, lib = f.properties.libelle;
      for (var i = 1; i < c.length; i++) {
        var k1 = key(c[i - 1]), k2 = key(c[i]);
        nomSeg[k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1] = lib;
      }
    });
    var ids = {}, nx = [], ny = [], adj = [], seg = [];
    function node(c) {
      var k = key(c), id = ids[k];
      if (id === undefined) { id = ids[k] = nx.length; nx.push(c[0] * KX); ny.push(c[1] * KY); adj.push([]); }
      return id;
    }
    routes.features.forEach(function (f) {
      var g = f.geometry; if (!g) return;
      var lines = g.type === 'MultiLineString' ? g.coordinates : g.type === 'LineString' ? [g.coordinates] : [];
      var p = f.properties, osmNom = p.nom && p.nom !== 'NC' ? p.nom : null;
      lines.forEach(function (c) {
        for (var i = 1; i < c.length; i++) {
          var a = node(c[i - 1]), b = node(c[i]);
          if (a === b) continue;
          var len = Math.hypot(nx[b] - nx[a], ny[b] - ny[a]);
          var k1 = key(c[i - 1]), k2 = key(c[i]);
          var nom = nomSeg[k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1] || osmNom || NOM_TYPE[p.nature] || 'la voie';
          var s = seg.length;
          seg.push({ a: a, b: b, len: len, nature: p.nature, nom: nom, ca: c[i - 1], cb: c[i] });
          adj[a].push(s); adj[b].push(s);
        }
      });
    });
    return { nx: nx, ny: ny, adj: adj, seg: seg };
  }

  // Durée (s) d'un segment selon le mode ; Infinity = interdit
  function cost(s, len, mode) {
    if (mode === 'pied') return len / (VITESSE_PIETON / 3.6);
    var v = VITESSE_VEHICULE[s.nature];
    return v ? len / (v / 3.6) : Infinity;
  }

  // Point le plus proche sur un segment autorisé
  function snap(latlng, mode) {
    var px = latlng.lng * KX, py = latlng.lat * KY, best = null;
    for (var i = 0; i < G.seg.length; i++) {
      var s = G.seg[i];
      if (cost(s, 1, mode) === Infinity) continue;
      var ax = G.nx[s.a], ay = G.ny[s.a], dx = G.nx[s.b] - ax, dy = G.ny[s.b] - ay;
      var t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
      var d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (!best || d < best.d) best = { s: i, t: t, d: d };
    }
    if (!best || best.d > SNAP_MAX_M) return null;
    var sg = G.seg[best.s];
    best.coord = [sg.ca[0] + best.t * (sg.cb[0] - sg.ca[0]), sg.ca[1] + best.t * (sg.cb[1] - sg.ca[1])];
    return best;
  }

  // Tas binaire minimal pour Dijkstra
  function Heap() { this.k = []; this.v = []; }
  Heap.prototype.push = function (key, val) {
    var k = this.k, v = this.v, i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      var tk = k[p]; k[p] = k[i]; k[i] = tk; var tv = v[p]; v[p] = v[i]; v[i] = tv; i = p;
    }
  };
  Heap.prototype.pop = function () {
    var k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv;
      var i = 0, n = k.length;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < n && k[l] < k[m]) m = l;
        if (r < n && k[r] < k[m]) m = r;
        if (m === i) break;
        var tk = k[m]; k[m] = k[i]; k[i] = tk; var tv = v[m]; v[m] = v[i]; v[i] = tv; i = m;
      }
    }
    return top;
  };
  Heap.prototype.size = function () { return this.k.length; };

  // Dijkstra depuis un point accroché au graphe ; renvoie distances et prédécesseurs (segment utilisé)
  function dijkstra(from, mode) {
    var n = G.nx.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
    var done = new Uint8Array(n), h = new Heap();
    var s0 = G.seg[from.s];
    var ca = cost(s0, from.t * s0.len, mode), cb = cost(s0, (1 - from.t) * s0.len, mode);
    dist[s0.a] = ca; dist[s0.b] = cb; h.push(ca, s0.a); h.push(cb, s0.b);
    while (h.size()) {
      var u = h.pop();
      if (done[u]) continue;
      done[u] = 1;
      var list = G.adj[u];
      for (var i = 0; i < list.length; i++) {
        var s = G.seg[list[i]], w = s.a === u ? s.b : s.a;
        var c = dist[u] + cost(s, s.len, mode);
        if (c < dist[w]) { dist[w] = c; prev[w] = list[i]; h.push(c, w); }
      }
    }
    return { dist: dist, prev: prev, from: from };
  }
  // Coût jusqu'à un point accroché (et nœud d'arrivée choisi)
  function costTo(D, to, mode) {
    var s = G.seg[to.s];
    var best = { c: D.dist[s.a] + cost(s, to.t * s.len, mode), node: s.a };
    var cb = D.dist[s.b] + cost(s, (1 - to.t) * s.len, mode);
    if (cb < best.c) best = { c: cb, node: s.b };
    if (to.s === D.from.s) { // même segment : trajet direct
      var cd = cost(s, Math.abs(to.t - D.from.t) * s.len, mode);
      if (cd <= best.c) best = { c: cd, node: -1 };
    }
    return best;
  }
  // Liste des tronçons parcourus (coordonnées, longueur, nom) entre deux points
  function pathTo(D, to, mode) {
    var end = costTo(D, to, mode), steps = [];
    var sTo = G.seg[to.s], sFrom = G.seg[D.from.s];
    if (end.node === -1) {
      steps.push({ c: [D.from.coord, to.coord], len: Math.abs(to.t - D.from.t) * sTo.len, nom: sTo.nom });
      return { cost: end.c, steps: steps };
    }
    // dernier morceau : du nœud d'arrivée au point
    steps.push({ c: [end.node === sTo.a ? sTo.ca : sTo.cb, to.coord], len: (end.node === sTo.a ? to.t : 1 - to.t) * sTo.len, nom: sTo.nom });
    var u = end.node;
    while (D.prev[u] !== -1) {
      var s = G.seg[D.prev[u]], w = s.a === u ? s.b : s.a;
      steps.push({ c: s.a === u ? [s.cb, s.ca] : [s.ca, s.cb], len: s.len, nom: s.nom });
      u = w;
    }
    // premier morceau : du point de départ au nœud d'origine
    steps.push({ c: [D.from.coord, u === sFrom.a ? sFrom.ca : sFrom.cb], len: (u === sFrom.a ? D.from.t : 1 - D.from.t) * sFrom.len, nom: sFrom.nom });
    steps.reverse();
    return { cost: end.c, steps: steps };
  }

  // ---------- Instructions pas à pas ----------
  function bearing(c1, c2) { return Math.atan2((c2[0] - c1[0]) * KX, (c2[1] - c1[1]) * KY) * 180 / Math.PI; }
  function instructions(steps) {
    var groups = [];
    steps.forEach(function (s) {
      if (s.len < 0.5) return;
      var g = groups[groups.length - 1];
      // petit tronçon sans nom (carrefour, rond-point) : rattaché au précédent
      if (g && (g.nom === s.nom || (s.nom === 'la voie' && s.len < 40))) { g.len += s.len; g.last = s.c; }
      else groups.push({ nom: s.nom, len: s.len, first: s.c, last: s.c });
    });
    return groups.map(function (g, i) {
      var txt;
      if (i === 0) txt = 'Partez par ' + g.nom;
      else {
        var p = groups[i - 1];
        var d = bearing(g.first[0], g.first[1]) - bearing(p.last[0], p.last[1]);
        d = ((d + 540) % 360) - 180;
        var ad = Math.abs(d), cote = d > 0 ? 'droite' : 'gauche';
        var verbe = ad < 25 ? 'Continuez tout droit sur ' : ad < 60 ? 'Tournez légèrement à ' + cote + ' sur ' :
          ad < 150 ? 'Tournez à ' + cote + ' sur ' : 'Faites demi-tour sur ';
        txt = verbe + g.nom;
      }
      return { texte: txt, len: g.len };
    });
  }

  // ---------- Tournée : ordre optimisé (plus proche voisin + 2-opt) ----------
  function optimiserOrdre(M, boucle) {
    var n = M.length, ordre = [0], reste = [];
    for (var i = 1; i < n; i++) reste.push(i);
    var fin = boucle ? null : n - 1;        // sans boucle, la dernière étape reste l'arrivée
    if (fin !== null) reste.splice(reste.indexOf(fin), 1);
    while (reste.length) {
      var u = ordre[ordre.length - 1], bi = 0;
      for (var j = 1; j < reste.length; j++) if (M[u][reste[j]] < M[u][reste[bi]]) bi = j;
      ordre.push(reste.splice(bi, 1)[0]);
    }
    if (fin !== null) ordre.push(fin);
    function total(o) {
      var t = 0;
      for (var i = 1; i < o.length; i++) t += M[o[i - 1]][o[i]];
      return boucle ? t + M[o[o.length - 1]][o[0]] : t;
    }
    var mieux = true, last = boucle ? ordre.length : ordre.length - 1;
    while (mieux) {
      mieux = false;
      for (var a = 1; a < last - 1; a++) for (var b = a + 1; b < last; b++) {
        var o2 = ordre.slice(0, a).concat(ordre.slice(a, b + 1).reverse(), ordre.slice(b + 1));
        if (total(o2) + 1e-6 < total(ordre)) { ordre = o2; mieux = true; }
      }
    }
    return ordre;
  }

  // ---------- État et interface ----------
  var etapes = []; // { latlng, label }
  var routeLayer = L.layerGroup().addTo(map), stopLayer = L.layerGroup().addTo(map);
  var lastResult = null;
  function $(id) { return document.getElementById(id); }
  function mode() { return document.querySelector('input[name="iti-mode"]:checked').value; }
  function fmtTemps(s) {
    var m = Math.max(1, Math.round(s / 60));
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0');
  }
  function lettre(i, n) { return i === 0 ? 'A' : i === n - 1 && !$('iti-boucle').checked ? 'B' : String(i); }

  var ready = null;
  function ensureGraph() {
    if (!ready) {
      ready = A.ready.then(function () {
        return Promise.all([A.loadOnce('routes'), A.loadOnce(A.STATIC ? 'voies' : 'voies_publiques').catch(function () { return null; })]);
      }).then(function (r) { G = buildGraph(r[0], r[1]); });
    }
    return ready;
  }

  function renderStops() {
    stopLayer.clearLayers();
    var ul = $('iti-etapes');
    ul.innerHTML = '';
    etapes.forEach(function (e, i) {
      var lab = lettre(i, etapes.length);
      L.marker(e.latlng, { draggable: true, zIndexOffset: 1000, icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 30],
        html: '<div class="iti-drop' + (i === 0 ? ' start' : '') + '"><span>' + lab + '</span></div>' }) })
        .on('dragend', function (ev) { e.latlng = ev.target.getLatLng(); e.label = 'Point sur la carte'; compute(); })
        .addTo(stopLayer);
      var li = document.createElement('li');
      li.innerHTML = '<span class="iti-pin small' + (i === 0 ? ' start' : '') + '">' + lab + '</span><span class="iti-lbl">' + esc(e.label) + '</span>';
      var up = document.createElement('button'); up.textContent = '↑'; up.title = 'Monter'; up.disabled = i === 0;
      up.onclick = function () { etapes.splice(i - 1, 0, etapes.splice(i, 1)[0]); compute(); };
      var rm = document.createElement('button'); rm.textContent = '✕'; rm.title = 'Retirer';
      rm.onclick = function () { etapes.splice(i, 1); compute(); };
      li.appendChild(up); li.appendChild(rm);
      ul.appendChild(li);
    });
    $('iti-vide').classList.toggle('hidden', etapes.length > 0);
    $('iti-actions').classList.toggle('hidden', etapes.length === 0);
  }

  function addStop(latlng, label, position) {
    if (etapes.length >= MAX_ETAPES) return alert(MAX_ETAPES + ' étapes au maximum.');
    var e = { latlng: L.latLng(latlng), label: label || 'Point sur la carte' };
    if (position === 'start') etapes.unshift(e);
    else if (position === 'end' || etapes.length < 2) etapes.push(e);
    else etapes.splice(etapes.length - 1, 0, e); // une nouvelle étape s'insère avant l'arrivée
    openTab();
    compute();
  }

  function compute() {
    renderStops();
    routeLayer.clearLayers();
    $('iti-result').innerHTML = '';
    lastResult = null;
    if (etapes.length < 2) return;
    $('iti-result').innerHTML = '<p class="hint">Calcul…</p>';
    ensureGraph().then(function () {
      var m = mode(), boucle = $('iti-boucle').checked;
      var snaps = etapes.map(function (e) { return snap(e.latlng, m); });
      var bad = snaps.indexOf(null);
      if (bad >= 0) {
        $('iti-result').innerHTML = '<p class="form-msg">L\'étape ' + lettre(bad, etapes.length) + ' est à plus de ' + SNAP_MAX_M +
          ' m d\'une voie praticable' + (m === 'vehicule' ? ' en véhicule' : '') + '.</p>';
        return;
      }
      var D = snaps.map(function (s) { return dijkstra(s, m); });
      var ordre = etapes.map(function (_, i) { return i; });
      if ($('iti-optim').checked && etapes.length > 2) {
        var M = snaps.map(function (_, i) { return snaps.map(function (t, j) { return i === j ? 0 : costTo(D[i], t, m).c; }); });
        ordre = optimiserOrdre(M, boucle);
        etapes = ordre.map(function (i) { return etapes[i]; });
        snaps = ordre.map(function (i) { return snaps[i]; });
        D = ordre.map(function (i) { return D[i]; });
      }
      renderStops();
      var legs = [];
      for (var i = 1; i < etapes.length; i++) legs.push([i - 1, i]);
      if (boucle) legs.push([etapes.length - 1, 0]);
      var all = [], totalT = 0, totalL = 0, html = '', unreachable = false;
      legs.forEach(function (lg, k) {
        var p = pathTo(D[lg[0]], snaps[lg[1]], m);
        if (!isFinite(p.cost)) { unreachable = true; return; }
        var len = p.steps.reduce(function (s, x) { return s + x.len; }, 0);
        totalT += p.cost; totalL += len;
        var coords = [];
        p.steps.forEach(function (st) { coords.push(st.c[0], st.c[1]); });
        all.push(coords);
        // trajets d'accès entre le point cliqué et la voie
        [[etapes[lg[0]].latlng, snaps[lg[0]].coord], [etapes[lg[1]].latlng, snaps[lg[1]].coord]].forEach(function (x) {
          L.polyline([x[0], [x[1][1], x[1][0]]], { color: '#1c7ed6', weight: 2, dashArray: '3 5', interactive: false }).addTo(routeLayer);
        });
        var ins = instructions(p.steps);
        html += '<div class="iti-leg"><b>' + lettre(lg[0], etapes.length) + ' → ' + (lg[1] === 0 && boucle ? 'A' : lettre(lg[1], etapes.length)) +
          '</b> · ' + A.fmtLen(len) + ' · ' + fmtTemps(p.cost) + '<ol>' +
          ins.map(function (x) { return '<li>' + esc(x.texte) + ' <small>' + A.fmtLen(x.len) + '</small></li>'; }).join('') + '</ol></div>';
      });
      if (unreachable) {
        $('iti-result').innerHTML = '<p class="form-msg">Une étape n\'est pas reliée au reste du réseau' + (m === 'vehicule' ? ' (essayez « à pied »)' : '') + '.</p>';
        return;
      }
      all.forEach(function (coords) {
        var ll = coords.map(function (c) { return [c[1], c[0]]; });
        L.polyline(ll, { color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(routeLayer);
        L.polyline(ll, { color: '#1c7ed6', weight: 5, opacity: 0.95, interactive: false }).addTo(routeLayer);
      });
      lastResult = { lignes: all, etapes: etapes.slice(), mode: m, longueur: totalL, duree: totalT };
      $('iti-result').innerHTML = '<div class="iti-total"><b>' + A.fmtLen(totalL) + '</b> · <b>' + fmtTemps(totalT) + '</b> ' +
        (m === 'pied' ? 'à pied' : 'en véhicule') + (boucle ? ' (boucle)' : '') + '</div>' +
        '<p class="hint">Temps estimés (' + (m === 'pied' ? VITESSE_PIETON + ' km/h' : '12 à 45 km/h selon la voie') + '), hors circulation. Sens uniques non pris en compte.</p>' + html;
      map.fitBounds(routeLayer.getLayers().length ? L.featureGroup(routeLayer.getLayers()).getBounds() : map.getBounds(), { padding: [40, 40], maxZoom: 17 });
    }).catch(function (e) { $('iti-result').innerHTML = '<p class="form-msg">Itinéraire indisponible : ' + esc(e.message) + '</p>'; });
  }

  function gpx() {
    if (!lastResult) return;
    var x = function (s) { return esc(s); };
    var out = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="WebSIG Labé" xmlns="http://www.topografix.com/GPX/1/1">\n';
    lastResult.etapes.forEach(function (e, i) {
      out += '<wpt lat="' + e.latlng.lat.toFixed(6) + '" lon="' + e.latlng.lng.toFixed(6) + '"><name>' +
        lettre(i, lastResult.etapes.length) + ' ' + x(e.label) + '</name></wpt>\n';
    });
    out += '<trk><name>Itinéraire Labé</name>';
    lastResult.lignes.forEach(function (coords) {
      out += '<trkseg>' + coords.map(function (c) { return '<trkpt lat="' + c[1].toFixed(6) + '" lon="' + c[0].toFixed(6) + '"/>'; }).join('') + '</trkseg>';
    });
    out += '</trk>\n</gpx>\n';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out], { type: 'application/gpx+xml' }));
    a.download = 'itineraire_labe.gpx';
    a.click();
  }

  function openTab() {
    var t = document.querySelector('.tab[data-tab="iti"]');
    if (t && !t.classList.contains('active')) t.click();
    if (window.innerWidth >= 700) document.body.classList.remove('collapsed');
  }

  // ---------- Recherche d'un lieu dans le panneau ----------
  function norm(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function lieuLatLng(it) {
    if (it.layer.getLatLng) return it.layer.getLatLng();
    var first = it.layer.getLayers ? it.layer.getLayers()[0] : it.layer;
    // pour une voie, on vise son milieu plutôt que le centre de son emprise
    if (first instanceof L.Polyline && !(first instanceof L.Polygon)) {
      var ll = first.getLatLngs();
      if (Array.isArray(ll[0])) ll = ll[0];
      if (ll.length) return ll[Math.floor(ll.length / 2)];
    }
    return it.layer.getBounds ? it.layer.getBounds().getCenter() : null;
  }
  var input = $('iti-search'), list = $('iti-search-results');
  input.addEventListener('input', function () {
    var q = norm(input.value.trim());
    list.innerHTML = '';
    if (q.length < 2) return;
    A.searchIndex.filter(function (it) { return norm(it.name).indexOf(q) >= 0; }).slice(0, 8).forEach(function (it) {
      var li = document.createElement('li');
      li.innerHTML = esc(it.name) + '<small>' + esc(it.type) + '</small>';
      li.onclick = function () {
        var ll = lieuLatLng(it);
        list.innerHTML = ''; input.value = '';
        if (ll) addStop(ll, it.name);
      };
      list.appendChild(li);
    });
  });

  // ---------- Contrôles ----------
  $('iti-pick').addEventListener('click', function () {
    A.startSketch('point', { label: 'Ajouter une étape', onFinish: function (pts) { addStop(pts[0]); } });
  });
  $('iti-gps').addEventListener('click', function () {
    if (!navigator.geolocation) return alert('Géolocalisation indisponible.');
    navigator.geolocation.getCurrentPosition(function (p) {
      addStop([p.coords.latitude, p.coords.longitude], 'Ma position', 'start');
    }, function () { alert('Position introuvable : autorisez la géolocalisation.'); }, { enableHighAccuracy: true, timeout: 15000 });
  });
  $('iti-clear').addEventListener('click', function () { etapes = []; compute(); });
  $('iti-reverse').addEventListener('click', function () { etapes.reverse(); compute(); });
  $('iti-gpx').addEventListener('click', gpx);
  ['iti-optim', 'iti-boucle'].forEach(function (id) { $(id).addEventListener('change', compute); });
  document.querySelectorAll('input[name="iti-mode"]').forEach(function (r) { r.addEventListener('change', compute); });

  // Clic droit (appui long sur téléphone) : menu d'itinéraire
  map.on('contextmenu', function (e) {
    var d = document.createElement('div');
    d.className = 'iti-menu';
    [['Partir d\'ici', 'start'], ['Ajouter une étape', 'mid'], ['Aller ici', 'end']].forEach(function (o) {
      var b = document.createElement('button');
      b.textContent = o[0];
      b.onclick = function () { map.closePopup(); addStop(e.latlng, 'Point sur la carte', o[1] === 'mid' ? null : o[1]); };
      d.appendChild(b);
    });
    L.popup({ closeButton: false, className: 'iti-menu-popup' }).setLatLng(e.latlng).setContent(d).openOn(map);
  });

  // Préchargement du graphe quand l'onglet est ouvert
  var tab = document.querySelector('.tab[data-tab="iti"]');
  if (tab) tab.addEventListener('click', function () { ensureGraph(); });

  A.itineraire = { ajouter: addStop };
})();
