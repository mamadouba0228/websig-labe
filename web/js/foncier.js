/* Foncier (espace agents) : registre des parcelles, dossiers fonciers (attribution, morcellement, fusion, mutation,
 * bornage…), contrôles (chevauchements, emprise des voies, domaine public, zones inondables, pentes, bâti sans parcelle). */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc;
  // Carte : 4 classes de statut juridique (couleurs vérifiées pour les daltoniens) ; le statut exact est dans la fiche
  var CLASSES = [
    { nom: 'Titre foncier', couleur: '#008300', statuts: ['Titre foncier'] },
    { nom: 'Droits non titrés', couleur: '#eda100', statuts: ['Permis d\'habiter', 'Attestation de cession', 'Acte coutumier'] },
    { nom: 'Domaine public, réserve', couleur: '#6250d6', statuts: ['Domaine public', 'Réserve communale'] },
    { nom: 'Non documenté', couleur: '#868e96', statuts: ['Non documenté'] }
  ];
  var CLOS = ['Approuvé', 'Rejeté', 'Abandonné'];
  var ETAPES = ['Déposé', 'En instruction', 'Visite effectuée', 'Avis', 'Décision'];
  var LABEL_ZOOM = 18, MAX_LABELS = 150;
  var TYPE_ALERTE = { chevauchement: 'Chevauchement', commune: 'Hors commune', emprise: 'Emprise de voie', berge: 'Berge de cours d\'eau',
    eau: 'Plan d\'eau', cimetiere: 'Cimetière', inondation: 'Zone inondable', pente: 'Pente', morcellement: 'Découpage', fusion: 'Fusion', litige: 'Litige en cours',
    environnement: 'Environnement' };
  var AIDE = {
    'Attribution': 'Nouveau terrain attribué par la commune : dessinez ses limites.',
    'Régularisation': 'Occupation de fait à régulariser : choisissez la parcelle recensée, ou dessinez le terrain.',
    'Morcellement': 'Découpage d\'une parcelle (partage, vente partielle) : choisissez la parcelle, puis découpez-la par une ou plusieurs lignes.',
    'Fusion': 'Réunion de parcelles voisines : choisissez au moins deux parcelles contiguës.',
    'Mutation (vente)': 'Changement de détenteur après une vente : choisissez la parcelle.',
    'Mutation (succession)': 'Changement de détenteur après un héritage : choisissez la parcelle.',
    'Mutation (donation)': 'Changement de détenteur après une donation : choisissez la parcelle.',
    'Bornage': 'Nouvelles limites relevées (bornage contradictoire) : choisissez la parcelle et redessinez ses limites.',
    'Changement d\'usage': 'Nouvel usage du terrain (ex. habitation → commerce) : choisissez la parcelle.'
  };

  function $(id) { return document.getElementById(id); }
  function api(m, p, b) { return Auth.api(m, '/foncier' + p, b); }
  function fail(e) { alert('Erreur : ' + e.message); }
  function sup() { return Auth.isValidator(); }
  function classe(statut) { for (var i = 0; i < CLASSES.length; i++) if (CLASSES[i].statuts.indexOf(statut) >= 0) return CLASSES[i]; return CLASSES[3]; }
  function cls(s) { return 'f-' + String(s).replace(/[\s']/g, '-'); }
  function dateFr(d) { return d ? new Date(d).toLocaleDateString('fr-FR') : ''; }
  function aujourdhui() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function enRetard(p) { return p.echeance && CLOS.indexOf(p.statut) < 0 && new Date(p.echeance) < aujourdhui(); }
  function toPolygon(pts) {
    var c = pts.map(function (p) { return [+p.lng.toFixed(7), +p.lat.toFixed(7)]; });
    return { type: 'Polygon', coordinates: [c.concat([c[0]])] };
  }
  function anneaux(g) { return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []; }
  function surfaceDe(g) {
    return anneaux(g).reduce(function (s, poly) { return s + A.polygonArea(poly[0].map(function (c) { return L.latLng(c[1], c[0]); })); }, 0);
  }
  function dansAnneau(x, y, ring) {
    var dedans = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) dedans = !dedans;
    }
    return dedans;
  }
  function contient(g, ll) {
    return anneaux(g).some(function (poly) {
      return dansAnneau(ll.lng, ll.lat, poly[0]) && !poly.slice(1).some(function (h) { return dansAnneau(ll.lng, ll.lat, h); });
    });
  }
  function btn(parent, texte, classe, fn) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = texte;
    if (classe) b.className = classe; b.onclick = fn; parent.appendChild(b); return b;
  }

  // ---------- Données et couches ----------
  var LISTES = null, parcelles = [], parById = {}, dossiers = [], tableau = null;
  var couche = A.markClicks(L.featureGroup()), surbrillance = L.featureGroup().addTo(map), apercu = L.featureGroup().addTo(map);
  var conflits = L.featureGroup(), sansParcelle = L.layerGroup();
  var coucheVoulue = true, archives = false, controlesVus = false;

  function style(p) {
    var c = classe(p.statut_juridique).couleur, bloquant = (p.alertes || []).some(function (a) { return a.niveau === 'bloquant'; });
    if (p.etat === 'Archivée') return { color: '#495057', weight: 1, dashArray: '2 4', fillOpacity: 0, opacity: 0.7 };
    return { color: bloquant ? '#c92a2a' : c, weight: bloquant ? 3 : 1.5, fillColor: c, fillOpacity: 0.28, opacity: 0.95,
      dashArray: p.etat === 'Provisoire' ? '5 4' : null };
  }
  // propriétés montrées par l'outil ⓘ (libellés lisibles)
  function proprietesAffichees(p) {
    return { libelle: 'Parcelle ' + p.numero, 'Statut juridique': p.statut_juridique, 'Référence de l\'acte': p.reference_acte,
      'Usage': p.usage, 'État': p.etat, 'Superficie': A.fmt(p.superficie_m2) + ' m²', 'Quartier': p.quartier,
      'Lotissement': p.lotissement ? p.lotissement + (p.lot ? ', lot ' + p.lot : '') : null };
  }
  function popup(p) {
    var d = document.createElement('div');
    d.className = 'popup';
    d.innerHTML = '<h4>Parcelle ' + esc(p.numero) + '</h4><table>' +
      [['Statut', p.statut_juridique + (p.reference_acte ? ' (' + p.reference_acte + ')' : '')], ['Usage', p.usage],
        ['État', p.etat], ['Superficie', A.fmt(p.superficie_m2) + ' m²'], ['Quartier', p.quartier]]
        .filter(function (r) { return r[1]; }).map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') +
      '</table>' + (p.alertes && p.alertes.length ? '<p class="fon-pop-alerte">⚠ ' + p.alertes.length + ' alerte(s)</p>' : '');
    var bar = document.createElement('div'); bar.className = 'row';
    btn(bar, 'Ouvrir la fiche', 'primary', function () { map.closePopup(); ouvrirParcelle(p.id); });
    d.appendChild(bar);
    return d;
  }
  function dessinerCouche() {
    couche.clearLayers(); parById = {};
    parcelles.forEach(function (f) {
      var p = f.properties;
      var l = L.geoJSON(f, { style: function () { return style(p); } }).getLayers()[0];
      l.feature = { type: 'Feature', geometry: f.geometry, properties: proprietesAffichees(p) };
      l.bindPopup(function () { return popup(p); }, { maxWidth: 320 });
      couche.addLayer(l);
      parById[p.id] = { f: f, l: l };
    });
    etiquettes();
  }
  function etiquettes() {
    var z = map.getZoom(), b = map.getBounds(), n = 0;
    Object.keys(parById).forEach(function (id) {
      var l = parById[id].l, show = coucheVoulue && z >= LABEL_ZOOM && n < MAX_LABELS && b.intersects(l.getBounds());
      if (show) {
        n++;
        if (!l.getTooltip()) l.bindTooltip(esc(parById[id].f.properties.numero.replace(/^LAB-/, '')), { permanent: true, direction: 'center', className: 'label-parcelle' });
        l.openTooltip();
      } else if (l.getTooltip()) l.unbindTooltip();
    });
  }
  map.on('moveend', etiquettes);

  function charger() {
    return Promise.all([api('GET', '/parcelles' + (archives ? '?archives=1' : '')), api('GET', '/dossiers'), api('GET', '/tableau-de-bord')])
      .then(function (r) {
        parcelles = r[0].features; dossiers = r[1].features; tableau = r[2];
        dessinerCouche(); rendre();
        if (controlesVus) chargerControles();
      }).catch(fail);
  }

  function surligner(geometry, couleur) {
    surbrillance.clearLayers();
    if (!geometry) return;
    var l = L.geoJSON(geometry, { style: { color: couleur || '#f2c230', weight: 4, fillOpacity: 0.1, interactive: false } }).addTo(surbrillance);
    var b = l.getBounds();
    if (b.isValid()) map.fitBounds(b, { padding: [60, 60], maxZoom: 19 });
  }

  // ---------- Panneau : registre ----------
  var F = { q: '', statut: '', etat: '', quartier: '', alertes: false };
  var FD = { statut: '', type: '', mien: false };
  function carte(v, lib, extra, action) {
    return '<div class="stat-card' + (extra ? ' ' + extra : '') + (action ? ' cliquable" data-a="' + action : '') + '"><b>' + v + '</b><span>' + lib + '</span></div>';
  }
  function remplir(sel, valeurs, vide) {
    var cur = sel.value;
    sel.innerHTML = '<option value="">' + vide + '</option>';
    valeurs.forEach(function (v) { sel.add(new Option(v, v, false, v === cur)); });
  }
  function rendre() {
    var actives = parcelles.filter(function (f) { return f.properties.etat !== 'Archivée'; });
    var n = { Provisoire: 0, 'Enregistrée': 0 }, alertes = 0, surf = 0;
    actives.forEach(function (f) {
      var p = f.properties; n[p.etat]++; surf += p.superficie_m2;
      if (p.alertes.some(function (a) { return a.niveau !== 'info'; })) alertes++;
    });
    var ouverts = dossiers.filter(function (d) { return CLOS.indexOf(d.properties.statut) < 0; });
    var retard = ouverts.filter(function (d) { return enRetard(d.properties); }).length;
    $('fon-cartes').innerHTML = carte(A.fmt(actives.length), 'parcelles (' + A.fmtArea(surf) + ')') +
      carte(A.fmt(n['Enregistrée']), 'enregistrées', '', 'etat:Enregistrée') +
      carte(A.fmt(n.Provisoire), 'provisoires (à valider)', '', 'etat:Provisoire') +
      carte(alertes, 'avec alertes', alertes ? 'alerte' : '', 'alertes') +
      carte(ouverts.length, 'dossiers en cours', '', 'dossiers') +
      carte(retard, 'dossiers en retard', retard ? 'alerte' : '', 'dossiers');
    $('fon-cartes').querySelectorAll('[data-a]').forEach(function (c) {
      c.onclick = function () {
        var a = c.dataset.a;
        if (a.indexOf('etat:') === 0) { F.etat = a.slice(5); $('fon-f-etat').value = F.etat; F.alertes = false; }
        if (a === 'alertes') { F.alertes = true; F.etat = ''; $('fon-f-etat').value = ''; }
        $('fon-f-alertes').checked = F.alertes;
        changerArchives();
        if (a === 'dossiers') sousOnglet('dos'); else $('fon-liste').scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });
    var dosATraiter = ouverts.filter(function (d) {
      var p = d.properties;
      return sup() ? p.statut === 'Avis favorable' : p.instructeur === Auth.user().id || (LISTES.peut_instruire && p.statut === 'Déposé');
    }).length;
    var aTraiter = (sup() ? n.Provisoire : 0) + dosATraiter;
    $('fon-badge').textContent = aTraiter; $('fon-badge').classList.toggle('hidden', !aTraiter);
    $('fon-dos-badge').textContent = dosATraiter; $('fon-dos-badge').classList.toggle('hidden', !dosATraiter);

    var quartiers = {};
    parcelles.forEach(function (f) { if (f.properties.quartier) quartiers[f.properties.quartier] = 1; });
    remplir($('fon-f-quartier'), Object.keys(quartiers).sort(), 'Tous les quartiers');
    rendreListe(); rendreDossiers(); rendreQuartiers();
  }
  function rendreListe() {
    var q = F.q.trim().toLowerCase();
    var list = parcelles.filter(function (f) {
      var p = f.properties;
      if (F.etat ? p.etat !== F.etat : p.etat === 'Archivée') return false;
      if (F.statut && p.statut_juridique !== F.statut) return false;
      if (F.quartier && p.quartier !== F.quartier) return false;
      if (F.alertes && !p.alertes.some(function (a) { return a.niveau !== 'info'; })) return false;
      return !q || [p.numero, p.reference_acte, p.lotissement, p.lot, p.observations].some(function (v) { return v && String(v).toLowerCase().indexOf(q) >= 0; });
    });
    $('fon-compte').textContent = list.length + ' parcelle(s)' + (list.length > 200 ? ' — 200 premières affichées' : '');
    var ul = $('fon-liste');
    ul.innerHTML = list.length ? '' : '<li class="empty"><small>Aucune parcelle pour ces critères.' +
      (parcelles.length ? '' : ' Commencez par « Recenser une parcelle ».') + '</small></li>';
    list.slice(0, 200).forEach(function (f) {
      var p = f.properties, li = document.createElement('li'), nb = p.alertes.filter(function (a) { return a.niveau !== 'info'; }).length;
      li.className = 'fon-li ' + cls(p.etat) + (nb ? ' retard' : '');
      li.style.borderLeftColor = classe(p.statut_juridique).couleur;
      li.innerHTML = '<b>' + esc(p.numero) + '</b> · ' + esc(p.usage) + '<small>' + esc(p.statut_juridique) +
        (p.reference_acte ? ' (' + esc(p.reference_acte) + ')' : '') + ' · ' + A.fmt(p.superficie_m2) + ' m² · ' + esc(p.quartier || '—') +
        ' · <span class="badge ' + cls(p.etat) + '">' + esc(p.etat) + '</span>' +
        (nb ? ' <b class="retard-txt">⚠ ' + nb + ' alerte(s)</b>' : '') + (p.dossiers_ouverts ? ' · 📁 dossier en cours' : '') + '</small>';
      li.onclick = function () { ouvrirParcelle(p.id); };
      ul.appendChild(li);
    });
  }
  function rendreDossiers() {
    var moi = Auth.user().id;
    var list = dossiers.filter(function (d) {
      var p = d.properties;
      if (FD.statut === '' && CLOS.indexOf(p.statut) >= 0) return false;
      if (FD.statut && FD.statut !== 'tous' && p.statut !== FD.statut) return false;
      if (FD.type && p.type !== FD.type) return false;
      return !FD.mien || p.instructeur === moi;
    }).sort(function (a, b) {
      return (enRetard(b.properties) - enRetard(a.properties)) || (new Date(a.properties.depose_le) - new Date(b.properties.depose_le));
    });
    var ul = $('fon-dossiers');
    ul.innerHTML = list.length ? '' : '<li class="empty"><small>Aucun dossier pour ces critères.</small></li>';
    list.slice(0, 200).forEach(function (d) {
      var p = d.properties, li = document.createElement('li');
      li.className = 'fon-dossier ' + cls(p.statut) + (enRetard(p) ? ' retard' : '');
      li.innerHTML = '<b>' + esc(p.numero) + ' — ' + esc(p.type) + '</b><small>' + esc(p.demandeur_nom) +
        (p.parcelles_numeros.length ? ' · ' + esc(p.parcelles_numeros.join(', ')) : '') + ' · ' + esc(p.quartier || '—') +
        ' · <span class="badge ' + cls(p.statut) + '">' + esc(p.statut) + '</span>' +
        (p.instructeur_nom ? '<br>Instruction : ' + esc(p.instructeur_nom) : '') +
        (p.echeance && CLOS.indexOf(p.statut) < 0 ? ' · échéance ' + dateFr(p.echeance) + (enRetard(p) ? ' <b class="retard-txt">en retard</b>' : '') : '') + '</small>';
      li.onclick = function () { ouvrirDossier(p.id); };
      ul.appendChild(li);
    });
  }
  function rendreQuartiers() {
    if (!tableau || !tableau.quartiers.length) { $('fon-quartiers').innerHTML = '<p class="hint">Aucune parcelle recensée.</p>'; return; }
    $('fon-quartiers').innerHTML = '<table class="info-table fon-table"><tr><th>Quartier</th><th>Parcelles</th><th>Enreg.</th><th>Titrées</th><th>Non doc.</th><th>Surface</th></tr>' +
      tableau.quartiers.map(function (q) {
        return '<tr><td>' + esc(q.quartier || '—') + '</td><td>' + q.parcelles + '</td><td>' + q.enregistrees + '</td><td>' + q.titrees +
          '</td><td>' + q.non_documentees + '</td><td>' + A.fmt(q.ha, 2) + ' ha</td></tr>';
      }).join('') + '</table>' +
      '<p class="hint">Statut juridique : ' + tableau.juridique.map(function (j) { return esc(j.statut_juridique) + ' ' + j.n; }).join(' · ') +
      (tableau.delai_moyen_j != null ? '<br>Délai moyen de décision des dossiers (90 j) : ' + A.fmt(tableau.delai_moyen_j, 1) + ' j' : '') + '</p>';
  }

  // ---------- Contrôles d'ensemble ----------
  function chargerControles() {
    var div = $('fon-controles');
    div.innerHTML = '<p class="hint">Contrôle en cours…</p>';
    api('GET', '/controles').then(function (c) {
      conflits.clearLayers();
      var html = '<div class="row"><label class="check"><input type="checkbox" id="fon-c-carte"' + (map.hasLayer(conflits) ? ' checked' : '') +
        '> Montrer les chevauchements sur la carte</label></div>';
      html += '<details class="adr-detail"' + (c.chevauchements.length ? ' open' : '') + '><summary>Chevauchements entre parcelles : <b>' +
        c.chevauchements.length + '</b></summary><ul class="fon-ctl">' +
        c.chevauchements.map(function (x, i) {
          return '<li data-c="' + i + '">' + esc(x.numero_a) + ' ↔ ' + esc(x.numero_b) + ' : <b>' + A.fmt(x.m2, 1) + ' m²</b></li>';
        }).join('') + '</ul></details>';
      var parType = {};
      c.risques.forEach(function (r) { (parType[r.alerte.type] = parType[r.alerte.type] || []).push(r); });
      Object.keys(parType).forEach(function (t) {
        html += '<details class="adr-detail"><summary>' + esc(TYPE_ALERTE[t] || t) + ' : <b>' + parType[t].length + '</b> parcelle(s)</summary><ul class="fon-ctl">' +
          parType[t].slice(0, 100).map(function (r) {
            return '<li data-p="' + r.id + '">' + esc(r.numero) + ' — ' + esc(r.alerte.message) + '</li>';
          }).join('') + '</ul></details>';
      });
      html += '<details class="adr-detail"><summary>Bâtiments sans parcelle (quartiers recensés)</summary>' +
        (c.couverture.length ? '<table class="info-table fon-table"><tr><th>Quartier</th><th>Bâtiments</th><th>Sur une parcelle</th><th></th></tr>' +
          c.couverture.map(function (q) {
            return '<tr><td>' + esc(q.quartier) + '</td><td>' + A.fmt(q.batiments) + '</td><td>' + A.fmt(q.couverts) + ' (' +
              Math.round(100 * q.couverts / q.batiments) + ' %)</td><td><button type="button" data-q="' + esc(q.quartier) + '">Voir</button></td></tr>';
          }).join('') + '</table>' : '<p class="hint">Aucun quartier recensé.</p>') + '</details>';
      div.innerHTML = html;
      c.chevauchements.forEach(function (x) {
        if (x.geometry) L.geoJSON(x.geometry, { style: { color: '#c92a2a', weight: 2, fillColor: '#c92a2a', fillOpacity: 0.6 }, interactive: false }).addTo(conflits);
      });
      $('fon-c-carte').onchange = function () { if (this.checked) conflits.addTo(map); else map.removeLayer(conflits); };
      div.querySelectorAll('[data-c]').forEach(function (li) {
        li.onclick = function () { conflits.addTo(map); $('fon-c-carte').checked = true; surligner(c.chevauchements[+li.dataset.c].geometry, '#c92a2a'); };
      });
      div.querySelectorAll('[data-p]').forEach(function (li) { li.onclick = function () { ouvrirParcelle(+li.dataset.p); }; });
      div.querySelectorAll('[data-q]').forEach(function (b) {
        b.onclick = function () {
          api('GET', '/batiments-sans-parcelle?quartier=' + encodeURIComponent(b.dataset.q)).then(function (pts) {
            sansParcelle.clearLayers();
            pts.forEach(function (p) {
              L.circleMarker([p.lat, p.lon], { radius: 4, color: '#fff', weight: 1, fillColor: '#c92a2a', fillOpacity: 0.9, interactive: false }).addTo(sansParcelle);
            });
            sansParcelle.addTo(map);
            var gp = L.featureGroup(sansParcelle.getLayers());
            if (pts.length) map.fitBounds(gp.getBounds(), { padding: [30, 30] });
            LabeTerrain.toast(pts.length + ' bâtiment(s) sans parcelle à ' + b.dataset.q + ' (points rouges). Désactivez-les dans l\'onglet Couches.');
          }).catch(fail);
        };
      });
    }).catch(function (e) { div.innerHTML = '<p class="form-msg">' + esc(e.message) + '</p>'; });
  }

  // ---------- Pente (modèle numérique de terrain, calculée dans le navigateur) ----------
  function pente(geometry) {
    if (!A.relief) return Promise.resolve(null);
    return A.relief.pret().then(function () {
      var ring = geometry.coordinates[0], xs = ring.map(function (c) { return c[0]; }), ys = ring.map(function (c) { return c[1]; });
      var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
      var pas = 8 / 111320, vals = [];
      for (var x = x0 + pas / 2; x < x1; x += pas)
        for (var y = y0 + pas / 2; y < y1; y += pas)
          if (dansAnneau(x, y, ring)) { var v = A.relief.valeurs(L.latLng(y, x)); if (v) vals.push(v.pente); }
      if (!vals.length) ring.forEach(function (c) { var v = A.relief.valeurs(L.latLng(c[1], c[0])); if (v) vals.push(v.pente); });
      if (!vals.length) return null;
      var moy = vals.reduce(function (s, v) { return s + v; }, 0) / vals.length;
      return { moyenne: moy, max: Math.max.apply(null, vals), forte: vals.filter(function (v) { return v >= 15; }).length / vals.length };
    }).catch(function () { return null; });
  }
  function alertePente(p) {
    if (!p || p.moyenne < 15 && p.forte < 0.25) return null;
    return { type: 'pente', niveau: p.moyenne >= 30 ? 'alerte' : 'info',
      message: 'Pente moyenne ' + A.fmt(p.moyenne, 1) + ' % (max ' + A.fmt(p.max, 0) + ' %) : ' +
        (p.moyenne >= 30 ? 'terrain très pentu, risque de glissement et d\'érosion.' : 'terrain pentu, terrassement et gestion des eaux à prévoir.') };
  }
  function listeAlertes(alertes) {
    if (!alertes || !alertes.length) return '<p class="fon-ok">✓ Aucune alerte : pas de chevauchement, ni d\'empiètement, ni de risque relevé.</p>';
    var ordre = { bloquant: 0, alerte: 1, info: 2 };
    return '<ul class="fon-alertes">' + alertes.slice().sort(function (a, b) { return ordre[a.niveau] - ordre[b.niveau]; }).map(function (a) {
      var ic = a.niveau === 'bloquant' ? '⛔' : a.niveau === 'alerte' ? '⚠' : 'ℹ';
      return '<li class="n-' + a.niveau + '"><span>' + ic + '</span> <b>' + esc(TYPE_ALERTE[a.type] || a.type) + '</b> — ' + esc(a.message) + '</li>';
    }).join('') + '</ul>';
  }

  // ---------- Fiche d'une parcelle ----------
  var vueFiche = null;
  function montrerFiche(html) {
    $('fon-liste-vue').classList.add('hidden');
    $('fon-fiche-vue').classList.remove('hidden');
    $('fon-fiche').innerHTML = '';
    if (typeof html === 'string') $('fon-fiche').innerHTML = html; else $('fon-fiche').appendChild(html);
    var tab = document.querySelector('.tab[data-tab="fon"]');
    if (!tab.classList.contains('active')) tab.click();
    if (document.body.classList.contains('collapsed')) document.body.classList.remove('collapsed');
    $('tab-fon').scrollTop = 0;
  }
  // ---------- Sous-onglets : registre, dossiers, litiges, bilan, fiscalité ----------
  var sousCourant = 'reg', surSousOnglet = {};
  function sousOnglet(k) {
    sousCourant = k;
    document.querySelectorAll('.fon-switch button').forEach(function (b) { b.classList.toggle('active', b.dataset.fon === k); });
    ['reg', 'dos', 'lit', 'bil', 'fis'].forEach(function (x) { $('fon-' + x).classList.toggle('hidden', x !== k); });
    if (!$('fon-fiche-vue').classList.contains('hidden')) $('fon-retour').click();
    if (surSousOnglet[k]) surSousOnglet[k]();
  }
  document.querySelectorAll('.fon-switch button').forEach(function (b) { b.onclick = function () { sousOnglet(b.dataset.fon); }; });

  $('fon-retour').onclick = function () {
    vueFiche = null; surbrillance.clearLayers(); apercu.clearLayers();
    $('fon-fiche-vue').classList.add('hidden'); $('fon-liste-vue').classList.remove('hidden');
  };
  function table(rows) {
    return '<table class="info-table">' + rows.filter(function (r) { return r[1] !== null && r[1] !== undefined && r[1] !== ''; })
      .map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + (r[2] ? r[1] : esc(r[1])) + '</td></tr>'; }).join('') + '</table>';
  }

  function ouvrirParcelle(id) {
    api('GET', '/parcelles/' + id).then(function (f) {
      vueFiche = { type: 'parcelle', id: id };
      var p = f.properties, d = document.createElement('div');
      surligner(f.geometry);
      d.innerHTML = '<h3>Parcelle ' + esc(p.numero) + '</h3>' +
        '<p><span class="badge ' + cls(p.etat) + '">' + esc(p.etat) + '</span> <span class="fon-classe" style="background:' +
        classe(p.statut_juridique).couleur + '"></span> ' + esc(p.statut_juridique) + '</p>' +
        table([['Usage', p.usage], ['Référence de l\'acte', p.reference_acte], ['Date de l\'acte', dateFr(p.date_acte)],
          ['Lotissement', p.lotissement ? p.lotissement + (p.lot ? ', lot ' + p.lot : '') : null],
          ['Superficie', A.fmt(p.superficie_m2) + ' m² (' + A.fmt(p.superficie_m2 / 10000, 4) + ' ha)'], ['Périmètre', A.fmt(p.perimetre_m) + ' m'],
          ['Quartier', p.quartier], ['Bâtiments', p.nb_batiments],
          ['Adresse(s)', f.adresses.map(function (a) { return a.libelle + (a.statut === 'Proposée' ? ' (proposée)' : ''); }).join(' ; ') || null],
          ['Origine des limites', p.source_geom + (p.precision_m != null ? ', précision ± ' + A.fmt(p.precision_m, 1) + ' m' : '')],
          ['Parcelle(s) d\'origine', p.meres_numeros.length ? p.meres_numeros.join(', ') : null],
          ['Issue(s) de cette parcelle', f.filles.length ? f.filles.map(function (x) { return '<a href="#" data-p="' + x.id + '">' + esc(x.numero) + '</a>'; }).join(', ') : null, true],
          ['Observations', p.observations], ['Recensée', dateFr(p.cree_le) + (p.cree_par_nom ? ' par ' + p.cree_par_nom : '')],
          ['Validée', p.valide_le ? dateFr(p.valide_le) + (p.valide_par_nom ? ' par ' + p.valide_par_nom : '') : null],
          ['Archivée', p.archive_le ? dateFr(p.archive_le) + ' — ' + (p.archive_motif || '') : null]]) +
        '<h4>Contrôles</h4><div class="fon-ctl-res">' + listeAlertes(p.alertes) + '</div><div class="fon-pente"></div>';
      var bar = document.createElement('div'); bar.className = 'row fon-actions';
      if (f.peut_modifier) {
        btn(bar, 'Modifier les informations', '', function () { formParcelle(f); });
        btn(bar, '✎ Modifier les limites', '', function () { modifierLimites(f); });
      }
      if (sup() && p.etat === 'Provisoire') btn(bar, '✓ Valider (enregistrer au registre)', 'primary', function () { validerParcelle(f); });
      if (p.etat !== 'Archivée') btn(bar, '+ Dossier sur cette parcelle', '', function () { nouveauDossier({ parcelles: [p.id] }); });
      if (p.etat === 'Provisoire' && f.peut_modifier) btn(bar, 'Supprimer', 'danger', function () {
        if (confirm('Supprimer la parcelle provisoire ' + p.numero + ' ?'))
          api('DELETE', '/parcelles/' + p.id).then(function () { $('fon-retour').click(); charger(); }).catch(fail);
      });
      d.appendChild(bar);
      if (f.dossiers.length) {
        var h = document.createElement('div');
        h.innerHTML = '<h4>Dossiers</h4><ul class="fon-ctl">' + f.dossiers.map(function (x) {
          return '<li data-d="' + x.id + '">' + esc(x.numero) + ' — ' + esc(x.type) + ' · <span class="badge ' + cls(x.statut) + '">' + esc(x.statut) + '</span> · ' + esc(x.demandeur_nom) + '</li>';
        }).join('') + '</ul>';
        d.appendChild(h);
      }
      var hist = document.createElement('div');
      hist.className = 'fon-bloc-histo';
      hist.innerHTML = '<h4>Historique</h4><ul class="histo fon-histo">' + f.historique.map(function (x) {
        return '<li><b>' + esc(x.action) + '</b> <small>' + new Date(x.date).toLocaleString('fr-FR') + (x.utilisateur ? ' · ' + esc(x.utilisateur) : '') +
          (x.dossier_numero ? ' · dossier ' + esc(x.dossier_numero) : '') + '</small>' + (x.commentaire ? '<br>' + esc(x.commentaire) : '') +
          (x.a_forme ? '<br><button type="button" class="petit" data-h="' + x.id + '">Voir les limites d\'avant</button>' : '') + '</li>';
      }).join('') + '</ul>';
      d.appendChild(hist);
      montrerFiche(d);
      if (window.LabeFoncierGestion) LabeFoncierGestion.completerParcelle(f, d);
      d.querySelectorAll('[data-p]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); ouvrirParcelle(+a.dataset.p); }; });
      d.querySelectorAll('[data-d]').forEach(function (li) { li.onclick = function () { ouvrirDossier(+li.dataset.d); }; });
      d.querySelectorAll('[data-h]').forEach(function (b) {
        b.onclick = function () {
          api('GET', '/parcelles/' + p.id + '/historique/' + b.dataset.h + '/forme').then(function (g) {
            apercu.clearLayers();
            L.geoJSON(g, { style: { color: '#c92a2a', weight: 2, dashArray: '4 4', fillOpacity: 0 }, interactive: false }).addTo(apercu);
            LabeTerrain.toast('Limites d\'avant en pointillés rouges, limites actuelles en jaune.');
          }).catch(fail);
        };
      });
      if (p.etat !== 'Archivée') pente(f.geometry).then(function (pt) {
        var el = d.querySelector('.fon-pente');
        if (!pt || !el) return;
        var a = alertePente(pt);
        el.innerHTML = a ? listeAlertes([a]).replace('<ul class="fon-alertes">', '<ul class="fon-alertes sans-haut">')
          : '<p class="hint">Pente moyenne ' + A.fmt(pt.moyenne, 1) + ' % (modèle numérique de terrain).</p>';
      });
    }).catch(fail);
  }

  function erreurControle(e, msgEl, forcerEl, alertesEl) {
    if (e.status === 409 && e.detail && e.detail.alertes) {
      alertesEl.innerHTML = listeAlertes(e.detail.alertes);
      if (sup() && forcerEl) forcerEl.classList.remove('hidden');
    }
    msgEl.textContent = e.message;
  }

  function validerParcelle(f) {
    var p = f.properties;
    api('POST', '/parcelles/' + p.id + '/valider', {}).then(function () { charger(); ouvrirParcelle(p.id); }).catch(function (e) {
      if (e.status !== 409) return fail(e);
      var motif = prompt(e.message + '\n\nPour valider quand même, indiquez le motif (sinon Annuler) :');
      if (!motif) return;
      api('POST', '/parcelles/' + p.id + '/valider', { forcer: true, commentaire: motif }).then(function () { charger(); ouvrirParcelle(p.id); }).catch(fail);
    });
  }

  function modifierLimites(f) {
    var p = f.properties;
    LabeEdition.editer(f.geometry, { label: 'Parcelle ' + p.numero + ' : limites', onSave: function (g) {
      var motif = p.etat === 'Enregistrée' ? prompt('Motif de la modification des limites (obligatoire pour une parcelle enregistrée) :') : null;
      if (p.etat === 'Enregistrée' && !motif) return;
      function envoyer(forcer) {
        api('PUT', '/parcelles/' + p.id, { geometry: g, commentaire: motif, forcer: forcer }).then(function () {
          LabeTerrain.toast('Limites enregistrées (les anciennes sont gardées dans l\'historique).');
          charger(); ouvrirParcelle(p.id);
        }).catch(function (e) {
          if (e.status === 409 && sup() && !forcer && confirm(e.message + '\n\nEnregistrer quand même ?')) return envoyer(true);
          fail(e);
        });
      }
      envoyer(false);
    } });
  }

  // ---------- Formulaire d'une parcelle (recensement, modification) ----------
  var pf = { form: $('fon-parcelle-form'), modal: $('fon-parcelle-modal'), geometry: null, feature: null };
  function formParcelle(feature, geometry) {
    var form = pf.form, el = form.elements, p = feature ? feature.properties : {};
    pf.feature = feature; pf.geometry = geometry || null;
    form.reset();
    ['usage', 'statut_juridique', 'source_geom'].forEach(function (k) {
      var list = { usage: LISTES.usages, statut_juridique: LISTES.statuts_juridiques, source_geom: LISTES.sources }[k];
      el[k].innerHTML = list.map(function (v) { return '<option>' + esc(v) + '</option>'; }).join('');
    });
    el.usage.value = p.usage || 'Habitation';
    el.statut_juridique.value = p.statut_juridique || 'Non documenté';
    el.source_geom.value = p.source_geom || (geometry && geometry.gps ? 'Levé GPS' : 'Digitalisation');
    ['reference_acte', 'date_acte', 'lotissement', 'lot', 'precision_m', 'observations'].forEach(function (k) { el[k].value = p[k] != null ? p[k] : ''; });
    if (geometry && geometry.precision) el.precision_m.value = Math.round(geometry.precision);
    $('fon-pf-titre').textContent = feature ? 'Parcelle ' + p.numero : 'Nouvelle parcelle (provisoire)';
    $('fon-pf-motif').classList.toggle('hidden', !(feature && p.etat === 'Enregistrée'));
    $('fon-pf-forcer').classList.add('hidden');
    $('fon-pf-msg').textContent = '';
    $('fon-pf-alertes').innerHTML = '';
    var g = geometry || (feature && feature.geometry);
    $('fon-pf-mesure').textContent = g ? 'Superficie ' + A.fmtArea(surfaceDe(g)) + (geometry ? ' · contrôle en cours…' : '') : '';
    pf.modal.classList.remove('hidden');
    if (geometry) {
      Promise.all([api('POST', '/controle', { geometry: { type: 'Polygon', coordinates: geometry.coordinates } }), pente(geometry)]).then(function (r) {
        var alertes = r[0].alertes.slice(), ap = alertePente(r[1]);
        if (ap) alertes.push(ap);
        $('fon-pf-alertes').innerHTML = listeAlertes(alertes);
        $('fon-pf-mesure').textContent = 'Superficie ' + A.fmtArea(surfaceDe(geometry));
        if (sup() && alertes.some(function (a) { return a.niveau === 'bloquant'; })) $('fon-pf-forcer').classList.remove('hidden');
      }).catch(function (e) { $('fon-pf-msg').textContent = e.message; });
    }
  }
  $('fon-pf-annuler').onclick = function () { pf.modal.classList.add('hidden'); apercu.clearLayers(); };
  pf.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var el = pf.form.elements, body = {};
    ['usage', 'statut_juridique', 'source_geom', 'reference_acte', 'date_acte', 'lotissement', 'lot', 'observations', 'commentaire'].forEach(function (k) {
      body[k] = el[k].value.trim() || null;
    });
    body.precision_m = el.precision_m.value === '' ? null : +el.precision_m.value;
    body.forcer = el.forcer.checked;
    if (pf.geometry) body.geometry = { type: 'Polygon', coordinates: pf.geometry.coordinates };
    var bouton = pf.form.querySelector('button[type=submit]'); bouton.disabled = true;
    var req = pf.feature ? api('PUT', '/parcelles/' + pf.feature.id, body) : api('POST', '/parcelles', body);
    req.then(function (f) {
      pf.modal.classList.add('hidden'); apercu.clearLayers();
      LabeTerrain.toast(pf.feature ? 'Parcelle modifiée.' : 'Parcelle ' + f.properties.numero + ' recensée (provisoire, à valider par un superviseur).');
      charger().then(function () { ouvrirParcelle(f.id); });
    }).catch(function (err) { erreurControle(err, $('fon-pf-msg'), $('fon-pf-forcer'), $('fon-pf-alertes')); })
      .then(function () { bouton.disabled = false; });
  });

  $('fon-ajouter').onclick = function () {
    A.startSketch('area', { btn: this, label: 'Nouvelle parcelle', onFinish: function (pts) {
      var g = toPolygon(pts);
      apercu.clearLayers();
      L.geoJSON(g, { style: { color: '#f2c230', weight: 3, fillOpacity: 0.15 }, interactive: false }).addTo(apercu);
      formParcelle(null, g);
    } });
  };
  $('fon-ajouter-gps').onclick = function () {
    LabeTerrain.traceGps('area', function (pts) {
      var g = toPolygon(pts); g.gps = true;
      apercu.clearLayers();
      L.geoJSON(g, { style: { color: '#f2c230', weight: 3, fillOpacity: 0.15 }, interactive: false }).addTo(apercu);
      formParcelle(null, g);
    });
  };

  // ---------- Import d'un levé (GeoJSON en WGS84) ----------
  $('fon-import-btn').onclick = function () { $('fon-import').click(); };
  $('fon-import').onchange = function () {
    var file = this.files[0]; this.value = '';
    if (!file) return;
    file.text().then(function (txt) {
      var gj = JSON.parse(txt), feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [{ type: 'Feature', geometry: gj, properties: {} }];
      feats = feats.filter(function (f) {
        return f.geometry && (f.geometry.type === 'Polygon' || (f.geometry.type === 'MultiPolygon' && f.geometry.coordinates.length === 1));
      });
      if (!feats.length) throw new Error('aucune surface (Polygon) dans le fichier.');
      if (feats.length > 500) throw new Error('500 parcelles au maximum par import.');
      var c0 = feats[0].geometry.type === 'Polygon' ? feats[0].geometry.coordinates[0][0] : feats[0].geometry.coordinates[0][0][0];
      if (Math.abs(c0[0]) > 180 || Math.abs(c0[1]) > 90) throw new Error('coordonnées en mètres : exportez le levé en WGS84 (EPSG:4326).');
      var source = confirm(feats.length + ' parcelle(s) à importer.\n\nOK = levé topographique, Annuler = plan de lotissement') ? 'Levé topographique' : 'Plan de lotissement';
      var ok = 0, refus = [];
      function val(p, k, list) { var v = p[k]; return v && (!list || list.indexOf(v) >= 0) ? String(v) : null; }
      return feats.reduce(function (chaine, f, i) {
        return chaine.then(function () {
          var p = f.properties || {};
          return api('POST', '/parcelles', { geometry: f.geometry, source_geom: source, usage: val(p, 'usage', LISTES.usages),
            statut_juridique: val(p, 'statut_juridique', LISTES.statuts_juridiques), reference_acte: val(p, 'reference_acte'),
            lotissement: val(p, 'lotissement'), lot: val(p, 'lot') || val(p, 'numero') || val(p, 'num_lot'),
            observations: 'Import ' + file.name })
            .then(function () { ok++; }).catch(function (e) { refus.push('n° ' + (i + 1) + ' : ' + e.message); });
        });
      }, Promise.resolve()).then(function () {
        alert(ok + ' parcelle(s) importée(s) (provisoires).' + (refus.length ? '\n\n' + refus.length + ' refusée(s) :\n' + refus.slice(0, 15).join('\n') : ''));
        charger();
      });
    }).catch(function (e) { alert('Import impossible : ' + e.message); });
  };

  // ---------- Choix de parcelles sur la carte ----------
  var choix = null, boiteChoix = document.createElement('div');
  boiteChoix.className = 'measure-box edit-box hidden';
  document.body.appendChild(boiteChoix);
  L.DomEvent.disableClickPropagation(boiteChoix);
  function parcelleEn(ll) {
    var res = null;
    parcelles.forEach(function (f) { if (!res && f.properties.etat !== 'Archivée' && contient(f.geometry, ll)) res = f; });
    return res;
  }
  function choisirParcelles(max, deja, fin) {
    choix = { ids: deja.slice(), max: max, fin: fin };
    A.stopSketch();
    A.capturerClic(clicChoix);
    map.getContainer().classList.add('crosshair');
    afficherChoix();
  }
  function afficherChoix() {
    apercu.clearLayers();
    choix.ids.forEach(function (id) {
      if (parById[id]) L.geoJSON(parById[id].f.geometry, { style: { color: '#f2c230', weight: 4, fillOpacity: 0.25 }, interactive: false }).addTo(apercu);
    });
    var noms = choix.ids.map(function (id) { return parById[id] ? parById[id].f.properties.numero : id; });
    boiteChoix.innerHTML = '<span><b>Choix des parcelles</b> · ' + (noms.length ? esc(noms.join(', ')) : 'cliquez une parcelle sur la carte') + '</span> ' +
      '<button data-a="ok" class="primary">Terminer</button> <button data-a="x">✕</button>';
    boiteChoix.classList.remove('hidden');
  }
  function clicChoix(e) {
    var f = parcelleEn(e.latlng);
    if (!f) return LabeTerrain.toast('Pas de parcelle du registre ici.');
    var i = choix.ids.indexOf(f.id);
    if (i >= 0) choix.ids.splice(i, 1);
    else { if (choix.max === 1) choix.ids = []; choix.ids.push(f.id); }
    afficherChoix();
  }
  function finChoix(valider) {
    A.libererClic(clicChoix);
    map.getContainer().classList.remove('crosshair');
    boiteChoix.classList.add('hidden');
    var c = choix; choix = null;
    if (valider) c.fin(c.ids); else c.fin(null);
  }
  boiteChoix.addEventListener('click', function (e) {
    var a = e.target.dataset.a;
    if (a === 'ok') finChoix(true);
    if (a === 'x') finChoix(false);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && choix) finChoix(false); });

  // ---------- Nouveau dossier ----------
  var nd = null, df = { form: $('fon-dossier-form'), modal: $('fon-dossier-modal') };
  function regle(type) { return LISTES.regles[type] || { parcelles: null, forme: 'option' }; }
  function nouveauDossier(preset) {
    var el = df.form.elements;
    df.form.reset();
    nd = { parcelles: (preset && preset.parcelles) || [], parties: [] };
    el.type.innerHTML = LISTES.types_dossier.map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('');
    el.type.value = nd.parcelles.length ? 'Mutation (vente)' : 'Attribution';
    el.statut_juridique.innerHTML = '<option value="">— inchangé —</option>' + LISTES.statuts_juridiques.map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('');
    el.usage_demande.innerHTML = '<option value="">— inchangé —</option>' + LISTES.usages.map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('');
    $('fon-df-msg').textContent = '';
    majDossierForm();
    df.modal.classList.remove('hidden');
  }
  function cacherModal() { df.modal.classList.add('hidden'); }
  function reouvrir() { df.modal.classList.remove('hidden'); majDossierForm(); }
  function majDossierForm() {
    var el = df.form.elements, t = el.type.value, r = regle(t);
    $('fon-df-aide').textContent = AIDE[t] || '';
    $('fon-df-juridique').classList.toggle('hidden', !(/Mutation|Régularisation|Attribution/.test(t)));
    $('fon-df-usage').classList.toggle('hidden', !(t === 'Changement d\'usage' || t === 'Attribution'));
    // parcelles concernées
    var bp = $('fon-df-parcelles');
    bp.innerHTML = '';
    if (r.parcelles !== 0) {
      var noms = nd.parcelles.map(function (id) { return parById[id] ? parById[id].f.properties.numero : '#' + id; });
      bp.innerHTML = '<b>Parcelle(s) concernée(s)</b> : ' + (noms.length ? esc(noms.join(', ')) : '<i>aucune</i>') + ' ';
      btn(bp, '⌖ Choisir sur la carte', 'petit', function () {
        cacherModal();
        choisirParcelles(r.parcelles === 1 ? 1 : 99, nd.parcelles, function (ids) {
          if (ids) { nd.parcelles = ids; if (t === 'Morcellement') nd.parties = []; }
          reouvrir();
        });
      });
    } else nd.parcelles = [];
    // limites proposées
    var bl = $('fon-df-limites');
    bl.innerHTML = '';
    if (r.forme !== 'aucune') {
      var surf = nd.parties.map(function (c) { return A.fmtArea(surfaceDe({ type: 'Polygon', coordinates: c })); });
      bl.innerHTML = '<b>Limites proposées</b> : ' + (nd.parties.length ? nd.parties.length + ' surface(s) — ' + surf.join(', ') : '<i>non dessinées</i>') + ' ';
      if (t === 'Morcellement') {
        btn(bl, '✂ Découper par une ligne', 'petit', function () {
          if (nd.parcelles.length !== 1) return alert('Choisissez d\'abord la parcelle à découper.');
          cacherModal();
          A.startSketch('line', { label: 'Tracez la ligne de découpage en traversant la parcelle', onCancel: reouvrir, onFinish: function (pts) {
            var g = nd.parties.length ? { type: 'MultiPolygon', coordinates: nd.parties } : parById[nd.parcelles[0]].f.geometry;
            api('POST', '/decouper', { geometry: g, ligne: { type: 'LineString', coordinates: pts.map(function (p) { return [p.lng, p.lat]; }) } })
              .then(function (r2) { nd.parties = r2.coordinates; }).catch(fail).then(reouvrir);
          } });
        });
      } else {
        btn(bl, nd.parties.length && r.forme !== 'plusieurs' ? '⬠ Redessiner' : '⬠ Dessiner', 'petit', function () {
          cacherModal();
          A.startSketch('area', { label: 'Limites proposées', onCancel: reouvrir, onFinish: function (pts) {
            nd.parties = [toPolygon(pts).coordinates]; reouvrir();
          } });
        });
        if (t === 'Bornage' && nd.parcelles.length === 1 && !nd.parties.length) btn(bl, '✎ Partir des limites actuelles', 'petit', function () {
          cacherModal();
          LabeEdition.editer(parById[nd.parcelles[0]].f.geometry, { label: 'Limites bornées', onSave: function (g) { nd.parties = [g.coordinates]; reouvrir(); }, onCancel: reouvrir });
        });
      }
      if (nd.parties.length) btn(bl, 'Effacer', 'petit', function () { nd.parties = []; majDossierForm(); });
    } else nd.parties = [];
    // aperçu et contrôles
    apercu.clearLayers();
    nd.parcelles.forEach(function (id) {
      if (parById[id]) L.geoJSON(parById[id].f.geometry, { style: { color: '#f2c230', weight: 4, fillOpacity: 0.1 }, interactive: false }).addTo(apercu);
    });
    nd.parties.forEach(function (c, i) {
      L.geoJSON({ type: 'Polygon', coordinates: c }, { style: { color: '#e8590c', weight: 2.5, dashArray: '6 4', fillOpacity: 0.15 }, interactive: false })
        .bindTooltip(String(i + 1), { permanent: true, direction: 'center', className: 'label-parcelle' }).addTo(apercu);
    });
    $('fon-df-alertes').innerHTML = '';
    if (nd.parties.length) {
      api('POST', '/controle', { geometry: { type: 'MultiPolygon', coordinates: nd.parties }, exclure: nd.parcelles }).then(function (res) {
        $('fon-df-alertes').innerHTML = listeAlertes(res.alertes);
      }).catch(function () {});
    }
  }
  df.form.elements.type.addEventListener('change', function () { nd.parties = []; majDossierForm(); });
  $('fon-df-annuler').onclick = function () { cacherModal(); apercu.clearLayers(); nd = null; };
  df.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var el = df.form.elements, t = el.type.value;
    var body = { type: t, parcelles: nd.parcelles, demandeur_nom: el.demandeur_nom.value.trim(),
      demandeur_telephone: el.demandeur_telephone.value.trim() || null, demandeur_piece: el.demandeur_piece.value.trim() || null,
      statut_juridique: el.statut_juridique.value || null, reference_acte: el.reference_acte.value.trim() || null,
      usage_demande: el.usage_demande.value || null, objet: el.objet.value.trim() || null, echeance: el.echeance.value || null };
    if (nd.parties.length) body.geometry = nd.parties.length === 1 ? { type: 'Polygon', coordinates: nd.parties[0] } : { type: 'MultiPolygon', coordinates: nd.parties };
    var bouton = df.form.querySelector('button[type=submit]'); bouton.disabled = true;
    api('POST', '/dossiers', body).then(function (d) {
      cacherModal(); apercu.clearLayers(); nd = null;
      LabeTerrain.toast('Dossier ' + d.properties.numero + ' déposé.');
      charger().then(function () { ouvrirDossier(d.id); });
    }).catch(function (err) { $('fon-df-msg').textContent = err.message; }).then(function () { bouton.disabled = false; });
  });
  $('fon-nouveau-dossier').onclick = function () { nouveauDossier(); };

  // ---------- Fiche d'un dossier ----------
  function etapeAtteinte(statut) {
    return { 'Déposé': 0, 'En instruction': 1, 'Visite effectuée': 2, 'Avis favorable': 3, 'Avis défavorable': 3, 'Approuvé': 4, 'Rejeté': 4, 'Abandonné': -1 }[statut];
  }
  function ouvrirDossier(id) {
    api('GET', '/dossiers/' + id).then(function (f) {
      vueFiche = { type: 'dossier', id: id };
      var p = f.properties, d = document.createElement('div'), moi = Auth.user(), clos = CLOS.indexOf(p.statut) >= 0;
      var instr = sup() || p.instructeur === moi.id, k = etapeAtteinte(p.statut), r = regle(p.type);
      apercu.clearLayers();
      surligner(f.geometry, '#e8590c');
      d.innerHTML = '<h3>Dossier ' + esc(p.numero) + '</h3><p><b>' + esc(p.type) + '</b> · <span class="badge ' + cls(p.statut) + '">' + esc(p.statut) + '</span>' +
        (enRetard(p) ? ' <b class="retard-txt">en retard</b>' : '') + '</p>' +
        '<ol class="fon-etapes">' + ETAPES.map(function (e, i) {
          return '<li class="' + (i < k || (i === k && clos) ? 'fait' : i === k ? 'actuel' : '') + '">' + e + '</li>';
        }).join('') + '</ol>' +
        table([['Demandeur', p.demandeur_nom], ['Téléphone', p.demandeur_telephone], ['Pièce d\'identité', p.demandeur_piece],
          ['Parcelle(s)', p.parcelles.map(function (pid, i) { return '<a href="#" data-p="' + pid + '">' + esc(p.parcelles_numeros[i] || pid) + '</a>'; }).join(', ') || null, true],
          ['Quartier', p.quartier], ['Objet', p.objet], ['Usage demandé', p.usage_demande],
          ['Statut après décision', p.statut_juridique], ['Référence de l\'acte', p.reference_acte],
          ['Déposé', dateFr(p.depose_le) + (p.depose_par_nom ? ' par ' + p.depose_par_nom : '')],
          ['Instructeur', p.instructeur_nom], ['Échéance', dateFr(p.echeance)],
          ['Visite de terrain', p.visite_le ? dateFr(p.visite_le) + ' — ' + (p.compte_rendu || '') : null], ['Avis', p.avis_motif],
          ['Décision', p.decide_le ? dateFr(p.decide_le) + (p.decision_ref ? ' — ' + p.decision_ref : '') + (p.decide_par_nom ? ' (' + p.decide_par_nom + ')' : '') : null],
          ['Motif', p.motif_rejet],
          ['Parcelle(s) créée(s)', p.parcelles_creees.map(function (pid, i) { return '<a href="#" data-p="' + pid + '">' + esc(p.creees_numeros[i] || pid) + '</a>'; }).join(', ') || null, true]]) +
        (r.forme !== 'aucune' || p.alertes.length ? '<h4>Contrôles des limites proposées</h4>' + listeAlertes(p.alertes) : '');
      var bar = document.createElement('div'); bar.className = 'row fon-actions';
      var sous = document.createElement('div'); sous.className = 'fon-sous';
      function formulaire(titre, champs, texteOk, action) {
        sous.innerHTML = '<h4>' + titre + '</h4>' + champs + '<p class="form-msg"></p>';
        var row = document.createElement('div'); row.className = 'row';
        btn(row, 'Annuler', '', function () { sous.innerHTML = ''; });
        btn(row, texteOk, 'primary', function () {
          var body = { action: action };
          sous.querySelectorAll('[name]').forEach(function (i) {
            body[i.name] = i.type === 'checkbox' ? i.checked : (i.value.trim() || null);
            if (i.name === 'instructeur' && body.instructeur) body.instructeur = +body.instructeur;
          });
          api('POST', '/dossiers/' + p.id + '/action', body).then(function () { charger(); ouvrirDossier(p.id); }).catch(function (e) {
            sous.querySelector('.form-msg').textContent = e.message;
            if (e.status === 409 && e.detail && e.detail.alertes && action === 'approuver') sous.querySelector('.fon-forcer').classList.remove('hidden');
          });
        });
        sous.appendChild(row);
        sous.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      if (!clos) {
        if (LISTES.peut_instruire && (p.statut === 'Déposé' || p.statut === 'En instruction')) {
          btn(bar, p.statut === 'Déposé' ? 'Mettre en instruction' : 'Changer d\'instructeur', p.statut === 'Déposé' ? 'primary' : '', function () {
            formulaire('Instruction', '<label>Instructeur<select name="instructeur">' + (f.instructeurs || []).map(function (u) {
              return '<option value="' + u.id + '"' + (u.id === (p.instructeur || moi.id) ? ' selected' : '') + '>' + esc(u.nom) + '</option>';
            }).join('') + '</select></label><label>Échéance<input type="date" name="echeance" value="' + (p.echeance || '') + '"></label>' +
              '<label>Consigne<input name="commentaire" maxlength="1000"></label>', 'Enregistrer', 'instruire');
          });
        }
        if (instr && p.statut === 'En instruction') btn(bar, 'Compte rendu de visite', 'primary', function () {
          formulaire('Visite de terrain', '<label>Date de la visite<input type="date" name="visite_le" value="' + new Date().toISOString().slice(0, 10) + '"></label>' +
            '<label>Compte rendu *<textarea name="commentaire" rows="3" maxlength="2000" placeholder="Bornes, voisins présents, occupation, litiges…"></textarea></label>',
            'Enregistrer la visite', 'visite');
        });
        if (instr && r.forme !== 'aucune' && k >= 1) btn(bar, '✎ Limites relevées', '', function () { limitesDossier(f); });
        if (instr && ['Visite effectuée', 'Avis favorable', 'Avis défavorable'].indexOf(p.statut) >= 0) {
          btn(bar, 'Avis favorable', p.statut === 'Visite effectuée' ? 'primary' : '', function () {
            formulaire('Avis favorable', '<label>Observations<textarea name="commentaire" rows="2" maxlength="2000"></textarea></label>', 'Donner l\'avis', 'avis_favorable');
          });
          btn(bar, 'Avis défavorable', '', function () {
            formulaire('Avis défavorable', '<label>Motif *<textarea name="commentaire" rows="2" maxlength="2000"></textarea></label>', 'Donner l\'avis', 'avis_defavorable');
          });
        }
        if (sup() && p.statut === 'Avis favorable') btn(bar, '✓ Approuver (décision)', 'primary', function () {
          formulaire('Décision d\'approbation', '<label>Référence de la décision *<input name="decision_ref" maxlength="120" placeholder="ex. Arrêté n° 2026-045 du 03/11/2026"></label>' +
            '<label>Observations<input name="commentaire" maxlength="1000"></label>' +
            '<label class="check fon-forcer hidden"><input type="checkbox" name="forcer"> Approuver malgré le contrôle bloquant (motif obligatoire ci-dessus)</label>' +
            '<p class="hint">La décision est appliquée au registre : ' + ({ 'Attribution': 'nouvelle parcelle enregistrée', 'Morcellement': 'parcelle mère archivée, nouvelles parcelles créées',
              'Fusion': 'parcelles archivées, parcelle réunie créée', 'Bornage': 'nouvelles limites (les anciennes restent dans l\'historique)' }[p.type] || 'parcelle mise à jour') + '.</p>',
            'Approuver', 'approuver');
        });
        if (sup()) btn(bar, 'Rejeter', 'danger', function () {
          formulaire('Rejet du dossier', '<label>Motif *<textarea name="commentaire" rows="2" maxlength="2000"></textarea></label>' +
            '<label>Référence de la décision<input name="decision_ref" maxlength="120"></label>', 'Rejeter', 'rejeter');
        });
        if (sup() || p.depose_par === moi.id) btn(bar, 'Abandonner', '', function () {
          formulaire('Abandon du dossier', '<label>Motif<input name="commentaire" maxlength="1000" placeholder="ex. retrait de la demande"></label>', 'Abandonner', 'abandonner');
        });
      }
      btn(bar, 'Commenter', '', function () {
        formulaire('Commentaire', '<label>Commentaire<textarea name="commentaire" rows="2" maxlength="2000"></textarea></label>', 'Ajouter', 'commenter');
      });
      d.appendChild(bar);
      d.appendChild(sous);
      var hist = document.createElement('div');
      hist.innerHTML = '<h4>Historique</h4><ul class="histo fon-histo">' + f.historique.map(function (x) {
        return '<li><b>' + esc(x.action) + '</b> <small>' + new Date(x.date).toLocaleString('fr-FR') + (x.utilisateur ? ' · ' + esc(x.utilisateur) : '') +
          (x.statut_apres && x.statut_apres !== x.statut_avant ? ' · → ' + esc(x.statut_apres) : '') + '</small>' + (x.commentaire ? '<br>' + esc(x.commentaire) : '') + '</li>';
      }).join('') + '</ul>';
      hist.className = 'fon-bloc-histo';
      d.appendChild(hist);
      montrerFiche(d);
      if (window.LabeFoncierGestion) LabeFoncierGestion.completerDossier(f, d);
      d.querySelectorAll('[data-p]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); ouvrirParcelle(+a.dataset.p); }; });
    }).catch(fail);
  }
  function limitesDossier(f) {
    var p = f.properties, r = regle(p.type);
    function envoyer(g) {
      api('POST', '/dossiers/' + p.id + '/action', { action: 'limites', geometry: g, commentaire: 'limites relevées sur le terrain' })
        .then(function () { LabeTerrain.toast('Limites du dossier enregistrées.'); ouvrirDossier(p.id); }).catch(fail);
    }
    if (r.forme === 'plusieurs') {
      // morcellement : nouveau découpage de la parcelle mère
      var mere = parById[p.parcelles[0]];
      if (!mere) return alert('Parcelle mère introuvable.');
      var parties = [];
      (function couper() {
        A.startSketch('line', { label: 'Ligne de découpage (' + (parties.length ? parties.length + ' morceaux' : 'parcelle entière') + ')', onFinish: function (pts) {
          api('POST', '/decouper', { geometry: parties.length ? { type: 'MultiPolygon', coordinates: parties } : mere.f.geometry,
            ligne: { type: 'LineString', coordinates: pts.map(function (x) { return [x.lng, x.lat]; }) } }).then(function (res) {
            parties = res.coordinates;
            apercu.clearLayers();
            parties.forEach(function (c) { L.geoJSON({ type: 'Polygon', coordinates: c }, { style: { color: '#e8590c', weight: 2.5, dashArray: '6 4', fillOpacity: 0.15 }, interactive: false }).addTo(apercu); });
            if (confirm(parties.length + ' parcelles. Ajouter une autre ligne de découpage ?')) couper();
            else envoyer({ type: 'MultiPolygon', coordinates: parties });
          }).catch(fail);
        } });
      })();
      return;
    }
    var g = f.geometry && f.geometry.type === 'MultiPolygon' ? { type: 'Polygon', coordinates: f.geometry.coordinates[0] } : f.geometry;
    LabeEdition.editer(g, { label: 'Dossier ' + p.numero + ' : limites relevées', onSave: envoyer });
  }

  // ---------- Paramètres ----------
  function chargerParametres() {
    api('GET', '/parametres').then(function (list) {
      var admin = Auth.user().role === 'admin';
      $('fon-parametres').innerHTML = '<table class="info-table fon-table">' + list.map(function (x) {
        return '<tr><td>' + esc(x.libelle) + '</td><td>' + (admin ? '<input type="number" min="0" max="1000" step="0.5" data-k="' + esc(x.cle) + '" value="' + x.valeur + '">' : A.fmt(x.valeur, 1)) + '</td></tr>';
      }).join('') + '</table>' + (admin ? '<p class="hint">Modifiable par un administrateur. Faites ensuite « Refaire tous les contrôles ».</p>' : '');
      $('fon-parametres').querySelectorAll('[data-k]').forEach(function (i) {
        i.onchange = function () { api('PUT', '/parametres/' + encodeURIComponent(i.dataset.k), { valeur: +i.value }).then(function () { LabeTerrain.toast('Paramètre enregistré.'); }).catch(fail); };
      });
    }).catch(function () {});
  }

  // ---------- Filtres et boutons ----------
  function changerArchives() {
    var voulu = F.etat === 'Archivée';
    if (voulu !== archives) { archives = voulu; charger(); } else rendreListe();
  }
  $('fon-recherche').addEventListener('input', function () { F.q = this.value; rendreListe(); });
  $('fon-f-statut').onchange = function () { F.statut = this.value; rendreListe(); };
  $('fon-f-etat').onchange = function () { F.etat = this.value; changerArchives(); };
  $('fon-f-quartier').onchange = function () { F.quartier = this.value; rendreListe(); };
  $('fon-f-alertes').onchange = function () { F.alertes = this.checked; rendreListe(); };
  $('fon-d-statut').onchange = function () { FD.statut = this.value; rendreDossiers(); };
  $('fon-d-type').onchange = function () { FD.type = this.value; rendreDossiers(); };
  $('fon-d-mien').onchange = function () { FD.mien = this.checked; rendreDossiers(); };
  $('fon-export').onclick = function () {
    Auth.blobUrl('/api/foncier/export.csv').then(function (url) {
      var a = document.createElement('a'); a.href = url; a.download = 'registre_foncier_labe.csv'; a.click();
    }).catch(function () { alert('Export impossible.'); });
  };
  $('fon-recontroler').onclick = function () {
    var b = this; b.disabled = true;
    api('POST', '/parcelles/recontroler').then(function (r) { LabeTerrain.toast(r.parcelles + ' parcelle(s) contrôlée(s).'); charger(); chargerControles(); })
      .catch(fail).then(function () { b.disabled = false; });
  };

  // table attributaire : tous les attributs utiles du registre (les données personnelles n'y figurent pas)
  function tableParcelles() {
    return parcelles.map(function (f) {
      var p = f.properties;
      return { layer: parById[p.id] && parById[p.id].l, feature: { type: 'Feature', geometry: f.geometry, properties: {
        'Numéro': p.numero, 'Quartier': p.quartier, 'Usage': p.usage, 'Statut juridique': p.statut_juridique,
        'Référence de l\'acte': p.reference_acte, 'Date de l\'acte': p.date_acte, 'Lotissement': p.lotissement, 'Lot': p.lot,
        'État': p.etat, 'Superficie (m²)': p.superficie_m2, 'Périmètre (m)': p.perimetre_m, 'Origine des limites': p.source_geom,
        'Précision (m)': p.precision_m, 'Alertes': p.alertes.filter(function (a) { return a.niveau !== 'info'; }).length,
        'Dossiers en cours': p.dossiers_ouverts, 'Litiges en cours': p.litiges_ouverts, 'Recensée le': p.cree_le,
        'Validée le': p.valide_le } } };
    });
  }

  // ---------- Démarrage ----------
  function start() {
    api('GET', '/listes').then(function (l) {
      LISTES = l;
      remplir($('fon-f-statut'), l.statuts_juridiques, 'Tous les statuts juridiques');
      remplir($('fon-d-type'), l.types_dossier, 'Tous les types');
      document.querySelectorAll('.validator-only-fon').forEach(function (e) { e.classList.toggle('hidden', !sup()); });
      A.addOverlay({ name: 'Parcelles (registre foncier)', layer: couche, on: true, group: 'Foncier', table: tableParcelles,
        onToggle: function (on) { coucheVoulue = on; if (on) couche.addTo(map); else map.removeLayer(couche); etiquettes(); },
        swatch: '<span class="swatch" style="background:' + CLASSES[1].couleur + '"></span>',
        legend: CLASSES.map(function (c) { return [c.nom + (c.statuts.length > 1 ? ' (' + c.statuts.join(', ').toLowerCase() + ')' : ''), c.couleur]; })
          .concat([['Contour en tirets : provisoire', '#495057', 'line'], ['Contour rouge épais : contrôle bloquant', '#c92a2a', 'line']]) });
      A.addOverlay({ name: 'Bâtiments sans parcelle (contrôle)', layer: sansParcelle, on: false, group: 'Foncier', table: false,
        swatch: '<span class="swatch dot" style="background:#c92a2a"></span>' });
      A.enregistrerIdentifiable(couche, 'Parcelles (registre foncier)');
      chargerParametres();
      return charger();
    }).then(function () {
      // contrôles d'ensemble : calculés à la première ouverture de l'onglet, puis après chaque changement
      var tab = document.querySelector('.tab[data-tab="fon"]');
      tab.addEventListener('click', function () { if (!controlesVus) { controlesVus = true; chargerControles(); } });
      if (tab.classList.contains('active')) { controlesVus = true; chargerControles(); }
    }).catch(fail);
  }

  window.LabeFoncier = { start: start, ouvrirParcelle: function (id) { ouvrirParcelle(id); }, ouvrirDossier: function (id) { ouvrirDossier(id); },
    recharger: charger, parcelleEn: parcelleEn,
    // outils partagés avec foncier-gestion.js (titulaires, pièces, litiges, bilan, fiscalité)
    outils: { api: api, btn: btn, table: table, dateFr: dateFr, cls: cls, fail: fail, sup: sup, montrerFiche: montrerFiche,
      surligner: surligner, apercu: apercu, listeAlertes: listeAlertes, choisirParcelles: choisirParcelles, CLASSES: CLASSES,
      listes: function () { return LISTES; }, parcelle: function (id) { return parById[id] && parById[id].f; },
      parcelles: function () { return parcelles; }, dossiers: function () { return dossiers; },
      sousOnglet: sousOnglet, surSousOnglet: surSousOnglet, sousCourant: function () { return sousCourant; } } };
})();
