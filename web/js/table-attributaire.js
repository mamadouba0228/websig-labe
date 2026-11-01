/* Table attributaire des couches (comme dans QGIS) : bouton ⊞ à côté de chaque couche du panneau « Couches ».
 * Tri par colonne, recherche, entités visibles sur la carte ou sélectionnées, sélection (Ctrl / Maj),
 * zoom sur la sélection, colonnes affichées, export CSV. Défilement virtuel : seules les lignes visibles sont dessinées
 * (le bâti compte plus de 40 000 entités). Fonctionne sur la carte publique et dans l'espace agents. */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc;
  var HAUTEUR = 26, MAX_SURBRILLANCE = 3000;
  var LIBELLES = { nom: 'Nom', nature: 'Nature', categorie: 'Catégorie', type: 'Type', quartier: 'Quartier', statut: 'Statut',
    description: 'Description', libelle: 'Libellé', code: 'Code', numero: 'Numéro', regime: 'Régime', cl_admin: 'Classe',
    superficie_km2: 'Superficie (km²)', nb_batiments: 'Bâtiments', densite: 'Bâtiments / km²', type_voie: 'Type de voie',
    statut_nom: 'Dénomination', longueur_m: 'Longueur (m)', code_voie: 'Code de la voie', cote: 'Côté', num: 'N°',
    cree_le: 'Créé le', modifie_le: 'Modifié le', valide_le: 'Validé le', auteur: 'Auteur', service: 'Service', gid: 'Identifiant',
    id: 'Identifiant', alea: 'Aléa', critere: 'Critère', surface_ha: 'Surface (ha)', deliberation: 'Délibération',
    complement: 'Complément', suffixe: 'Suffixe', nom_voie: 'Nom de la voie', batiment_gid: 'Bâtiment' };
  var MASQUES = { geometry: 1, bbox: 1, photo_url: 1, a_photo: 1 };
  var KX = 111320 * Math.cos(11.32 * Math.PI / 180), KY = 110574;

  // ---------- Mesures (projection locale en mètres) ----------
  function aire(r) {
    var a = 0;
    for (var i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * KX * r[i][1] * KY - r[i][0] * KX * r[j][1] * KY;
    return Math.abs(a / 2);
  }
  function longueur(c) {
    var l = 0;
    for (var i = 1; i < c.length; i++) l += Math.hypot((c[i][0] - c[i - 1][0]) * KX, (c[i][1] - c[i - 1][1]) * KY);
    return l;
  }
  function mesure(g) {
    if (!g || !g.coordinates) return null;
    var t = g.type, c = g.coordinates;
    if (t === 'Polygon') return { surf: aire(c[0]) - c.slice(1).reduce(function (s, h) { return s + aire(h); }, 0) };
    if (t === 'MultiPolygon') return { surf: c.reduce(function (s, p) { return s + (p[0] ? aire(p[0]) : 0); }, 0) };
    if (t === 'LineString') return { long: longueur(c) };
    if (t === 'MultiLineString') return { long: c.reduce(function (s, l) { return s + longueur(l); }, 0) };
    return null;
  }
  // point représentatif (filtre « visibles sur la carte ») et emprise (zoom)
  function emprise(g) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    (function parcours(c) {
      if (typeof c[0] === 'number') { b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]); }
      else c.forEach(parcours);
    })(g.coordinates || []);
    return b[0] === Infinity ? null : b;
  }

  // ---------- Lecture des entités d'une couche ----------
  function feuilles(couche, out) {
    if (couche.feature) out.push({ p: couche.feature.properties || {}, g: couche.feature.geometry, layer: couche });
    else if (couche.eachLayer) couche.eachLayer(function (l) { feuilles(l, out); });
    return out;
  }
  function normaliser(x) {
    if (!x) return [];
    if (x.features) return x.features.map(function (f) { return { p: f.properties || {}, g: f.geometry, layer: null }; });
    if (Array.isArray(x)) return x.map(function (it) {
      return it.feature ? { p: it.feature.properties || {}, g: it.feature.geometry, layer: it.layer || null }
        : { p: it.properties || {}, g: it.geometry, layer: null };
    });
    if (x.eachLayer || x.feature) return feuilles(x, []);
    return [];
  }
  function source(o) {
    var t = o.table || o.layer;
    return Promise.resolve(typeof t === 'function' ? t() : t).then(normaliser);
  }

  // ---------- Tiroir ----------
  var tiroir = document.createElement('div');
  tiroir.className = 'sel-drawer table-drawer hidden';
  tiroir.innerHTML = '<div class="sel-drawer-head"><div class="ta-titre"><b id="ta-nom"></b> <span id="ta-compte"></span></div>' +
    '<div class="sel-drawer-actions ta-actions">' +
    '<input id="ta-recherche" type="search" placeholder="Rechercher dans la table…">' +
    '<select id="ta-mode"><option value="toutes">Toutes les entités</option><option value="visibles">Visibles sur la carte</option>' +
    '<option value="sel">Entités sélectionnées</option></select>' +
    '<button type="button" id="ta-zoom" title="Zoomer sur la sélection (ou sur les entités filtrées)">⌖ Zoomer</button>' +
    '<button type="button" id="ta-tout" title="Sélectionner toutes les entités filtrées">Tout sélectionner</button>' +
    '<button type="button" id="ta-aucun">Désélectionner</button>' +
    '<span class="ta-colonnes-wrap"><button type="button" id="ta-colonnes">Colonnes ▾</button><div id="ta-colonnes-liste" class="ta-colonnes hidden"></div></span>' +
    '<button type="button" id="ta-csv" title="Export des entités filtrées (ou sélectionnées)">CSV</button>' +
    '<button type="button" id="ta-agrandir" title="Agrandir / réduire">⤢</button>' +
    '<button type="button" id="ta-fermer" title="Fermer">✕</button></div></div>' +
    '<div class="ta-corps" id="ta-corps"><p class="hint ta-msg">Chargement…</p></div>';
  document.body.appendChild(tiroir);
  L.DomEvent.disableClickPropagation(tiroir);
  L.DomEvent.disableScrollPropagation(tiroir);
  function $(id) { return document.getElementById(id); }
  var surbrillance = L.featureGroup().addTo(map);

  var T = null;   // table ouverte : { o, lignes, cols, filtre, ordre, sel, tri, sens, masquees }

  function norm(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function valeurTexte(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map(function (x) { return typeof x === 'object' ? JSON.stringify(x) : x; }).join(', ');
    if (typeof v === 'object') return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 'oui' : 'non';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}.*)?$/.test(v)) {
      var d = new Date(v);
      return isNaN(d) ? v : v.length > 10 ? d.toLocaleString('fr-FR') : d.toLocaleDateString('fr-FR');
    }
    return String(v);
  }
  function valeurAffichee(c, v) {
    if (v == null || v === '') return '';
    if (c.num) return A.fmt(v, c.dec);
    return valeurTexte(v);
  }

  function preparer(lignes) {
    var cles = [], vues = {};
    lignes.forEach(function (r, i) {
      r.i = i;
      Object.keys(r.p).forEach(function (k) { if (!vues[k] && !MASQUES[k] && k.charAt(0) !== '_') { vues[k] = 1; cles.push(k); } });
      var m = mesure(r.g);
      if (m) { r.mes = m; }
      r.bb = r.g ? emprise(r.g) : null;
    });
    var cols = cles.map(function (k) {
      var nums = 0, autres = 0, dec = 0;
      for (var i = 0; i < lignes.length; i++) {
        var v = lignes[i].p[k];
        if (v == null || v === '') continue;
        if (typeof v === 'number') { nums++; if (!Number.isInteger(v)) dec = 2; } else autres++;
        if (nums + autres > 2000) break;
      }
      return { k: k, lib: LIBELLES[k] || k, num: nums > 0 && autres === 0, dec: dec, get: function (r) { return r.p[k]; } };
    });
    var aSurf = lignes.some(function (r) { return r.mes && r.mes.surf != null; }), aLong = lignes.some(function (r) { return r.mes && r.mes.long != null; });
    if (aSurf && !cles.some(function (k) { return /surface|superficie/i.test(k); }))
      cols.push({ k: '_surf', lib: 'Surface calculée (m²)', num: true, dec: 0, calc: true, get: function (r) { return r.mes && r.mes.surf; } });
    if (aLong && !cles.some(function (k) { return /longueur/i.test(k); }))
      cols.push({ k: '_long', lib: 'Longueur calculée (m)', num: true, dec: 0, calc: true, get: function (r) { return r.mes && r.mes.long; } });
    // largeur des colonnes : d'après le titre et un échantillon de valeurs
    cols.forEach(function (c) {
      var n = c.lib.length;
      for (var i = 0; i < Math.min(lignes.length, 300); i++) n = Math.max(n, valeurAffichee(c, c.get(lignes[i])).length);
      c.larg = Math.max(70, Math.min(280, n * 7 + 22));
    });
    return cols;
  }

  function ouvrir(o) {
    var sel = $('sel-drawer');
    if (sel && !sel.classList.contains('hidden') && $('sel-close')) $('sel-close').click();
    T = { o: o, lignes: [], cols: [], filtre: '', ordre: [], sel: new Set(), tri: null, sens: 1, masquees: {}, dernier: null };
    $('ta-nom').textContent = 'Table attributaire — ' + o.name;
    $('ta-compte').textContent = '';
    $('ta-recherche').value = ''; $('ta-mode').value = 'toutes';
    $('ta-corps').innerHTML = '<p class="hint ta-msg">Chargement des entités…</p>';
    tiroir.classList.remove('hidden');
    document.body.classList.add('drawer-open');
    setTimeout(function () { map.invalidateSize(); }, 50);
    var t = T;
    source(o).then(function (lignes) {
      if (t !== T) return;
      T.lignes = lignes.filter(function (r) { return r.p; });
      T.cols = preparer(T.lignes);
      if (!T.lignes.length) { $('ta-corps').innerHTML = '<p class="hint ta-msg">Aucune entité dans cette couche' + (o.vide || '') + '.</p>'; return; }
      construire();
      filtrer();
    }).catch(function (e) { if (t === T) $('ta-corps').innerHTML = '<p class="form-msg ta-msg">Table indisponible : ' + esc(e.message) + '</p>'; });
  }
  function fermer() {
    T = null;
    tiroir.classList.add('hidden');
    tiroir.classList.remove('agrandi');
    document.body.classList.remove('drawer-open');
    surbrillance.clearLayers();
    setTimeout(function () { map.invalidateSize(); }, 50);
  }

  // ---------- Tableau (défilement virtuel) ----------
  function colsVisibles() { return T.cols.filter(function (c) { return !T.masquees[c.k]; }); }
  function construire() {
    var cols = colsVisibles(), larg = 46 + cols.reduce(function (s, c) { return s + c.larg; }, 0);
    $('ta-corps').innerHTML = '<div class="ta-defil" id="ta-defil"><table class="ta-table" style="width:' + larg + 'px"><colgroup><col style="width:46px">' +
      cols.map(function (c) { return '<col style="width:' + c.larg + 'px">'; }).join('') + '</colgroup><thead><tr><th class="ta-n">#</th>' +
      cols.map(function (c) {
        return '<th data-k="' + esc(c.k) + '" class="' + (c.num ? 'num' : '') + (c.calc ? ' calc' : '') + '" title="Trier par « ' + esc(c.lib) + ' »">' + esc(c.lib) +
          (T.tri === c.k ? (T.sens > 0 ? ' ▲' : ' ▼') : '') + '</th>';
      }).join('') + '</tr></thead><tbody id="ta-tbody"></tbody></table></div>';
    $('ta-corps').querySelectorAll('th[data-k]').forEach(function (th) {
      th.onclick = function () {
        if (T.tri === th.dataset.k) T.sens = -T.sens; else { T.tri = th.dataset.k; T.sens = 1; }
        trier(); construire(); dessiner();
      };
    });
    $('ta-defil').addEventListener('scroll', dessiner);
    $('ta-tbody').addEventListener('click', clicLigne);
    $('ta-tbody').addEventListener('dblclick', function (e) {
      var tr = e.target.closest('tr[data-i]');
      if (tr) zoomer([T.lignes[+tr.dataset.i]], true);
    });
  }
  function dessiner() {
    if (!T || !$('ta-tbody')) return;
    var d = $('ta-defil'), cols = colsVisibles(), n = T.ordre.length;
    var h = d.clientHeight - HAUTEUR, debut = Math.max(0, Math.floor(d.scrollTop / HAUTEUR) - 5), fin = Math.min(n, debut + Math.ceil(h / HAUTEUR) + 12);
    var html = '<tr style="height:' + debut * HAUTEUR + 'px"></tr>';
    for (var k = debut; k < fin; k++) {
      var r = T.lignes[T.ordre[k]];
      html += '<tr data-i="' + r.i + '"' + (T.sel.has(r.i) ? ' class="choisie"' : '') + '><td class="ta-n">' + (k + 1) + '</td>' +
        cols.map(function (c) {
          var t = valeurAffichee(c, c.get(r));
          return '<td' + (c.num ? ' class="num"' : '') + (t.length > 30 ? ' title="' + esc(t) + '"' : '') + '>' + esc(t) + '</td>';
        }).join('') + '</tr>';
    }
    html += '<tr style="height:' + (n - fin) * HAUTEUR + 'px"></tr>';
    $('ta-tbody').innerHTML = html;
  }
  function compte() {
    $('ta-compte').textContent = '· ' + A.fmt(T.lignes.length) + ' entité(s)' + (T.ordre.length !== T.lignes.length ? ', ' + A.fmt(T.ordre.length) + ' affichée(s)' : '') +
      (T.sel.size ? ', ' + A.fmt(T.sel.size) + ' sélectionnée(s)' : '');
  }

  // ---------- Filtre, tri ----------
  function filtrer() {
    if (!T || !T.cols.length) return;
    var q = norm(T.filtre.trim()), mode = $('ta-mode').value, cols = colsVisibles(), b = map.getBounds();
    T.ordre = [];
    T.lignes.forEach(function (r) {
      if (mode === 'sel' && !T.sel.has(r.i)) return;
      if (mode === 'visibles' && !(r.bb && b.intersects([[r.bb[1], r.bb[0]], [r.bb[3], r.bb[2]]]))) return;
      if (q && !cols.some(function (c) { var v = c.get(r); return v != null && norm(valeurAffichee(c, v)).indexOf(q) >= 0; })) return;
      T.ordre.push(r.i);
    });
    trier();
    if ($('ta-defil')) $('ta-defil').scrollTop = 0;
    dessiner(); compte();
  }
  function trier() {
    if (!T.tri) return;
    var c = T.cols.filter(function (x) { return x.k === T.tri; })[0], s = T.sens;
    if (!c) return;
    var coll = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
    T.ordre.sort(function (a, b) {
      var va = c.get(T.lignes[a]), vb = c.get(T.lignes[b]);
      if (va == null || va === '') return vb == null || vb === '' ? 0 : 1;      // valeurs vides à la fin
      if (vb == null || vb === '') return -1;
      return s * (c.num ? va - vb : coll.compare(valeurTexte(va), valeurTexte(vb)));
    });
  }

  // ---------- Sélection ----------
  function clicLigne(e) {
    var tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    var i = +tr.dataset.i;
    if (e.shiftKey && T.dernier != null) {
      var a = T.ordre.indexOf(T.dernier), b = T.ordre.indexOf(i);
      if (a > b) { var x = a; a = b; b = x; }
      for (var k = a; k <= b; k++) T.sel.add(T.ordre[k]);
    } else if (e.ctrlKey || e.metaKey) {
      if (T.sel.has(i)) T.sel.delete(i); else T.sel.add(i);
    } else {
      var seul = T.sel.size === 1 && T.sel.has(i);
      T.sel.clear();
      if (!seul) T.sel.add(i);
    }
    T.dernier = i;
    majSelection();
  }
  function majSelection() {
    surbrillance.clearLayers();
    var n = 0;
    T.sel.forEach(function (i) {
      var r = T.lignes[i];
      if (!r.g || n++ > MAX_SURBRILLANCE) return;
      L.geoJSON(r.g, {
        style: { color: '#f2c230', weight: 4, fillColor: '#f2c230', fillOpacity: 0.3, interactive: false },
        pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 9, color: '#f2c230', weight: 3, fillOpacity: 0.3, interactive: false }); }
      }).addTo(surbrillance);
    });
    if ($('ta-mode').value === 'sel') filtrer(); else { dessiner(); compte(); }
  }
  function zoomer(lignes, ouvrirFiche) {
    var b = null;
    lignes.forEach(function (r) {
      if (!r || !r.bb) return;
      var e = L.latLngBounds([[r.bb[1], r.bb[0]], [r.bb[3], r.bb[2]]]);
      b = b ? b.extend(e) : e;
    });
    if (!b) return;
    if (b.getNorthEast().equals(b.getSouthWest())) map.setView(b.getCenter(), Math.max(map.getZoom(), 18));
    else map.fitBounds(b, { padding: [40, 40], maxZoom: 19 });
    var r = lignes[0];
    if (ouvrirFiche && lignes.length === 1 && r.layer && r.layer.getPopup && r.layer.getPopup() && map.hasLayer(r.layer)) {
      setTimeout(function () { r.layer.openPopup(); }, 400);
    }
  }

  // ---------- Export CSV ----------
  function csv() {
    var cols = colsVisibles(), idx = T.sel.size ? T.ordre.filter(function (i) { return T.sel.has(i); }) : T.ordre;
    if (T.sel.size && !idx.length) idx = Array.from(T.sel);
    var cell = function (c, v) {
      if (v == null) return '';
      var t = c.num ? String(Math.round(v * 100) / 100).replace('.', ',') : valeurTexte(v);
      return /[";\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    var lignes = [cols.map(function (c) { return cell({}, c.lib); }).join(';')].concat(idx.map(function (i) {
      var r = T.lignes[i];
      return cols.map(function (c) { return cell(c, c.get(r)); }).join(';');
    }));
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lignes.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = T.o.name.replace(/\s*\(.*?\)\s*/g, ' ').trim().replace(/[^\wÀ-ÿ-]+/g, '_') + '.csv';
    a.click();
  }

  // ---------- Colonnes affichées ----------
  function listeColonnes() {
    var div = $('ta-colonnes-liste');
    div.innerHTML = T.cols.map(function (c) {
      return '<label><input type="checkbox" data-k="' + esc(c.k) + '"' + (T.masquees[c.k] ? '' : ' checked') + '> ' + esc(c.lib) + '</label>';
    }).join('');
    div.querySelectorAll('input').forEach(function (i) {
      i.onchange = function () { T.masquees[i.dataset.k] = !i.checked; construire(); filtrer(); };
    });
  }

  // ---------- Commandes ----------
  var attente = 0;
  $('ta-recherche').addEventListener('input', function () {
    var v = this.value, n = ++attente;
    setTimeout(function () { if (T && n === attente) { T.filtre = v; filtrer(); } }, 200);
  });
  $('ta-mode').addEventListener('change', function () { if (T) filtrer(); });
  map.on('moveend', function () { if (T && $('ta-mode').value === 'visibles') filtrer(); });
  $('ta-zoom').onclick = function () {
    if (!T) return;
    var ids = T.sel.size ? Array.from(T.sel) : T.ordre;
    zoomer(ids.map(function (i) { return T.lignes[i]; }), false);
  };
  $('ta-tout').onclick = function () { if (T) { T.ordre.forEach(function (i) { T.sel.add(i); }); majSelection(); } };
  $('ta-aucun').onclick = function () { if (T) { T.sel.clear(); majSelection(); } };
  $('ta-csv').onclick = function () { if (T && T.cols.length) csv(); };
  $('ta-colonnes').onclick = function () {
    if (!T || !T.cols.length) return;
    var d = $('ta-colonnes-liste');
    if (d.classList.contains('hidden')) listeColonnes();
    d.classList.toggle('hidden');
  };
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.ta-colonnes-wrap')) $('ta-colonnes-liste').classList.add('hidden');
  });
  $('ta-agrandir').onclick = function () {
    tiroir.classList.toggle('agrandi');
    document.body.classList.toggle('drawer-grand', tiroir.classList.contains('agrandi'));
    setTimeout(function () { map.invalidateSize(); dessiner(); }, 300);
  };
  $('ta-fermer').onclick = fermer;
  window.addEventListener('resize', function () { if (T) dessiner(); });

  window.LabeTable = { ouvrir: ouvrir, fermer: fermer, ouverte: function () { return T && T.o.name; } };
})();
