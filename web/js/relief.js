/* Relief et risques naturels : couches (relief ombré, pentes, zones inondables, courbes de niveau),
 * valeurs du terrain en un point (outil ⓘ), bâtiments exposés par quartier et profil en long.
 * Données précalculées par scripts/relief/relief.py à partir du MNT Copernicus GLO-30 (data/relief). */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc;
  var BASE = 'data/relief/';
  var KX = 111320 * Math.cos(11.32 * Math.PI / 180), KY = 110574;
  var COUL_PENTE = ['#ffffff', '#ffd43b', '#f76707', '#c92a2a'];
  var COUL_INOND = ['#1864ab', '#74c0fc'];

  function $(id) { return document.getElementById(id); }
  function getJSON(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error('relief indisponible (' + r.status + ')'); return r.json(); }); }

  // ---------- Grille (altitude, pente, hauteur au-dessus du drainage) ----------
  var grille = null, chargement = null;
  function pret() {
    return chargement || (chargement = Promise.all([getJSON(BASE + 'relief.json'), fetch(BASE + 'relief.bin.gz').then(function (r) {
      if (!r.ok) throw new Error('relief indisponible (' + r.status + ')');
      return r.arrayBuffer();
    })]).then(function (res) {
      var meta = res[0], buf = new Uint8Array(res[1]);
      // le serveur peut avoir déjà décompressé (Content-Encoding) : on regarde la signature gzip
      if (buf[0] !== 0x1f || buf[1] !== 0x8b) return [meta, buf.buffer];
      if (typeof DecompressionStream === 'undefined') throw new Error('navigateur trop ancien pour lire le relief');
      return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
        .then(function (b) { return [meta, b]; });
    }).then(function (r) {
      var meta = r[0], b = r[1], n = meta.largeur * meta.hauteur;
      grille = {
        meta: meta, w: meta.largeur, h: meta.hauteur,
        alt: new Uint16Array(b.slice(0, 2 * n)),
        pente: new Uint8Array(b, 2 * n, n),
        hand: new Uint8Array(b, 3 * n, n)
      };
      return grille;
    })).catch(function (e) { chargement = null; throw e; });
  }
  function indice(lng, lat) {
    var m = grille.meta, i = Math.round((lng - m.x0) / m.dx), j = Math.round((lat - m.y0) / m.dy);
    return i < 0 || j < 0 || i >= grille.w || j >= grille.h ? -1 : j * grille.w + i;
  }
  // altitude interpolée (bilinéaire), pour les profils
  function altitude(lng, lat) {
    var m = grille.meta, x = (lng - m.x0) / m.dx, y = (lat - m.y0) / m.dy, i = Math.floor(x), j = Math.floor(y);
    if (i < 0 || j < 0 || i >= grille.w - 1 || j >= grille.h - 1) return null;
    var fx = x - i, fy = y - j, w = grille.w, a = grille.alt, k = j * w + i;
    return ((a[k] * (1 - fx) + a[k + 1] * fx) * (1 - fy) + (a[k + w] * (1 - fx) + a[k + w + 1] * fx) * fy) / 10;
  }
  // valeurs brutes d'une cellule ; null hors de la grille
  function valeurs(lng, lat) {
    var k = indice(lng, lat);
    if (k < 0) return null;
    var h = grille.hand[k];
    return { alt: grille.alt[k] / 10, pente: grille.pente[k] / 2, hand: h === 255 ? null : h / 10, dansCommune: h !== 255 };
  }
  function classe(v, seuils) { for (var k = 0; k < seuils.length; k++) if (v < seuils[k]) return k; return seuils.length; }
  var NOMS_PENTE = ['faible', 'modérée', 'forte', 'très forte'];
  function aleaInondation(hand, seuils) {
    if (hand == null) return null;
    return ['Fort', 'Moyen', 'Faible ou nul'][classe(hand, seuils)];
  }
  function fmtPente(p) { return p >= 127 ? '≥ 127 %' : A.fmt(p, 1) + ' %'; }
  function fmtHand(h) { return h >= 25.4 ? '≥ 25 m' : A.fmt(h, 1) + ' m'; }

  // fiche pour l'outil ⓘ
  function fiche(ll) {
    if (!grille) return null;
    var v = valeurs(ll.lng, ll.lat), m = grille.meta;
    if (!v || !v.dansCommune) return null;
    var cp = classe(v.pente, m.classes_pente);
    return {
      libelle: 'Altitude ' + A.fmt(Math.round(altitude(ll.lng, ll.lat))) + ' m',
      'Altitude': A.fmt(altitude(ll.lng, ll.lat), 1) + ' m',
      'Pente': fmtPente(v.pente) + ' (' + NOMS_PENTE[cp] + ')',
      'Hauteur au-dessus du drainage': fmtHand(v.hand),
      'Aléa inondation': aleaInondation(v.hand, m.classes_hand),
      'Source': 'MNT Copernicus 30 m'
    };
  }

  // ---------- Couches ----------
  map.createPane('reliefPane');
  map.getPane('reliefPane').style.zIndex = 250;     // au-dessus du fond de carte, sous les données
  map.getPane('reliefPane').style.pointerEvents = 'none';
  var images = {}, courbes = null;
  function image(nom, opacite) {
    return function (on) {
      if (!on) { if (images[nom]) map.removeLayer(images[nom]); return; }
      pret().then(function (g) {
        if (!images[nom]) images[nom] = L.imageOverlay(BASE + nom + '.png', g.meta.image_bounds, { pane: 'reliefPane', opacity: opacite, className: 'relief-img' });
        images[nom].addTo(map);
      }).catch(function (e) { alert('Couche indisponible : ' + e.message); });
    };
  }
  function lisser(a, w, h) {
    var o = new Float64Array(a.length);
    for (var j = 0; j < h; j++) for (var i = 0; i < w; i++) {
      var s = 0, n = 0;
      for (var dj = -2; dj <= 2; dj++) for (var di = -2; di <= 2; di++) {
        var jj = j + dj, ii = i + di;
        if (jj >= 0 && ii >= 0 && jj < h && ii < w) { s += a[jj * w + ii]; n++; }
      }
      o[j * w + i] = s / n / 10;
    }
    return o;
  }
  function courbesDeNiveau(on) {
    if (!on) { if (courbes) map.removeLayer(courbes); return; }
    pret().then(function (g) {
      if (!courbes) {
        var m = g.meta, z = lisser(g.alt, g.w, g.h), seuils = [];
        for (var s = Math.ceil(m.stats.altitude_min / 10) * 10 - 10; s <= m.stats.altitude_max + 10; s += 10) seuils.push(s);
        courbes = L.featureGroup();
        var rendu = L.canvas({ pane: 'reliefPane' });
        d3.contours().size([g.w, g.h]).thresholds(seuils)(z).forEach(function (c) {
          var maitresse = c.value % 50 === 0;
          var lignes = [];
          c.coordinates.forEach(function (poly) { poly.forEach(function (ring) {
            lignes.push(ring.map(function (p) { return [m.y0 + (p[1] - 0.5) * m.dy, m.x0 + (p[0] - 0.5) * m.dx]; }));
          }); });
          if (!lignes.length) return;
          L.polyline(lignes, { renderer: rendu, color: '#8c6d46', weight: maitresse ? 1.4 : 0.6, opacity: maitresse ? 0.9 : 0.6, interactive: false, smoothFactor: 1.5 })
            .addTo(courbes);
        });
      }
      courbes.addTo(map);
    }).catch(function (e) { alert('Couche indisponible : ' + e.message); });
  }
  A.ready.then(function () {
    A.addOverlay({ name: 'Relief ombré', group: 'Relief et risques naturels', onToggle: image('ombrage', 0.9),
      swatch: '<span class="swatch" style="background:linear-gradient(135deg,#fff,#868e96)"></span>' });
    A.addOverlay({ name: 'Courbes de niveau (10 m)', group: 'Relief et risques naturels', onToggle: courbesDeNiveau,
      swatch: '<span class="swatch line" style="background:#8c6d46"></span>' });
    A.addOverlay({ name: 'Pentes', group: 'Relief et risques naturels', onToggle: image('pentes', 0.85),
      swatch: '<span class="swatch" style="background:#f76707"></span>',
      legend: [['5 à 15 % (modérée)', COUL_PENTE[1]], ['15 à 30 % (forte)', COUL_PENTE[2]], ['plus de 30 % (très forte)', COUL_PENTE[3]]] });
    A.addOverlay({ name: 'Zones inondables', group: 'Relief et risques naturels', onToggle: image('inondation', 0.9),
      swatch: '<span class="swatch" style="background:#1864ab"></span>',
      legend: [['Aléa fort (moins de 2 m au-dessus du drainage)', COUL_INOND[0]], ['Aléa moyen (2 à 5 m)', COUL_INOND[1]]] });
  });

  // ---------- Panneau d'analyse ----------
  var res = L.featureGroup().addTo(map), curseur = L.layerGroup().addTo(map), dernier = null;
  function resume(g) {
    var s = g.meta.stats, tot = s.surface_km2;
    function ligne(lib, km2, coul) {
      return '<tr><td><span class="swatch" style="background:' + coul + '"></span> ' + esc(lib) + '</td><td>' + A.fmt(km2, 1) + ' km²</td><td><small>' + A.fmt(Math.round(100 * km2 / tot)) + ' %</small></td></tr>';
    }
    $('rel-resume').innerHTML =
      '<p class="ana-head">Altitude de <b>' + A.fmt(Math.round(s.altitude_min)) + '</b> à <b>' + A.fmt(Math.round(s.altitude_max)) + ' m</b> (moyenne ' +
      A.fmt(Math.round(s.altitude_moyenne)) + ' m), pente moyenne ' + A.fmt(s.pente_moyenne, 1) + ' %.</p>' +
      '<table class="ana-table"><thead><tr><th>Territoire communal</th><th>Surface</th><th></th></tr></thead><tbody>' +
      ligne('Inondable — aléa fort', s.hand_km2[0], COUL_INOND[0]) + ligne('Inondable — aléa moyen', s.hand_km2[1], COUL_INOND[1]) +
      ligne('Pente forte (15 à 30 %)', s.pentes_km2[2], COUL_PENTE[2]) + ligne('Pente très forte (> 30 %)', s.pentes_km2[3], COUL_PENTE[3]) +
      '</tbody></table>';
  }
  function ouvrir() {
    pret().then(resume).catch(function (e) { $('rel-resume').innerHTML = '<p class="form-msg">' + esc(e.message) + '</p>'; });
  }
  document.querySelectorAll('.ana-switch button[data-ana="rel"]').forEach(function (b) { b.addEventListener('click', ouvrir); });

  function nombres(txt) {
    return String(txt).split(/[;,\s]+/).map(function (x) { return +x.replace(',', '.'); })
      .filter(function (x) { return x > 0 && isFinite(x); }).sort(function (a, b) { return a - b; }).slice(0, 2);
  }

  // ----- Bâtiments exposés -----
  $('rel-run').addEventListener('click', function () {
    var sh = nombres($('rel-hand').value), sp = nombres($('rel-pente').value);
    if (sh.length !== 2 || sp.length !== 2) return alert('Indiquez deux seuils pour chaque risque, par exemple « 2, 5 » et « 15, 30 ».');
    var btn = this; btn.disabled = true; btn.textContent = 'Calcul…';
    $('rel-result').innerHTML = '<p class="hint">Calcul en cours…</p>';
    Promise.all([pret(), A.selection.prepare('batiments')]).then(function (r) {
      var items = r[1];
      var inond = [[], []], pentes = [[], []], quartiers = {}, total = 0;
      items.forEach(function (it) {
        var v = valeurs(it.rep[0], it.rep[1]);
        if (!v || !v.dansCommune) return;
        total++;
        var q = quartiers[it.p.quartier || '—'] || (quartiers[it.p.quartier || '—'] = { n: 0, i0: [], i1: [], p0: [], p1: [] });
        q.n++;
        var ci = classe(v.hand, sh), cp = classe(v.pente, sp);
        if (ci < 2) { inond[ci].push(it); q['i' + ci].push(it); }
        if (cp >= 1) { pentes[cp - 1].push(it); q['p' + (cp - 1)].push(it); }
      });
      dernier = { sh: sh, sp: sp, inond: inond, pentes: pentes, quartiers: quartiers, total: total };
      afficherResultat();
    }).catch(function (e) { $('rel-result').innerHTML = '<p class="form-msg">Calcul impossible : ' + esc(e.message) + '</p>'; })
      .then(function () { btn.disabled = false; btn.textContent = 'Analyser les bâtiments'; });
  });
  function pct(n, t) { var p = 100 * n / Math.max(t, 1); return (p > 0 && p < 1 ? A.fmt(p, 1) : A.fmt(Math.round(p))) + ' %'; }
  function afficherResultat() {
    var d = dernier, sh = d.sh, sp = d.sp, html = '';
    var lignes = [
      ['i', 0, COUL_INOND[0], 'Inondation — aléa fort', 'moins de ' + A.fmt(sh[0]) + ' m au-dessus du drainage'],
      ['i', 1, COUL_INOND[1], 'Inondation — aléa moyen', A.fmt(sh[0]) + ' à ' + A.fmt(sh[1]) + ' m au-dessus du drainage'],
      ['p', 0, COUL_PENTE[2], 'Pente forte', A.fmt(sp[0]) + ' à ' + A.fmt(sp[1]) + ' %'],
      ['p', 1, COUL_PENTE[3], 'Pente très forte', 'plus de ' + A.fmt(sp[1]) + ' %']
    ];
    html += '<p class="ana-head"><b>Bâtiments exposés</b> <small class="muted">(' + A.fmt(d.total) + ' bâtiments dans la commune)</small></p>' +
      '<table class="ana-table"><thead><tr><th>Risque</th><th>Bâtiments</th><th></th></tr></thead><tbody>';
    lignes.forEach(function (l) {
      var arr = (l[0] === 'i' ? d.inond : d.pentes)[l[1]];
      html += '<tr><td><span class="swatch" style="background:' + l[2] + '"></span> ' + esc(l[3]) + '<br><small>' + esc(l[4]) + '</small></td>' +
        '<td><b>' + A.fmt(arr.length) + '</b> <small>' + pct(arr.length, d.total) + '</small></td>' +
        '<td><button data-voir="' + l[0] + l[1] + '">Voir</button></td></tr>';
    });
    html += '</tbody></table>';
    // par quartier, du plus exposé au moins exposé
    var noms = Object.keys(d.quartiers).sort(function (a, b) {
      var qa = d.quartiers[a], qb = d.quartiers[b];
      return (qb.i0.length + qb.i1.length) - (qa.i0.length + qa.i1.length) || a.localeCompare(b);
    });
    html += '<p class="ana-head"><b>Par quartier</b></p><div class="rel-scroll"><table class="ana-table"><thead><tr><th>Quartier</th><th>Bâti</th>' +
      '<th title="Inondation, aléa fort">Inond. fort</th><th title="Inondation, aléa moyen">Inond. moyen</th><th title="Pente forte ou très forte">Pente ≥ ' + A.fmt(sp[0]) + ' %</th></tr></thead><tbody>';
    noms.forEach(function (n) {
      var q = d.quartiers[n];
      function cell(arr, cle) {
        return '<td>' + (arr.length ? '<a href="#" data-q="' + esc(n) + '" data-cle="' + cle + '">' + A.fmt(arr.length) + '</a> <small>' + pct(arr.length, q.n) + '</small>' : '<small>0</small>') + '</td>';
      }
      html += '<tr><td>' + esc(n) + '</td><td>' + A.fmt(q.n) + '</td>' + cell(q.i0, 'i0') + cell(q.i1, 'i1') + cell(q.p0.concat(q.p1), 'p') + '</tr>';
    });
    html += '</tbody></table></div><div class="row"><button id="rel-csv" type="button">Exporter par quartier (CSV)</button></div>' +
      '<p class="hint">Chaque bâtiment est évalué en son point central, sur la grille de 30 m du MNT. Le modèle Copernicus est un modèle de surface ' +
      '(il inclut une partie des arbres et des toits) : ces résultats sont un <b>repérage</b> des secteurs à vérifier sur le terrain, pas un zonage réglementaire.</p>';
    $('rel-result').innerHTML = html;
    $('rel-result').querySelectorAll('button[data-voir]').forEach(function (b) {
      b.onclick = function () {
        var c = b.dataset.voir, l = lignes.filter(function (x) { return x[0] + x[1] === c; })[0];
        A.selection.afficher('batiments', (c[0] === 'i' ? d.inond : d.pentes)[+c[1]], 'bâtiments — ' + l[3].toLowerCase() + ' (' + l[4] + ')');
      };
    });
    $('rel-result').querySelectorAll('a[data-q]').forEach(function (a) {
      a.onclick = function (e) {
        e.preventDefault();
        var q = d.quartiers[a.dataset.q], c = a.dataset.cle;
        var arr = c === 'p' ? q.p0.concat(q.p1) : q[c];
        var lib = c === 'i0' ? 'en zone inondable (aléa fort)' : c === 'i1' ? 'en zone inondable (aléa moyen)' : 'sur pente ≥ ' + sp[0] + ' %';
        A.selection.afficher('batiments', arr, 'bâtiments ' + lib + ' — ' + a.dataset.q);
      };
    });
    $('rel-csv').onclick = function () {
      var rows = [['quartier', 'batiments', 'inondation_fort', 'inondation_moyen', 'pente_forte', 'pente_tres_forte']];
      noms.forEach(function (n) { var q = d.quartiers[n]; rows.push([n, q.n, q.i0.length, q.i1.length, q.p0.length, q.p1.length]); });
      var csv = '﻿' + rows.map(function (r) { return r.map(function (x) { return /[;"\n]/.test(String(x)) ? '"' + String(x).replace(/"/g, '""') + '"' : x; }).join(';'); }).join('\r\n');
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = 'risques_par_quartier_labe.csv'; a.click();
    };
  }

  // ----- Profil en long -----
  $('rel-profil').addEventListener('click', function () {
    A.startSketch('line', { label: 'Ligne du profil en long', onFinish: function (pts) {
      pret().then(function () { profil(pts); }).catch(function (e) { $('rel-profil-result').innerHTML = '<p class="form-msg">' + esc(e.message) + '</p>'; });
    } });
  });
  function profil(pts) {
    res.clearLayers(); curseur.clearLayers();
    L.polyline(pts, { color: '#5f3dc4', weight: 4, opacity: 0.9 }).addTo(res);
    // échantillons tous les 10 m environ
    var ech = [], dist = 0;
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i], l = Math.hypot((b.lng - a.lng) * KX, (b.lat - a.lat) * KY), n = Math.max(1, Math.ceil(l / 10));
      for (var k = (i === 1 ? 0 : 1); k <= n; k++) {
        var f = k / n, lng = a.lng + f * (b.lng - a.lng), lat = a.lat + f * (b.lat - a.lat);
        ech.push({ d: dist + f * l, z: altitude(lng, lat), ll: L.latLng(lat, lng) });
      }
      dist += l;
    }
    ech = ech.filter(function (e) { return e.z != null; });
    if (ech.length < 2) { $('rel-profil-result').innerHTML = '<p class="form-msg">Ligne hors de la zone couverte par le relief.</p>'; return; }
    var zmin = Infinity, zmax = -Infinity, dplus = 0, dmoins = 0, pmax = 0;
    ech.forEach(function (e, i) {
      zmin = Math.min(zmin, e.z); zmax = Math.max(zmax, e.z);
      if (i) { var dz = e.z - ech[i - 1].z; if (dz > 0) dplus += dz; else dmoins -= dz; }
    });
    // pente maximale sur 30 m glissants (la résolution du MNT)
    for (var s = 0, t = 0; s < ech.length; s++) {
      while (t < ech.length - 1 && ech[t].d - ech[s].d < 30) t++;
      if (ech[t].d - ech[s].d >= 30) pmax = Math.max(pmax, Math.abs(ech[t].z - ech[s].z) / (ech[t].d - ech[s].d) * 100);
    }
    var D = ech[ech.length - 1].d;
    $('rel-profil-result').innerHTML =
      '<p class="ana-head"><b>Profil en long</b> — ' + A.fmtLen(D) + '</p>' +
      '<div class="rel-chiffres"><span>Altitude <b>' + A.fmt(Math.round(zmin)) + ' – ' + A.fmt(Math.round(zmax)) + ' m</b></span>' +
      '<span>Dénivelé <b>+' + A.fmt(Math.round(dplus)) + ' m / −' + A.fmt(Math.round(dmoins)) + ' m</b></span>' +
      '<span>Pente moyenne <b>' + A.fmt((dplus + dmoins) / D * 100, 1) + ' %</b></span>' +
      '<span>Pente max. (sur 30 m) <b>' + A.fmt(pmax, 1) + ' %</b></span></div>' +
      '<div id="rel-graph"></div><div class="row"><button id="rel-profil-csv" type="button">Exporter le profil (CSV)</button></div>';
    graphique($('rel-graph'), ech, zmin, zmax);
    $('rel-profil-csv').onclick = function () {
      var csv = '﻿distance_m;altitude_m;latitude;longitude\r\n' + ech.map(function (e) {
        return [Math.round(e.d), e.z.toFixed(1), e.ll.lat.toFixed(6), e.ll.lng.toFixed(6)].join(';');
      }).join('\r\n');
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = 'profil_en_long_labe.csv'; a.click();
    };
    map.fitBounds(res.getBounds(), { padding: [40, 40] });
  }
  // graphique SVG : une série, axes discrets, curseur au survol relié à la carte
  function graphique(box, ech, zmin, zmax) {
    var W = 300, H = 160, ml = 40, mr = 8, mt = 8, mb = 24, D = ech[ech.length - 1].d;
    var pas = [1, 2, 5, 10, 20, 25, 50, 100].filter(function (p) { return (zmax - zmin) / p <= 5; })[0] || 100;
    var y0 = Math.floor(zmin / pas) * pas, y1 = Math.max(Math.ceil(zmax / pas) * pas, y0 + pas);
    function X(d) { return ml + d / D * (W - ml - mr); }
    function Y(z) { return mt + (y1 - z) / (y1 - y0) * (H - mt - mb); }
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="rel-svg" role="img" aria-label="Profil en long : altitude selon la distance">';
    for (var z = y0; z <= y1 + 1e-9; z += pas) {
      svg += '<line x1="' + ml + '" x2="' + (W - mr) + '" y1="' + Y(z) + '" y2="' + Y(z) + '" class="g"/>' +
        '<text x="' + (ml - 4) + '" y="' + (Y(z) + 3) + '" text-anchor="end">' + A.fmt(z) + '</text>';
    }
    var pd = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].filter(function (p) { return D / p <= 5; })[0] || 5000;
    for (var d = 0; d <= D + 1e-9; d += pd) svg += '<text x="' + X(d) + '" y="' + (H - 8) + '" text-anchor="middle">' + (d >= 1000 ? A.fmt(d / 1000, 1) + ' km' : A.fmt(d) + ' m') + '</text>';
    var path = ech.map(function (e, i) { return (i ? 'L' : 'M') + X(e.d).toFixed(1) + ' ' + Y(e.z).toFixed(1); }).join('');
    svg += '<path d="' + path + 'L' + X(D) + ' ' + Y(y0) + 'L' + ml + ' ' + Y(y0) + 'Z" class="a"/><path d="' + path + '" class="l"/>' +
      '<line class="c hidden" y1="' + mt + '" y2="' + (H - mb) + '"/><circle class="c hidden" r="4"/>' +
      '<rect x="' + ml + '" y="' + mt + '" width="' + (W - ml - mr) + '" height="' + (H - mt - mb) + '" fill="transparent"/></svg>' +
      '<div class="rel-tip hidden"></div>';
    box.innerHTML = svg;
    var el = box.querySelector('svg'), ln = el.querySelector('line.c'), pt = el.querySelector('circle.c'), tip = box.querySelector('.rel-tip');
    function bouger(ev) {
      var r = el.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * W;
      var d = Math.max(0, Math.min(D, (x - ml) / (W - ml - mr) * D)), e = ech[0];
      for (var i = 1; i < ech.length && ech[i - 1].d < d; i++) e = Math.abs(ech[i].d - d) < Math.abs(e.d - d) ? ech[i] : e;
      ln.setAttribute('x1', X(e.d)); ln.setAttribute('x2', X(e.d));
      pt.setAttribute('cx', X(e.d)); pt.setAttribute('cy', Y(e.z));
      ln.classList.remove('hidden'); pt.classList.remove('hidden'); tip.classList.remove('hidden');
      tip.innerHTML = '<b>' + A.fmt(e.z, 1) + ' m</b> à ' + A.fmtLen(e.d);
      tip.style.left = Math.min(r.width - 110, Math.max(0, X(e.d) / W * r.width - 50)) + 'px';
      curseur.clearLayers();
      L.circleMarker(e.ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#5f3dc4', fillOpacity: 1, interactive: false }).addTo(curseur);
    }
    el.addEventListener('pointermove', bouger);
    el.addEventListener('pointerleave', function () {
      ln.classList.add('hidden'); pt.classList.add('hidden'); tip.classList.add('hidden'); curseur.clearLayers();
    });
  }

  $('ana-clear').addEventListener('click', function () {
    res.clearLayers(); curseur.clearLayers();
    $('rel-result').innerHTML = ''; $('rel-profil-result').innerHTML = ''; dernier = null;
  });

  A.relief = { pret: pret, charge: function () { return !!grille; }, valeurs: function (ll) { return grille ? valeurs(ll.lng, ll.lat) : null; },
    altitude: function (ll) { return grille ? altitude(ll.lng, ll.lat) : null; }, fiche: fiche, aleaInondation: aleaInondation };
})();
