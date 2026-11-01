/* Gestion des déchets (espace agents) :
 * - points de collecte et dépotoirs (dépôts sauvages, bacs, points de regroupement…), constats avec photo ;
 * - signalements « Dépôt d'ordures » convertis en dépôts sauvages ;
 * - tournées de collecte : points dans l'ordre de passage, trajet calculé sur les rues ou tracé à la main ;
 * - terrain : passage du jour, chaque point marqué collecté / saturé / non collecté (fonctionne hors connexion) ;
 * - bilan : dépôts par quartier, réalisation des tournées, motifs de non-collecte, couverture du service. */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc, S = window.LabeDechetsCarte;
  var JOURS_COURTS = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];

  function $(id) { return document.getElementById(id); }
  function api(m, p, b) { return Auth.api(m, '/dechets' + p, b); }
  function fail(e) { alert('Erreur : ' + e.message); }
  function gerer() { return !!(LISTES && LISTES.peut_gerer); }
  function dateFr(d) { return d ? new Date(d).toLocaleDateString('fr-FR') : ''; }
  function heureFr(d) { return d ? new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''; }
  function jourIso(d) { var x = d || new Date(); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
  function cls(s) { return 'd-' + String(s).replace(/[\s'/]/g, '-'); }
  function m3(v) { return v != null ? A.fmt(v, 1) + ' m³' : null; }
  function duree(min) { return min == null ? null : min < 60 ? Math.round(min) + ' min' : Math.floor(min / 60) + ' h ' + String(Math.round(min % 60)).padStart(2, '0'); }
  function btn(parent, texte, classe, fn) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = texte;
    if (classe) b.className = classe; b.onclick = fn; parent.appendChild(b); return b;
  }
  function table(rows) {
    return '<table class="info-table">' + rows.filter(function (r) { return r[1] !== null && r[1] !== undefined && r[1] !== ''; })
      .map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + (r[2] ? r[1] : esc(r[1])) + '</td></tr>'; }).join('') + '</table>';
  }
  function carte(v, lib, extra, action) {
    return '<div class="stat-card' + (extra ? ' ' + extra : '') + (action ? ' cliquable" data-a="' + action : '') + '"><b>' + v + '</b><span>' + lib + '</span></div>';
  }
  function remplir(sel, valeurs, vide) {
    var cur = sel.value;
    sel.innerHTML = vide != null ? '<option value="">' + esc(vide) + '</option>' : '';
    valeurs.forEach(function (v) { sel.add(new Option(v, v, false, v === cur)); });
  }
  function telecharger(chemin, nom) {
    Auth.blobUrl('/api/dechets' + chemin).then(function (u) {
      var a = document.createElement('a'); a.href = u; a.download = nom; a.click();
    }).catch(function () { alert('Export impossible.'); });
  }
  // Photo réduite dans le navigateur (1280 px max, JPEG) avant envoi
  function lirePhoto(input, apercu) {
    var file = input.files[0];
    apercu.innerHTML = '';
    if (!file) return Promise.resolve(null);
    return new Promise(function (ok) {
      var img = new Image();
      img.onload = function () {
        var k = Math.min(1, 1280 / Math.max(img.width, img.height)), cv = document.createElement('canvas');
        cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        var data = cv.toDataURL('image/jpeg', 0.75);
        apercu.innerHTML = '<img src="' + data + '" alt="">';
        URL.revokeObjectURL(img.src);
        ok(data);
      };
      img.onerror = function () { alert('Image illisible.'); ok(null); };
      img.src = URL.createObjectURL(file);
    });
  }

  // ---------- Données et couches ----------
  var LISTES = null, points = [], parId = {}, tournees = [], tourById = {}, signalements = [], programme = null;
  var couche = A.markClicks(L.featureGroup()), coucheTournees = A.markClicks(L.featureGroup());
  var surbrillance = L.featureGroup().addTo(map), compoLayer = L.featureGroup().addTo(map);
  var nonDesservis = L.layerGroup(), rendu = L.canvas({ padding: 0.3 });
  var recherches = [], compo = null, ficheCourante = null;

  function proprietesAffichees(p) {
    return { libelle: (p.nom || p.type) + ' (' + p.numero + ')', 'Type': p.type, 'État': p.etat, 'Volume estimé': m3(p.volume_m3),
      'Capacité': m3(p.capacite_m3), 'Quartier': p.quartier, 'Tournées': p.tournees.join(', '), 'Vérifié': p.verifie ? 'oui' : 'non (à vérifier)',
      'Dernier constat': dateFr(p.dernier_constat) };
  }
  function popupPoint(p) {
    var d = document.createElement('div');
    d.className = 'popup';
    d.innerHTML = '<h4>' + esc(p.nom || p.type) + ' <small>' + esc(p.numero) + '</small></h4><table>' +
      [['Type', p.type], ['État', p.etat], ['Volume', m3(p.volume_m3)], ['Quartier', p.quartier], ['Tournées', p.tournees.join(', ')],
        ['Dernier constat', dateFr(p.dernier_constat)]]
        .filter(function (r) { return r[1]; }).map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') +
      '</table>' + (p.verifie ? '' : '<p class="fon-pop-alerte">À vérifier par le service Hygiène et salubrité</p>');
    var bar = document.createElement('div'); bar.className = 'row';
    btn(bar, 'Ouvrir la fiche', 'primary', function () { map.closePopup(); ouvrirPoint(p.id); });
    btn(bar, '+ Constat', '', function () { map.closePopup(); formConstat(p); });
    d.appendChild(bar);
    return d;
  }
  function popupTournee(p) {
    var d = document.createElement('div');
    d.className = 'popup';
    d.innerHTML = '<h4>Tournée ' + esc(p.code) + '</h4><table>' +
      [['Secteur', p.nom], ['Passage', p.jours_texte], ['Départ', p.heure_depart], ['Moyen', p.moyen], ['Points', String(p.points.length)],
        ['Trajet', p.longueur_m ? A.fmtLen(p.longueur_m) : null], ['Durée', duree(p.duree_min)]]
        .filter(function (r) { return r[1]; }).map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>';
    var bar = document.createElement('div'); bar.className = 'row';
    btn(bar, 'Ouvrir la fiche', 'primary', function () { map.closePopup(); ouvrirTournee(p.id); });
    d.appendChild(bar);
    return d;
  }
  function dessiner() {
    couche.clearLayers(); coucheTournees.clearLayers(); parId = {}; tourById = {};
    recherches.forEach(function (it) { var i = A.searchIndex.indexOf(it); if (i >= 0) A.searchIndex.splice(i, 1); });
    recherches = [];
    points.forEach(function (f) {
      var p = f.properties, ll = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]);
      var l = L.marker(ll, { icon: S.icone(p, { aVerifier: !p.verifie }), keyboard: false });
      l.feature = { type: 'Feature', geometry: f.geometry, properties: proprietesAffichees(p) };
      // pendant la composition d'une tournée, un clic sur un point l'ajoute (ou le retire) au lieu d'ouvrir sa fiche
      if (compo) l.on('click', function () { basculerPoint(p.id); });
      else l.bindPopup(function () { return popupPoint(p); }, { maxWidth: 300 });
      couche.addLayer(l);
      parId[p.id] = { f: f, l: l };
      var it = { name: (p.nom ? p.nom + ' · ' : '') + p.numero, type: p.type + ' · ' + (p.quartier || ''), layer: l, parent: couche };
      A.searchIndex.push(it); recherches.push(it);
    });
    tournees.forEach(function (f) {
      tourById[f.id] = f;
      if (!f.geometry) return;
      var p = f.properties, l = L.geoJSON(f, { style: function () { return S.styleTournee(p); } }).getLayers()[0];
      l.feature = { type: 'Feature', geometry: f.geometry, properties: { libelle: 'Tournée ' + p.code, 'Secteur': p.nom, 'Passage': p.jours_texte,
        'Départ': p.heure_depart, 'Moyen': p.moyen, 'Points': p.points.length, 'Active': p.active ? 'oui' : 'non' } };
      l.bindPopup(function () { return popupTournee(p); }, { maxWidth: 300 });
      coucheTournees.addLayer(l);
      var it = { name: 'Tournée ' + p.code + ' · ' + p.nom, type: 'Collecte des déchets · ' + p.jours_texte, layer: L.featureGroup([l]), parent: coucheTournees };
      A.searchIndex.push(it); recherches.push(it);
    });
    if (compo) dessinerCompo();
  }

  function charger() {
    return Promise.all([api('GET', '/points'), api('GET', '/tournees'), gerer() ? api('GET', '/signalements') : Promise.resolve([]),
      api('GET', '/jour').catch(function () { return null; })])
      .then(function (r) {
        points = r[0].features; tournees = r[1].features; signalements = r[2]; if (r[3]) programme = r[3];
        dessiner(); rendre();
      }).catch(fail);
  }

  function surligner(geometry, zoom) {
    surbrillance.clearLayers();
    if (!geometry) return;
    if (geometry.type === 'Point') {
      var ll = L.latLng(geometry.coordinates[1], geometry.coordinates[0]);
      L.circleMarker(ll, { radius: 18, color: '#f2c230', weight: 4, fill: false, interactive: false }).addTo(surbrillance);
      if (zoom !== false) map.setView(ll, Math.max(map.getZoom(), 17));
      return;
    }
    var l = L.geoJSON(geometry, { style: { color: '#f2c230', weight: 9, opacity: 0.7, interactive: false } }).addTo(surbrillance);
    if (zoom !== false && l.getBounds().isValid()) map.fitBounds(l.getBounds(), { padding: [50, 50], maxZoom: 17 });
  }

  // ---------- Panneau : sous-onglets et fiche ----------
  var sousCourant = 'pts';
  function sousOnglet(k) {
    sousCourant = k;
    document.querySelectorAll('.dech-switch button').forEach(function (b) { b.classList.toggle('active', b.dataset.dech === k); });
    ['pts', 'tou', 'ter', 'bil'].forEach(function (x) { $('dech-' + x).classList.toggle('hidden', x !== k); });
    fermerFiche();
    if (k === 'ter') chargerJour();
    if (k === 'bil') chargerBilan();
  }
  document.querySelectorAll('.dech-switch button').forEach(function (b) { b.onclick = function () { sousOnglet(b.dataset.dech); }; });
  function montrerFiche(el) {
    $('dech-liste-vue').classList.add('hidden');
    $('dech-fiche-vue').classList.remove('hidden');
    var f = $('dech-fiche'); f.innerHTML = ''; f.appendChild(el);
    $('tab-dech').scrollTop = 0;
  }
  function fermerFiche() {
    if (compo) finCompo();
    ficheCourante = null;
    $('dech-fiche-vue').classList.add('hidden');
    $('dech-liste-vue').classList.remove('hidden');
    surbrillance.clearLayers();
  }
  $('dech-retour').onclick = fermerFiche;

  // ---------- Points : liste ----------
  var F = { q: '', type: '', etat: '', quartier: '', verifier: false };
  function enService(p) { return p.etat === 'Actif' || p.etat === 'Saturé'; }
  function rendre() {
    var actifs = points.filter(function (f) { return enService(f.properties); });
    var sauvages = actifs.filter(function (f) { return f.properties.type === 'Dépôt sauvage'; });
    var vol = sauvages.reduce(function (s, f) { return s + (f.properties.volume_m3 || 0); }, 0);
    var satures = actifs.filter(function (f) { return f.properties.etat === 'Saturé'; }).length;
    var aVerifier = points.filter(function (f) { return !f.properties.verifie; }).length;
    $('dech-cartes').innerHTML = carte(A.fmt(actifs.length), 'points en service', '', 'etat:') +
      carte(A.fmt(sauvages.length), 'dépôts sauvages ouverts' + (vol ? ' (' + A.fmt(vol, 0) + ' m³)' : ''), sauvages.length ? 'alerte' : '', 'type:Dépôt sauvage') +
      carte(satures, 'saturés', satures ? 'alerte' : '', 'etat:Saturé') +
      carte(aVerifier, 'à vérifier', aVerifier && gerer() ? 'alerte' : '', 'verifier') +
      carte(tournees.filter(function (t) { return t.properties.active; }).length, 'tournées actives', '', 'tournees');
    $('dech-cartes').querySelectorAll('[data-a]').forEach(function (c) {
      c.onclick = function () {
        var a = c.dataset.a;
        if (a === 'tournees') return sousOnglet('tou');
        F.type = a.indexOf('type:') === 0 ? a.slice(5) : '';
        F.etat = a.indexOf('etat:') === 0 ? a.slice(5) : '';
        F.verifier = a === 'verifier';
        if (F.verifier) F.etat = 'tous';
        $('dech-f-type').value = F.type; $('dech-f-etat').value = F.etat; $('dech-f-verifier').checked = F.verifier;
        rendreListe();
        $('dech-liste').scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });
    var nb = gerer() ? aVerifier + signalements.length : 0;
    $('dech-badge').textContent = nb; $('dech-badge').classList.toggle('hidden', !nb);
    var quartiers = {};
    points.forEach(function (f) { if (f.properties.quartier) quartiers[f.properties.quartier] = 1; });
    remplir($('dech-f-quartier'), Object.keys(quartiers).sort(), 'Tous les quartiers');
    rendreSignalements(); rendreListe(); rendreTournees(); rendreBadgeTerrain();
    if (sousCourant === 'ter' && !ficheCourante) rendreJour();
  }
  function rendreListe() {
    var q = F.q.trim().toLowerCase();
    var list = points.filter(function (f) {
      var p = f.properties;
      if (F.etat === '' ? !enService(p) : F.etat !== 'tous' && p.etat !== F.etat) return false;
      if (F.type && p.type !== F.type) return false;
      if (F.quartier && p.quartier !== F.quartier) return false;
      if (F.verifier && p.verifie) return false;
      return !q || [p.numero, p.nom, p.description, p.quartier].some(function (v) { return v && String(v).toLowerCase().indexOf(q) >= 0; });
    });
    $('dech-compte').textContent = list.length + ' point(s)' + (list.length > 300 ? ' — 300 premiers affichés' : '');
    var ul = $('dech-liste');
    ul.innerHTML = list.length ? '' : '<li class="empty"><small>Aucun point pour ces critères.' +
      (points.length ? '' : ' Commencez par « Placer un point » : dépôt sauvage, bac, dépotoir…') + '</small></li>';
    list.slice(0, 300).forEach(function (f) {
      var p = f.properties, li = document.createElement('li');
      li.className = 'fon-li' + (p.etat === 'Saturé' ? ' retard' : '');
      li.style.borderLeftColor = S.ferme(p) ? S.GRIS : S.classe(p.type).couleur;
      li.innerHTML = '<b>' + esc(p.numero) + '</b> · ' + esc(p.nom || p.type) + '<small>' + esc(p.type) + ' · ' + esc(p.quartier || '—') +
        ' · <span class="badge ' + cls(p.etat) + '">' + esc(p.etat) + '</span>' + (p.volume_m3 ? ' · ' + m3(p.volume_m3) : '') +
        (p.tournees.length ? ' · 🚛 ' + esc(p.tournees.join(', ')) : '') +
        (p.verifie ? '' : ' · <b class="retard-txt">à vérifier</b>') + '</small>';
      li.onclick = function () { ouvrirPoint(p.id); };
      ul.appendChild(li);
    });
  }
  $('dech-recherche').oninput = function () { F.q = this.value; rendreListe(); };
  $('dech-f-type').onchange = function () { F.type = this.value; rendreListe(); };
  $('dech-f-etat').onchange = function () { F.etat = this.value; rendreListe(); };
  $('dech-f-quartier').onchange = function () { F.quartier = this.value; rendreListe(); };
  $('dech-f-verifier').onchange = function () { F.verifier = this.checked; rendreListe(); };
  $('dech-export').onclick = function () { telecharger('/export/points.csv', 'points_collecte_dechets_labe.csv'); };
  $('dech-t-export').onclick = function () { telecharger('/export/tournees.csv', 'tournees_collecte_labe.csv'); };

  // ---------- Signalements « Dépôt d'ordures » à prendre en charge ----------
  function rendreSignalements() {
    var div = $('dech-signalements');
    if (!gerer() || !signalements.length) { div.innerHTML = ''; return; }
    div.innerHTML = '<details class="adr-detail" open><summary>Signalements « Dépôt d\'ordures » à prendre en charge : <b>' + signalements.length +
      '</b></summary><ul class="fon-ctl" id="dech-sig-liste"></ul></details>';
    var ul = $('dech-sig-liste');
    signalements.forEach(function (s) {
      var li = document.createElement('li');
      li.innerHTML = '<b>' + esc(s.nom || 'Dépôt d\'ordures') + '</b> <small>n° ' + s.id + ' · ' + esc(s.quartier || '—') + ' · ' + dateFr(s.cree_le) +
        ' · ' + esc(s.auteur || '') + (s.description ? '<br>' + esc(s.description) : '') +
        (s.point_proche ? '<br>Point déjà recensé à moins de 30 m : <b>' + esc(s.point_proche) + '</b>' : '') + '</small>';
      var bar = document.createElement('div'); bar.className = 'row';
      btn(bar, 'Voir', '', function () { surligner(s.geometry); });
      btn(bar, 'Créer le dépôt sauvage', 'primary', function () {
        var v = prompt('Volume estimé des déchets (m³), si connu :', '');
        if (v === null) return;
        api('POST', '/signalements/' + s.id + '/convertir', { volume_m3: v.trim() ? parseFloat(v.replace(',', '.')) : null })
          .then(function (f) { LabeTerrain.toast('Dépôt ' + f.properties.numero + ' créé ; le signalement est pris en charge.'); charger().then(function () { ouvrirPoint(f.id); }); })
          .catch(fail);
      });
      if (s.point_proche) btn(bar, 'Rattacher à ' + s.point_proche, '', function () {
        api('POST', '/signalements/' + s.id + '/convertir', { rattacher: s.point_proche }).then(function (f) { charger().then(function () { ouvrirPoint(f.id); }); }).catch(fail);
      });
      li.appendChild(bar);
      ul.appendChild(li);
    });
  }

  // ---------- Fiche d'un point ----------
  function ouvrirPoint(id) {
    api('GET', '/points/' + id).then(function (f) {
      var p = f.properties, d = document.createElement('div');
      ficheCourante = { point: id };
      d.innerHTML = '<h3>' + esc(p.numero) + ' — ' + esc(p.nom || p.type) + '</h3><p><span class="badge ' + cls(p.etat) + '">' + esc(p.etat) + '</span> ' +
        (p.verifie ? '<span class="badge d-verifie">Vérifié · carte publique</span>' : '<span class="badge d-a-verifier">À vérifier</span>') + '</p>' +
        table([['Type', p.type], ['Nom ou repère', p.nom], ['Volume estimé', m3(p.volume_m3)], ['Capacité', m3(p.capacite_m3)], ['Accès', p.acces],
          ['Quartier', p.quartier], ['Tournées', p.tournees.join(', ')], ['Description', p.description],
          ['Recensé le', dateFr(p.cree_le) + (p.cree_par_nom ? ' par ' + p.cree_par_nom : '')],
          ['Vérifié le', p.verifie_le ? dateFr(p.verifie_le) + (p.verifie_par_nom ? ' par ' + p.verifie_par_nom : '') : null],
          ['Dernier constat', dateFr(p.dernier_constat)], [p.type === 'Dépôt sauvage' ? 'Résorbé le' : 'Fermé le', dateFr(p.resorbe_le)],
          ['Signalement d\'origine', p.contribution ? 'n° ' + p.contribution : null],
          ['Position', f.geometry.coordinates[1].toFixed(6) + ', ' + f.geometry.coordinates[0].toFixed(6)]]) +
        (p.photo_url ? '<div class="dech-photo" id="dech-fp-photo">Chargement de la photo…</div>' : '');
      var bar = document.createElement('div'); bar.className = 'row';
      btn(bar, '+ Constat', 'primary', function () { formConstat(p); });
      if (f.peut_modifier) {
        btn(bar, 'Modifier', '', function () { formPoint(f); });
        btn(bar, '⇄ Déplacer', '', function () { deplacer(p); });
      }
      if (gerer() && !p.verifie) btn(bar, '✓ Vérifier (publier)', 'primary', function () {
        api('POST', '/points/' + p.id + '/verifier').then(function () { charger(); ouvrirPoint(p.id); }).catch(fail);
      });
      if (A.itineraire) btn(bar, 'Itinéraire jusqu\'ici', '', function () {
        A.itineraire.ajouter(L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]), p.numero + ' ' + (p.nom || p.type), 'end');
      });
      if (f.peut_modifier) btn(bar, 'Supprimer', 'danger', function () {
        if (!confirm('Supprimer le point ' + p.numero + ' ?' + (p.tournees.length ? ' Il sera retiré des tournées ' + p.tournees.join(', ') + '.' : ''))) return;
        api('DELETE', '/points/' + p.id).then(function () { fermerFiche(); charger(); }).catch(fail);
      });
      d.appendChild(bar);

      var h = document.createElement('div');
      h.innerHTML = '<h4>Historique</h4><ul class="histo fon-histo">' + f.constats.map(function (c) {
        return '<li><b>' + dateFr(c.date) + ' ' + heureFr(c.date) + '</b> — ' + esc(c.action) +
          (c.etat_avant && c.etat_apres && c.etat_avant !== c.etat_apres ? ' : ' + esc(c.etat_avant) + ' → ' + esc(c.etat_apres) : '') +
          (c.volume_m3 != null ? ' · ' + m3(c.volume_m3) : '') + (c.utilisateur ? ' <small>(' + esc(c.utilisateur) + ')</small>' : '') +
          (c.commentaire ? '<br><small>' + esc(c.commentaire) + '</small>' : '') +
          (c.photo_url ? ' <a href="#" data-photo="' + esc(c.photo_url) + '">📷 photo</a>' : '') + '</li>';
      }).join('') + '</ul>' +
        (f.collectes.length ? '<h4>Collectes</h4><ul class="histo fon-histo">' + f.collectes.map(function (c) {
          return '<li><b>' + dateFr(c.heure) + ' ' + heureFr(c.heure) + '</b> — tournée ' + esc(c.code) + ' : ' + esc(c.statut) +
            (c.motif ? ' <small>(' + esc(c.motif) + ')</small>' : '') + '</li>';
        }).join('') + '</ul>' : '');
      d.appendChild(h);
      d.querySelectorAll('[data-photo]').forEach(function (a) {
        a.onclick = function (e) { e.preventDefault(); Auth.blobUrl(a.dataset.photo).then(function (u) { window.open(u, '_blank'); }); };
      });
      montrerFiche(d);
      if (p.photo_url) Auth.blobUrl(p.photo_url).then(function (u) {
        $('dech-fp-photo').innerHTML = '<a href="' + u + '" target="_blank"><img src="' + u + '" alt="Photo du point"></a>';
      }).catch(function () { $('dech-fp-photo').textContent = ''; });
      surligner(f.geometry);
    }).catch(fail);
  }

  // ---------- Formulaire d'un point ----------
  var pf = { form: $('dech-point-form'), modal: $('dech-point-modal'), feature: null, latlng: null, photo: null };
  function formPoint(feature, latlng) {
    var el = pf.form.elements, p = feature ? feature.properties : {};
    pf.feature = feature; pf.latlng = latlng; pf.photo = null;
    pf.form.reset();
    remplir(el.type, LISTES.types); remplir(el.etat, LISTES.etats); remplir(el.acces, LISTES.acces);
    el.type.value = p.type || 'Dépôt sauvage'; el.etat.value = p.etat || 'Actif'; el.acces.value = p.acces || 'Camion';
    el.etat.disabled = !!feature;  // l'état d'un point existant change par un constat (historique)
    ['nom', 'volume_m3', 'capacite_m3', 'description'].forEach(function (k) { el[k].value = p[k] != null ? p[k] : ''; });
    $('dech-pf-titre').textContent = feature ? 'Modifier le point ' + p.numero : 'Nouveau point de collecte ou dépotoir';
    $('dech-pf-motif').classList.toggle('hidden', !feature);
    $('dech-pf-forcer').classList.add('hidden');
    $('dech-pf-msg').textContent = feature ? 'L\'état se change par « + Constat » (il est gardé dans l\'historique).' : '';
    $('dech-pf-photo').innerHTML = '';
    pf.modal.classList.remove('hidden');
    if (latlng) surligner({ type: 'Point', coordinates: [latlng.lng, latlng.lat] }, false);
  }
  pf.form.elements.photo.onchange = function () { lirePhoto(this, $('dech-pf-photo')).then(function (d) { pf.photo = d; }); };
  $('dech-pf-annuler').onclick = function () { pf.modal.classList.add('hidden'); if (!pf.feature) surbrillance.clearLayers(); };
  function nombre(v) { return v === '' || v == null ? null : parseFloat(String(v).replace(',', '.')); }
  pf.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var el = pf.form.elements, body = { type: el.type.value, nom: el.nom.value.trim() || null, acces: el.acces.value,
      volume_m3: nombre(el.volume_m3.value), capacite_m3: nombre(el.capacite_m3.value), description: el.description.value.trim() || null };
    if (pf.photo) body.photo = pf.photo;
    if (el.forcer.checked) body.forcer = true;
    var bouton = pf.form.querySelector('[type=submit]'); bouton.disabled = true;
    var req;
    if (pf.feature) {
      body.commentaire = el.commentaire.value.trim() || null;
      req = api('PUT', '/points/' + pf.feature.id, body);
    } else {
      body.etat = el.etat.value;
      body.geometry = { type: 'Point', coordinates: [+pf.latlng.lng.toFixed(7), +pf.latlng.lat.toFixed(7)] };
      body.uid = pf.uid || (pf.uid = LabeTerrain.uuid());
      req = envoyer('POST', '/points', body);
    }
    req.then(function (f) {
      pf.modal.classList.add('hidden'); pf.uid = null;
      if (f && f.enAttente) { surbrillance.clearLayers(); LabeTerrain.toast('Pas de réseau : le point est gardé dans le téléphone et sera envoyé automatiquement.'); return; }
      charger().then(function () { ouvrirPoint(f.id); });
    }).catch(function (err) {
      $('dech-pf-msg').textContent = err.message;
      if (err.status === 409 && err.detail && err.detail.proche) $('dech-pf-forcer').classList.remove('hidden');
    }).then(function () { bouton.disabled = false; });
  });
  $('dech-ajouter').onclick = function () {
    A.startSketch('point', { btn: this, label: 'Nouveau point de collecte', onFinish: function (pts) { pf.uid = null; formPoint(null, pts[0]); } });
  };
  $('dech-ajouter-gps').onclick = function () { LabeTerrain.pointGps(function (ll) { pf.uid = null; formPoint(null, ll); }); };
  function deplacer(p) {
    A.startSketch('point', { label: 'Nouvel emplacement de ' + p.numero, onFinish: function (pts) {
      var g = { type: 'Point', coordinates: [+pts[0].lng.toFixed(7), +pts[0].lat.toFixed(7)] };
      function go(forcer) {
        api('PUT', '/points/' + p.id, { geometry: g, forcer: forcer, commentaire: 'nouvel emplacement' }).then(function () { charger(); ouvrirPoint(p.id); })
          .catch(function (e) { if (e.status === 409 && !forcer && confirm(e.message + '\n\nDéplacer quand même ?')) go(true); else if (e.status !== 409) fail(e); });
      }
      go(false);
    } });
  }

  // ---------- Constat ----------
  var cf = { form: $('dech-constat-form'), modal: $('dech-constat-modal'), point: null, photo: null };
  function formConstat(p) {
    var el = cf.form.elements;
    cf.point = p; cf.photo = null; cf.form.reset();
    remplir(el.etat, LISTES.etats); el.etat.value = p.etat;
    el.volume_m3.value = p.volume_m3 != null ? p.volume_m3 : '';
    $('dech-cf-titre').textContent = 'Constat — ' + p.numero + ' ' + (p.nom || p.type);
    $('dech-cf-msg').textContent = p.type === 'Dépôt sauvage' ? 'Dépôt nettoyé : choisissez « Résorbé ».' : '';
    $('dech-cf-photo').innerHTML = '';
    cf.modal.classList.remove('hidden');
  }
  cf.form.elements.etat.onchange = function () {  // dépôt nettoyé ou point fermé : plus de déchets sur place
    if (this.value === 'Résorbé' || this.value === 'Fermé') cf.form.elements.volume_m3.value = '0';
  };
  cf.form.elements.photo.onchange = function () { lirePhoto(this, $('dech-cf-photo')).then(function (d) { cf.photo = d; }); };
  $('dech-cf-annuler').onclick = function () { cf.modal.classList.add('hidden'); };
  cf.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var el = cf.form.elements, body = { etat: el.etat.value, volume_m3: nombre(el.volume_m3.value), commentaire: el.commentaire.value.trim() || null };
    if (body.etat === 'Résorbé' || body.etat === 'Fermé') body.volume_m3 = 0;  // plus de déchets sur place
    if (cf.photo) body.photo = cf.photo;
    var bouton = cf.form.querySelector('[type=submit]'); bouton.disabled = true;
    envoyer('POST', '/points/' + cf.point.id + '/constat', body).then(function (r) {
      cf.modal.classList.add('hidden');
      if (r && r.enAttente) return LabeTerrain.toast('Pas de réseau : le constat sera envoyé automatiquement.');
      charger().then(function () { if (ficheCourante && ficheCourante.point === cf.point.id) ouvrirPoint(cf.point.id); });
    }).catch(function (err) { $('dech-cf-msg').textContent = err.message; }).then(function () { bouton.disabled = false; });
  });

  // ---------- Tournées : liste ----------
  function rendreTournees() {
    $('dech-t-nouvelle').classList.toggle('hidden', !gerer());
    var ul = $('dech-tournees');
    ul.innerHTML = tournees.length ? '' : '<li class="empty"><small>Aucune tournée.' + (gerer() ? ' Créez-en une avec « + Nouvelle tournée ».' : '') + '</small></li>';
    tournees.forEach(function (t) {
      var p = t.properties, li = document.createElement('li');
      li.className = 'fon-dossier' + (p.active ? '' : ' d-inactive');
      li.innerHTML = '<b>' + esc(p.code) + ' — ' + esc(p.nom) + '</b><small>' + esc(p.jours_texte) + (p.heure_depart ? ' · ' + esc(p.heure_depart) : '') +
        ' · ' + esc(p.moyen) + ' · ' + p.points.length + ' point(s)' + (p.longueur_m ? ' · ' + A.fmtLen(p.longueur_m) : ' · <b class="retard-txt">trajet à définir</b>') +
        (p.duree_min ? ' · ' + duree(p.duree_min) : '') + (p.quartiers.length ? '<br>' + esc(p.quartiers.join(', ')) : '') +
        (p.dernier_passage ? ' · dernier passage ' + dateFr(p.dernier_passage) : '') + (p.active ? '' : ' · <span class="badge d-Fermé">inactive</span>') + '</small>';
      li.onclick = function () { ouvrirTournee(t.id); };
      ul.appendChild(li);
    });
  }

  // ---------- Fiche d'une tournée ----------
  function dessinerTournee(f, ordre) {
    surbrillance.clearLayers();
    if (f.geometry) {
      L.geoJSON(f.geometry, { style: { color: '#fff', weight: 9, opacity: 0.9, interactive: false } }).addTo(surbrillance);
      L.geoJSON(f.geometry, { style: { color: S.TOURNEE, weight: 5, opacity: 0.95, interactive: false } }).addTo(surbrillance);
    }
    (ordre || []).forEach(function (pt, i) {
      var ll = L.latLng(pt.geometry.coordinates[1], pt.geometry.coordinates[0]);
      L.marker(ll, { icon: S.icone(pt, { ordre: i + 1, choisi: true }), interactive: false, zIndexOffset: 1000 }).addTo(surbrillance);
    });
    var b = surbrillance.getBounds();
    if (b.isValid()) map.fitBounds(b, { padding: [50, 50], maxZoom: 17 });
  }
  function ouvrirTournee(id) {
    if (compo) finCompo();
    api('GET', '/tournees/' + id).then(function (f) {
      var p = f.properties, d = document.createElement('div');
      ficheCourante = { tournee: id };
      d.innerHTML = '<h3>' + esc(p.code) + ' — ' + esc(p.nom) + '</h3><p>' + (p.active ? '<span class="badge d-Actif">Active</span>' : '<span class="badge d-Fermé">Inactive</span>') + '</p>' +
        table([['Jours de passage', p.jours_texte], ['Départ', p.heure_depart], ['Moyen', p.moyen], ['Véhicule', p.vehicule], ['Équipe', p.equipe],
          ['Prestataire', p.prestataire], ['Points de collecte', String(p.points.length)],
          ['Trajet', p.longueur_m ? A.fmtLen(p.longueur_m) + (p.trace_manuel ? ' (tracé à la main)' : ' (calculé sur les rues)') : 'à définir'],
          ['Durée estimée', p.duree_min ? duree(p.duree_min) + ' (trajet + ' + A.fmt(LISTES.parametres.filter(function (x) { return x.cle === 'arret_min'; })[0].valeur) + ' min par arrêt)' : null],
          ['Quartiers traversés', p.quartiers.join(', ')],
          ['Bâtiments desservis', f.geometry ? A.fmt(f.batiments_desservis) + ' à moins de ' + f.rayon_m + ' m du trajet' : null],
          ['Dernier passage', dateFr(p.dernier_passage)], ['Observations', p.observations]]);
      var bar = document.createElement('div'); bar.className = 'row';
      if (p.active && p.points.length) btn(bar, '▶ Démarrer un passage', 'primary', function () { demarrer(f); });
      if (gerer()) {
        btn(bar, 'Modifier les informations', '', function () { formTournee(f); });
        btn(bar, '✎ Points et trajet', '', function () { composer(f); });
      }
      if (f.geometry) btn(bar, 'GPX', '', function () { gpx(f); });
      if (gerer()) {
        btn(bar, p.active ? 'Désactiver' : 'Réactiver', '', function () {
          api('PUT', '/tournees/' + p.id, { active: !p.active }).then(function () { charger(); ouvrirTournee(p.id); }).catch(fail);
        });
        if (!f.passages.length) btn(bar, 'Supprimer', 'danger', function () {
          if (confirm('Supprimer la tournée ' + p.code + ' ?')) api('DELETE', '/tournees/' + p.id).then(function () { fermerFiche(); charger(); }).catch(fail);
        });
      }
      d.appendChild(bar);
      var ol = document.createElement('div');
      ol.innerHTML = '<h4>Ordre de passage</h4>' + (f.points_detail.length ? '<ol class="dech-ordre">' + f.points_detail.map(function (x) {
        return '<li data-p="' + x.id + '"><b>' + esc(x.numero) + '</b> ' + esc(x.nom || x.type) + ' <small>' + esc(x.quartier || '') +
          (x.etat !== 'Actif' ? ' · <span class="badge ' + cls(x.etat) + '">' + esc(x.etat) + '</span>' : '') + '</small></li>';
      }).join('') + '</ol>' : '<p class="hint">Aucun point : utilisez « ✎ Points et trajet ».</p>') +
        '<h4>Passages</h4>' + (f.passages.length ? '<ul class="fon-ctl">' + f.passages.map(function (x) {
          return '<li data-u="' + esc(x.uid) + '"><b>' + dateFr(x.date) + '</b> · ' + esc(x.statut) + ' · ' + x.collectes + '/' + x.prevus + ' collecté(s)' +
            (x.problemes ? ' · ' + x.problemes + ' problème(s)' : '') + ' <small>' + esc(x.agent || '') + (x.debut ? ' · ' + heureFr(x.debut) + (x.fin ? '–' + heureFr(x.fin) : '') : '') + '</small></li>';
        }).join('') + '</ul>' : '<p class="hint">Aucun passage enregistré.</p>');
      d.appendChild(ol);
      d.querySelectorAll('[data-p]').forEach(function (li) {
        li.onclick = function () { var x = parId[+li.dataset.p]; if (x) { map.setView(x.l.getLatLng(), Math.max(map.getZoom(), 17)); x.l.openPopup(); } };
      });
      d.querySelectorAll('[data-u]').forEach(function (li) { li.onclick = function () { ouvrirPassage(li.dataset.u); }; });
      montrerFiche(d);
      dessinerTournee(f, f.points_detail);
    }).catch(fail);
  }
  function gpx(f) {
    var p = f.properties, out = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="WebSIG Labé" xmlns="http://www.topografix.com/GPX/1/1">\n';
    p.points.forEach(function (id, i) {
      var x = parId[id]; if (!x) return;
      var c = x.f.geometry.coordinates;
      out += '<wpt lat="' + c[1].toFixed(6) + '" lon="' + c[0].toFixed(6) + '"><name>' + (i + 1) + ' ' + esc(x.f.properties.numero) + '</name><desc>' +
        esc(x.f.properties.nom || x.f.properties.type) + '</desc></wpt>\n';
    });
    out += '<trk><name>' + esc('Tournée ' + p.code + ' ' + p.nom) + '</name><trkseg>' + f.geometry.coordinates.map(function (c) {
      return '<trkpt lat="' + c[1].toFixed(6) + '" lon="' + c[0].toFixed(6) + '"/>';
    }).join('') + '</trkseg></trk>\n</gpx>\n';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out], { type: 'application/gpx+xml' }));
    a.download = 'tournee_' + p.code + '.gpx';
    a.click();
  }

  // ---------- Formulaire d'une tournée ----------
  var tf = { form: $('dech-tournee-form'), modal: $('dech-tournee-modal'), feature: null };
  $('dech-tf-jours').innerHTML = JOURS_COURTS.map(function (j, i) {
    return '<label class="check"><input type="checkbox" name="jour" value="' + (i + 1) + '"> ' + j + '</label>';
  }).join('');
  function formTournee(feature) {
    var el = tf.form.elements, p = feature ? feature.properties : {};
    tf.feature = feature; tf.form.reset();
    remplir(el.moyen, LISTES.moyens);
    ['nom', 'heure_depart', 'vehicule', 'equipe', 'prestataire', 'observations'].forEach(function (k) { el[k].value = p[k] || ''; });
    el.moyen.value = p.moyen || 'Camion';
    el.active.checked = feature ? p.active : true;
    tf.form.querySelectorAll('[name=jour]').forEach(function (c) { c.checked = (p.jours || [1, 3, 5]).indexOf(+c.value) >= 0; });
    $('dech-tf-titre').textContent = feature ? 'Modifier la tournée ' + p.code : 'Nouvelle tournée de collecte';
    $('dech-tf-msg').textContent = feature ? '' : 'Ensuite, vous choisirez les points de collecte sur la carte.';
    tf.modal.classList.remove('hidden');
  }
  $('dech-t-nouvelle').onclick = function () { formTournee(null); };
  $('dech-tf-annuler').onclick = function () { tf.modal.classList.add('hidden'); };
  tf.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var el = tf.form.elements, body = { nom: el.nom.value.trim(), heure_depart: el.heure_depart.value || '', moyen: el.moyen.value,
      vehicule: el.vehicule.value.trim() || null, equipe: el.equipe.value.trim() || null, prestataire: el.prestataire.value.trim() || null,
      observations: el.observations.value.trim() || null, active: el.active.checked,
      jours: Array.prototype.filter.call(tf.form.querySelectorAll('[name=jour]'), function (c) { return c.checked; }).map(function (c) { return +c.value; }) };
    var bouton = tf.form.querySelector('[type=submit]'); bouton.disabled = true;
    (tf.feature ? api('PUT', '/tournees/' + tf.feature.id, body) : api('POST', '/tournees', body)).then(function (f) {
      tf.modal.classList.add('hidden');
      var nouvelle = !tf.feature;
      charger().then(function () {
        sousOnglet('tou');
        if (nouvelle) composer(f); else ouvrirTournee(f.id);
      });
    }).catch(function (err) { $('dech-tf-msg').textContent = err.message; }).then(function () { bouton.disabled = false; });
  });

  // ---------- Composition : points dans l'ordre de passage, puis trajet ----------
  function composer(f) {
    compo = { f: f, ids: f.properties.points.filter(function (id) { return parId[id]; }), geom: f.geometry, manuel: f.properties.trace_manuel,
      aJour: true, longueur: f.properties.longueur_m, msg: '' };
    ficheCourante = { tournee: f.id, compo: true };
    map.closePopup();
    dessiner();
    if (!map.hasLayer(couche)) couche.addTo(map);
    surbrillance.clearLayers();
    var d = document.createElement('div');
    d.id = 'dech-compo';
    montrerFiche(d);
    rendreCompo();
    dessinerCompo();
    var b = compo.ids.length ? L.latLngBounds(compo.ids.map(function (id) { return parId[id].l.getLatLng(); })) : couche.getBounds();
    if (b.isValid()) map.fitBounds(b, { padding: [60, 60], maxZoom: 17 });
  }
  function finCompo() {
    compo = null; compoLayer.clearLayers();
    dessiner();
  }
  function basculerPoint(id) {
    var i = compo.ids.indexOf(id);
    if (i >= 0) compo.ids.splice(i, 1); else compo.ids.push(id);
    compo.aJour = false; compo.msg = '';
    rendreCompo(); dessinerCompo();
  }
  function dessinerCompo() {
    compoLayer.clearLayers();
    couche.eachLayer(function (l) { l.setOpacity(0.55); });
    if (compo.geom) {
      L.geoJSON(compo.geom, { style: { color: '#fff', weight: 8, opacity: 0.9, interactive: false } }).addTo(compoLayer);
      L.geoJSON(compo.geom, { style: { color: S.TOURNEE, weight: 4, opacity: compo.aJour ? 0.95 : 0.4, dashArray: compo.aJour ? null : '6 6', interactive: false } }).addTo(compoLayer);
    }
    compo.ids.forEach(function (id, i) {
      var x = parId[id];
      L.marker(x.l.getLatLng(), { icon: S.icone(x.f.properties, { ordre: i + 1, choisi: true }), zIndexOffset: 1000 })
        .on('click', function () { basculerPoint(id); }).addTo(compoLayer);
    });
  }
  function rendreCompo() {
    var d = $('dech-compo'); if (!d) return;
    var p = compo.f.properties;
    d.innerHTML = '<h3>' + esc(p.code) + ' — points et trajet</h3>' +
      '<p class="hint">Cliquez sur les points de collecte de la carte dans l\'ordre de passage ; un nouveau clic retire le point. ' +
      'Le premier point est le départ (ex. le dépôt des véhicules ou un centre de transfert).</p>' +
      '<ol class="dech-ordre" id="dech-c-liste"></ol>' +
      '<label class="check"><input type="checkbox" id="dech-c-optim"' + (compo.ids.length > 2 ? ' checked' : '') + '> Optimiser l\'ordre de passage (le départ ne change pas)</label>' +
      '<label class="check"><input type="checkbox" id="dech-c-boucle"> Revenir au point de départ</label>' +
      '<p class="hint" id="dech-c-res">' + (compo.msg || (compo.geom ? 'Trajet : ' + A.fmtLen(compo.longueur || 0) + (compo.manuel ? ' (tracé à la main)' : '') +
        (compo.aJour ? '' : ' — <b class="retard-txt">à recalculer</b> (les points ont changé)') : 'Pas encore de trajet.')) + '</p>';
    var ol = $('dech-c-liste');
    if (!compo.ids.length) ol.outerHTML = '<p class="hint"><b>Aucun point choisi.</b></p>';
    compo.ids.forEach(function (id, i) {
      var x = parId[id].f.properties, li = document.createElement('li');
      li.innerHTML = '<b>' + esc(x.numero) + '</b> ' + esc(x.nom || x.type) + ' ';
      var up = btn(li, '↑', 'mini', function () { compo.ids.splice(i - 1, 0, compo.ids.splice(i, 1)[0]); compo.aJour = false; rendreCompo(); dessinerCompo(); });
      up.disabled = i === 0; up.title = 'Monter';
      btn(li, '✕', 'mini', function () { basculerPoint(id); }).title = 'Retirer';
      ol.appendChild(li);
    });
    var bar = document.createElement('div'); bar.className = 'row';
    btn(bar, 'Calculer le trajet sur les rues', 'primary', calculerTrajet).disabled = compo.ids.length < 2;
    btn(bar, 'Tracer à la main', '', function () {
      A.startSketch('line', { label: 'Trajet de la tournée ' + p.code, onFinish: function (pts) {
        compo.geom = { type: 'LineString', coordinates: pts.map(function (q) { return [+q.lng.toFixed(7), +q.lat.toFixed(7)]; }) };
        compo.manuel = true; compo.aJour = true; compo.longueur = A.lineLength(pts); compo.msg = '';
        rendreCompo(); dessinerCompo();
      } });
    });
    d.appendChild(bar);
    var bar2 = document.createElement('div'); bar2.className = 'row';
    btn(bar2, 'Enregistrer', 'primary', enregistrerCompo);
    btn(bar2, 'Annuler', '', function () { var id = compo.f.id; finCompo(); ouvrirTournee(id); });
    d.appendChild(bar2);
  }
  function calculerTrajet() {
    if (compo.ids.length < 2) return alert('Choisissez au moins deux points pour calculer un trajet.');
    var moyen = compo.f.properties.moyen, mode = moyen === 'Charrette / à pied' ? 'pied' : 'vehicule';
    $('dech-c-res').textContent = 'Calcul du trajet…';
    var lls = compo.ids.map(function (id) { return parId[id].l.getLatLng(); });
    A.reseau.trajet(lls, mode, { optimiser: $('dech-c-optim').checked, boucle: $('dech-c-boucle').checked }).then(function (r) {
      if (r.erreur) {
        compo.msg = '⚠ Le point ' + parId[compo.ids[r.index]].f.properties.numero + ' est ' + r.erreur + '.';
        return rendreCompo();
      }
      compo.ids = r.ordre.map(function (i) { return compo.ids[i]; });
      compo.geom = { type: 'LineString', coordinates: r.coords };
      compo.manuel = false; compo.aJour = true; compo.longueur = r.longueur;
      compo.msg = 'Trajet calculé sur les rues : ' + A.fmtLen(r.longueur) + (mode === 'pied' ? ' à pied' : ' en véhicule') +
        '. La durée (trajet + arrêts) est estimée à l\'enregistrement.';
      rendreCompo(); dessinerCompo();
    }).catch(function (e) { compo.msg = 'Calcul impossible : ' + e.message; rendreCompo(); });
  }
  function enregistrerCompo() {
    if (!compo.ids.length) return alert('Choisissez au moins un point de collecte.');
    if (!compo.aJour && !confirm('Les points ont changé depuis le calcul du trajet. Enregistrer quand même (trajet non mis à jour) ?')) return;
    var id = compo.f.id, g = compo.geom && compo.geom.coordinates.length > 1 ? compo.geom : null;
    api('PUT', '/tournees/' + id, { points: compo.ids, geometry: g, trace_manuel: !!compo.manuel }).then(function () {
      finCompo();
      charger().then(function () { ouvrirTournee(id); });
    }).catch(fail);
  }

  // ---------- File d'attente (terrain sans réseau) ----------
  var FILE = 'labe-dech-file', REFUS = 'labe-dech-refus', PASSAGES = 'labe-dech-passages';
  function lireLS(k, def) { try { return JSON.parse(localStorage.getItem(k)) || def; } catch (e) { return def; } }
  function ecrireLS(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  function envoyer(methode, chemin, corps) {
    function attente() {
      var l = lireLS(FILE, []); l.push({ id: LabeTerrain.uuid(), m: methode, p: chemin, b: corps, t: Date.now() }); ecrireLS(FILE, l); majFile();
      return { enAttente: true };
    }
    if (!navigator.onLine || lireLS(FILE, []).length) {  // on garde l'ordre des envois : rien ne double la file
      var r = attente(); viderFile(); return Promise.resolve(r);
    }
    return api(methode, chemin, corps).catch(function (e) { if (!e.status || e.status === 503) return attente(); throw e; });
  }
  var vidage = false;
  function viderFile() {
    if (vidage || !navigator.onLine || !lireLS(FILE, []).length) return Promise.resolve();
    vidage = true;
    var envoyes = 0;
    function suivant() {
      var l = lireLS(FILE, []);
      if (!l.length) return Promise.resolve();
      var it = l[0];
      return api(it.m, it.p, it.b).then(function () { envoyes++; return true; }, function (e) {
        if (!e.status || e.status === 503) return false;     // toujours sans réseau : on réessaiera
        var r = lireLS(REFUS, []); r.push({ t: it.t, p: it.p, message: e.message }); ecrireLS(REFUS, r);
        return true;                                         // refusé par le serveur : retiré de la file, signalé
      }).then(function (retirer) {
        if (!retirer) return;
        ecrireLS(FILE, lireLS(FILE, []).filter(function (x) { return x.id !== it.id; }));
        return suivant();
      });
    }
    return suivant().then(function () {
      vidage = false; majFile();
      if (envoyes) { LabeTerrain.toast(envoyes + ' envoi(s) de terrain transmis (déchets).'); charger(); }
    }, function () { vidage = false; });
  }
  function majFile() {
    var l = lireLS(FILE, []), r = lireLS(REFUS, []), div = $('dech-file');
    div.innerHTML = (l.length ? '<p class="fon-avert">📶 ' + l.length + ' envoi(s) en attente de réseau, transmis automatiquement. ' +
      '<button type="button" id="dech-file-go">Envoyer maintenant</button></p>' : '') +
      (r.length ? '<div class="fon-avert"><b>Envois refusés par le serveur :</b><ul>' + r.map(function (x) {
        return '<li>' + dateFr(x.t) + ' ' + heureFr(x.t) + ' — ' + esc(x.message) + '</li>';
      }).join('') + '</ul><button type="button" id="dech-refus-ok">Effacer</button></div>' : '');
    if ($('dech-file-go')) $('dech-file-go').onclick = function () { viderFile(); };
    if ($('dech-refus-ok')) $('dech-refus-ok').onclick = function () { ecrireLS(REFUS, []); majFile(); };
    rendreBadgeTerrain();
  }
  window.addEventListener('online', function () { viderFile(); });
  setInterval(function () { if (navigator.onLine) viderFile(); }, 60000);

  // ---------- Terrain : programme du jour et passages ----------
  function localPassages() { return lireLS(PASSAGES, {}); }
  function garderPassage(pa) {
    var all = localPassages(), limite = Date.now() - 7 * 864e5;
    Object.keys(all).forEach(function (k) { if (new Date(all[k].debut).getTime() < limite) delete all[k]; });
    all[pa.uid] = pa; ecrireLS(PASSAGES, all);
  }
  function chargerJour() {
    var d = $('dech-date').value || jourIso();
    api('GET', '/jour?date=' + d).then(function (r) { programme = r; rendreJour(); })
      .catch(function () { rendreJour(); });
  }
  $('dech-date').onchange = chargerJour;
  function rendreBadgeTerrain() {
    var n = 0;
    if (programme && programme.date === jourIso()) {
      var locaux = localPassages();
      n = programme.tournees.filter(function (t) {
        return !programme.passages.some(function (x) { return x.tournee === t.id; }) &&
          !Object.keys(locaux).some(function (k) { return locaux[k].tournee === t.id && locaux[k].date === programme.date; });
      }).length;
    }
    $('dech-ter-badge').textContent = n; $('dech-ter-badge').classList.toggle('hidden', !n);
  }
  function rendreJour() {
    var ul = $('dech-jour'), d = $('dech-date').value || jourIso();
    rendreBadgeTerrain();
    if (!programme || programme.date !== d) { ul.innerHTML = '<li class="empty"><small>Programme indisponible (hors connexion ?).</small></li>'; return; }
    var locaux = localPassages();
    ul.innerHTML = programme.tournees.length ? '' : '<li class="empty"><small>Aucune tournée prévue le ' + esc(programme.jour) + ' ' + dateFr(d) + '.</small></li>';
    programme.tournees.forEach(function (t) {
      var p = t.properties, li = document.createElement('li');
      var pa = programme.passages.filter(function (x) { return x.tournee === t.id; })[0];
      var loc = Object.keys(locaux).map(function (k) { return locaux[k]; }).filter(function (x) { return x.tournee === t.id && x.date === d && x.statut !== 'Annulé'; })[0];
      var etat = pa ? pa.statut + ' · ' + pa.faits + '/' + pa.prevus + ' point(s) relevé(s)' + (pa.agent ? ' · ' + pa.agent : '') :
        loc ? loc.statut + ' · ' + Object.keys(loc.releves).length + '/' + loc.points.length + ' (en attente d\'envoi)' : 'pas commencée';
      li.className = 'fon-dossier' + (pa || loc ? '' : ' retard');
      li.innerHTML = '<b>' + esc(p.code) + ' — ' + esc(p.nom) + '</b><small>' + (p.heure_depart ? esc(p.heure_depart) + ' · ' : '') + esc(p.moyen) +
        ' · ' + p.points.length + ' point(s)' + (p.duree_min ? ' · ' + duree(p.duree_min) : '') + '<br>' + esc(etat) + '</small>';
      var bar = document.createElement('div'); bar.className = 'row';
      var uid = pa ? pa.uid : loc && loc.uid;
      if (uid) btn(bar, (pa || loc).statut === 'Terminé' ? 'Voir' : '▶ Reprendre', 'primary', function (e) { e.stopPropagation(); ouvrirPassage(uid); });
      else if (p.points.length) btn(bar, '▶ Démarrer', 'primary', function (e) { e.stopPropagation(); demarrer(t, d); });
      li.appendChild(bar);
      li.onclick = function () { ouvrirTournee(t.id); };
      ul.appendChild(li);
    });
  }
  function demarrer(t, date) {
    var p = t.properties, uid = LabeTerrain.uuid(), d = date || jourIso();
    var pa = { uid: uid, tournee: t.id, code: p.code, nom: p.nom, date: d, debut: new Date().toISOString(), statut: 'En cours',
      points: p.points.slice(), releves: {}, agent: Auth.user().nom };
    garderPassage(pa);
    envoyer('POST', '/passages', { uid: uid, tournee: t.id, date: d, debut: pa.debut }).then(function (r) {
      if (r && !r.enAttente) { garderPassage(fusion(pa, r)); }
      sousOnglet('ter'); ouvrirPassage(uid);
    }).catch(fail);
  }
  function fusion(local, serveur) {
    var pa = { uid: serveur.uid, tournee: serveur.tournee, code: serveur.code, nom: serveur.nom, date: serveur.date, debut: serveur.debut,
      fin: serveur.fin, statut: serveur.statut, points: serveur.points, releves: {}, agent: serveur.agent, commentaire: serveur.commentaire };
    Object.keys(serveur.releves).forEach(function (k) { pa.releves[k] = serveur.releves[k]; });
    // relevés faits hors connexion, pas encore arrivés au serveur
    var file = lireLS(FILE, []);
    file.forEach(function (it) {
      if (it.p === '/passages/' + pa.uid + '/releve') { if (it.b.statut) pa.releves[it.b.point] = it.b; else delete pa.releves[it.b.point]; }
      if (it.p === '/passages/' + pa.uid + '/terminer') pa.statut = 'Terminé';
    });
    return pa;
  }
  function ouvrirPassage(uid) {
    api('GET', '/passages/' + uid).then(function (s) {
      var pa = fusion(localPassages()[uid] || {}, s); garderPassage(pa); rendrePassage(pa);
    }, function (e) {
      var pa = localPassages()[uid];
      if (pa) rendrePassage(pa); else fail(e);
    });
  }
  function rendrePassage(pa) {
    var t = tourById[pa.tournee], d = document.createElement('div'), faits = Object.keys(pa.releves).length;
    ficheCourante = { passage: pa.uid };
    d.innerHTML = '<h3>Passage — ' + esc(pa.code) + ' ' + esc(pa.nom) + '</h3><p>' + dateFr(pa.date) + ' · <span class="badge ' + cls(pa.statut) + '">' + esc(pa.statut) +
      '</span>' + (pa.agent ? ' · ' + esc(pa.agent) : '') + '</p>' +
      '<div class="dech-progres"><i style="width:' + (100 * faits / Math.max(1, pa.points.length)).toFixed(0) + '%"></i></div>' +
      '<p class="hint">' + faits + ' / ' + pa.points.length + ' point(s) relevé(s). Marquez chaque point au passage ; sans réseau, les relevés sont gardés dans le téléphone.</p>';
    var ol = document.createElement('ol'); ol.className = 'dech-ordre dech-passage';
    var ordre = [];
    pa.points.forEach(function (id, i) {
      var x = parId[id], r = pa.releves[id], li = document.createElement('li');
      var p = x ? x.f.properties : { numero: 'n° ' + id, type: '' };
      if (x) ordre.push(x.f);
      li.className = r ? cls(r.statut) : '';
      li.innerHTML = '<div><b>' + (i + 1) + '. ' + esc(p.numero) + '</b> ' + esc(p.nom || p.type) +
        (r ? ' — <span class="badge ' + cls(r.statut) + '">' + esc(r.statut) + '</span>' + (r.motif ? ' <small>' + esc(r.motif) + '</small>' : '') : '') + '</div>';
      var bar = document.createElement('div'); bar.className = 'row';
      if (pa.statut !== 'Annulé') {
        btn(bar, '✓ Collecté', r && r.statut === 'Collecté' ? 'primary' : '', function (e) { e.stopPropagation(); relever(pa, id, 'Collecté'); });
        btn(bar, '⚠ Saturé', r && r.statut === 'Saturé' ? 'primary' : '', function (e) { e.stopPropagation(); relever(pa, id, 'Saturé'); });
        btn(bar, '✗ Non collecté', r && r.statut === 'Non collecté' ? 'primary' : '', function (e) {
          e.stopPropagation();
          var sel = document.createElement('select');
          sel.innerHTML = '<option value="">— motif —</option>' + LISTES.motifs.map(function (m) { return '<option>' + esc(m) + '</option>'; }).join('');
          sel.onclick = function (ev) { ev.stopPropagation(); };
          sel.onchange = function () {
            var m = sel.value;
            if (m === 'Autre') m = (prompt('Motif :', '') || '').trim();
            if (m) relever(pa, id, 'Non collecté', m);
          };
          bar.innerHTML = ''; bar.appendChild(sel); sel.focus();
        });
        if (r) btn(bar, '↶', 'mini', function (e) { e.stopPropagation(); relever(pa, id, ''); }).title = 'Annuler ce relevé';
      }
      li.appendChild(bar);
      li.onclick = function () { if (x) { map.setView(x.l.getLatLng(), Math.max(map.getZoom(), 18)); } };
      ol.appendChild(li);
    });
    d.appendChild(ol);
    var bar = document.createElement('div'); bar.className = 'row';
    if (pa.statut === 'En cours') btn(bar, 'Terminer la tournée', 'primary', function () {
      var manque = pa.points.length - Object.keys(pa.releves).length;
      if (manque && !confirm(manque + ' point(s) sans relevé. Terminer quand même ?')) return;
      var c = prompt('Commentaire (facultatif) :', '');
      if (c === null) return;
      pa.statut = 'Terminé'; pa.fin = new Date().toISOString(); garderPassage(pa);
      envoyer('POST', '/passages/' + pa.uid + '/terminer', { commentaire: c.trim() || null, fin: pa.fin }).then(function (r) {
        LabeTerrain.toast(r && r.enAttente ? 'Tournée terminée (envoi au retour du réseau).' : 'Tournée terminée.');
        charger(); sousOnglet('ter');
      }).catch(fail);
    });
    if (gerer() && pa.statut !== 'Annulé') btn(bar, 'Annuler le passage', 'danger', function () {
      var c = prompt('Motif de l\'annulation :', '');
      if (c === null) return;
      api('POST', '/passages/' + pa.uid + '/annuler', { commentaire: c.trim() || null }).then(function () { charger(); sousOnglet('ter'); }).catch(fail);
    });
    d.appendChild(bar);
    montrerFiche(d);
    if (t) dessinerTournee(t, ordre);
  }
  function relever(pa, id, statut, motif) {
    var corps = { point: id, statut: statut, motif: motif || null, heure: new Date().toISOString() };
    if (statut) pa.releves[id] = corps; else delete pa.releves[id];
    garderPassage(pa);
    rendrePassage(pa);
    envoyer('POST', '/passages/' + pa.uid + '/releve', corps).then(function (r) {
      if (r && !r.enAttente && statut !== 'Collecté') charger();  // état du point changé (saturé…)
    }).catch(function (e) { fail(e); ouvrirPassage(pa.uid); });
  }

  // ---------- Bilan ----------
  function barres(items, val, lib, fmt) {
    var max = Math.max.apply(null, items.map(val).concat([1]));
    return '<div class="fon-barres">' + items.map(function (it) {
      var v = val(it), txt = fmt ? fmt(it) : A.fmt(v);
      return '<div class="fon-barre" title="' + esc(lib(it)) + ' : ' + esc(txt) + '"><span>' + esc(lib(it)) + '</span>' +
        '<i><b style="width:' + (100 * v / max).toFixed(1) + '%"></b></i><em>' + esc(txt) + '</em></div>';
    }).join('') + '</div>';
  }
  function colonnes(mois, cle, titre) {
    var W = 300, H = 100, pad = 18, n = mois.length, max = Math.max.apply(null, mois.map(function (m) { return m[cle]; }).concat([1]));
    var bw = (W - 2) / n;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + (H + pad) + '" class="fon-col" role="img" aria-label="' + esc(titre) + '">' +
      '<line x1="0" y1="' + H + '" x2="' + W + '" y2="' + H + '" class="axe"/>';
    mois.forEach(function (m, i) {
      var h = (H - 14) * m[cle] / max, x = 1 + i * bw, hh = Math.max(h, m[cle] ? 2 : 0);
      var lib = new Date(m.mois + '-01').toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
      svg += '<g><title>' + esc(lib + ' : ' + m[cle]) + '</title><rect x="' + (x + 3) + '" y="' + (H - hh) + '" width="' + (bw - 6) +
        '" height="' + hh + '" rx="2"/><rect x="' + x + '" y="0" width="' + bw + '" height="' + H + '" class="cible"/>' +
        (m[cle] ? '<text x="' + (x + bw / 2) + '" y="' + (H - h - 3) + '" class="v">' + m[cle] + '</text>' : '') +
        (i % 2 === 0 ? '<text x="' + (x + bw / 2) + '" y="' + (H + 12) + '" class="m">' + esc(lib) + '</text>' : '') + '</g>';
    });
    return svg + '</svg>';
  }
  function chargerBilan() {
    var div = $('dech-bilan');
    api('GET', '/bilan').then(function (b) {
      var enService = 0, sauvages = 0, vol = 0;
      b.par_type.forEach(function (x) {
        if (x.etat === 'Actif' || x.etat === 'Saturé') { enService += x.n; if (x.type === 'Dépôt sauvage') { sauvages += x.n; vol += x.volume; } }
      });
      var html = '<div class="stat-cards">' + carte(A.fmt(enService), 'points en service') +
        carte(A.fmt(sauvages), 'dépôts sauvages ouverts' + (vol ? ' · ' + A.fmt(vol, 0) + ' m³' : ''), sauvages ? 'alerte' : '') +
        carte(b.satures.length, 'points saturés', b.satures.length ? 'alerte' : '') +
        carte(b.a_verifier, 'à vérifier') +
        carte(b.a_revoir, 'sans constat depuis ' + b.constat_ancien_j + ' j', b.a_revoir ? 'alerte' : '') +
        carte(b.resorption.j != null ? A.fmt(b.resorption.j, 1) + ' j' : '—', 'délai moyen de résorption (' + b.resorption.n + ' dépôt(s))') + '</div>';
      html += '<h4>Dépôts sauvages ouverts par quartier</h4>' + (b.depots_quartier.some(function (q) { return q.ouverts; }) ?
        barres(b.depots_quartier.filter(function (q) { return q.ouverts; }).slice(0, 15), function (q) { return q.ouverts; }, function (q) { return q.quartier; },
          function (q) { return q.ouverts + (q.volume ? ' · ' + A.fmt(q.volume, 0) + ' m³' : ''); }) : '<p class="hint">Aucun dépôt sauvage ouvert.</p>');
      html += '<h4>Dépôts sauvages signalés, par mois</h4>' + colonnes(b.mois, 'signales', 'Dépôts sauvages signalés par mois') +
        '<h4>Dépôts sauvages résorbés, par mois</h4>' + colonnes(b.mois, 'resorbes', 'Dépôts sauvages résorbés par mois');
      html += '<h4>Tournées — 30 derniers jours</h4>' + (b.tournees.length ? '<table class="info-table fon-table"><tr><th>Tournée</th><th>Passages</th><th>Points collectés</th><th>Jours manqués</th></tr>' +
        b.tournees.map(function (t) {
          var taux = t.prevus ? Math.round(100 * Math.min(t.realises, t.prevus) / t.prevus) : null;
          var tp = t.points_prevus ? Math.round(100 * t.points_collectes / t.points_prevus) : null;
          return '<tr data-t="' + t.id + '" class="cliquable"><td><b>' + esc(t.code) + '</b> ' + esc(t.nom) + '</td><td>' + t.realises + ' / ' + t.prevus +
            (taux != null ? ' (' + taux + ' %)' : '') + '</td><td>' + (tp != null ? t.points_collectes + ' / ' + t.points_prevus + ' (' + tp + ' %)' : '—') + '</td><td>' +
            (t.manques.length ? '<b class="retard-txt">' + t.manques.length + '</b> <small>' + t.manques.slice(0, 4).map(dateFr).join(', ') + (t.manques.length > 4 ? '…' : '') + '</small>' : '0') + '</td></tr>';
        }).join('') + '</table>' : '<p class="hint">Aucune tournée active.</p>');
      html += '<h4>Motifs de non-collecte (30 jours)</h4>' + (b.motifs.length ? barres(b.motifs, function (m) { return m.n; }, function (m) { return m.motif || '—'; }) :
        '<p class="hint">Aucun point non collecté.</p>');
      if (b.satures.length) html += '<h4>Points saturés</h4><ul class="fon-ctl">' + b.satures.map(function (s) {
        return '<li data-p="' + s.id + '"><b>' + esc(s.numero) + '</b> ' + esc(s.type) + ' · ' + esc(s.quartier || '—') + ' <small>depuis le ' + dateFr(s.dernier_constat) + '</small></li>';
      }).join('') + '</ul>';
      div.innerHTML = html;
      div.querySelectorAll('[data-t]').forEach(function (tr) { tr.onclick = function () { ouvrirTournee(+tr.dataset.t); }; });
      div.querySelectorAll('[data-p]').forEach(function (li) { li.onclick = function () { ouvrirPoint(+li.dataset.p); }; });
    }).catch(function (e) { div.innerHTML = '<p class="form-msg">' + esc(e.message) + '</p>'; });
    rendreParametres();
  }
  $('dech-couv-btn').onclick = function () { chargerCouverture(); };
  function chargerCouverture() {
    var div = $('dech-couverture');
    div.innerHTML = '<p class="hint">Calcul de la couverture (44 000 bâtiments)…</p>';
    api('GET', '/couverture').then(function (c) {
      var pct = c.batiments ? 100 * c.desservis / c.batiments : 0;
      div.innerHTML = '<p><b>' + A.fmt(pct, 1) + ' %</b> des bâtiments sont desservis (' + A.fmt(c.desservis) + ' sur ' + A.fmt(c.batiments) +
        ') : à moins de ' + c.rayon_m + ' m d\'une tournée active ou d\'un point de collecte en service.</p>' +
        '<label class="check"><input type="checkbox" id="dech-nd-carte"' + (map.hasLayer(nonDesservis) ? ' checked' : '') + '> Montrer les bâtiments non desservis sur la carte</label>' +
        '<p class="hint">Part de bâtiments non desservis, par quartier :</p>' +
        barres(c.quartiers.slice().sort(function (a, b) { return (b.batiments - b.desservis) / b.batiments - (a.batiments - a.desservis) / a.batiments; }),
          function (q) { return 100 * (q.batiments - q.desservis) / q.batiments; }, function (q) { return q.quartier; },
          function (q) { return A.fmt(100 * (q.batiments - q.desservis) / q.batiments, 0) + ' % · ' + A.fmt(q.batiments - q.desservis); }) +
        '<div class="row"><button type="button" id="dech-couv-btn2">Recalculer</button></div>';
      $('dech-couv-btn2').onclick = chargerCouverture;
      $('dech-nd-carte').onchange = function () {
        if (!this.checked) { map.removeLayer(nonDesservis); syncOverlay(false); return; }
        afficherNonDesservis();
      };
      if (map.hasLayer(nonDesservis)) afficherNonDesservis();
    }).catch(function (e) { div.innerHTML = '<p class="form-msg">' + esc(e.message) + '</p>'; });
  }
  var ndLab = null;
  function syncOverlay(on) { if (ndLab) ndLab.querySelector('input').checked = on; }
  function afficherNonDesservis() {
    api('GET', '/couverture/non-desservis').then(function (pts) {
      nonDesservis.clearLayers();
      pts.forEach(function (c) {
        L.circleMarker([c[1], c[0]], { renderer: rendu, radius: 2.5, stroke: false, fillColor: S.SATURE, fillOpacity: 0.8, interactive: false }).addTo(nonDesservis);
      });
      nonDesservis.addTo(map); syncOverlay(true);
      LabeTerrain.toast(A.fmt(pts.length) + ' bâtiment(s) non desservi(s) affiché(s) en rouge.');
    }).catch(fail);
  }
  var LIB_PARAM = { rayon_desserte_m: 'Distance de desserte (m)', arret_min: 'Durée d\'un arrêt (min)', constat_ancien_j: 'Constat à revoir après (jours)' };
  function rendreParametres() {
    var div = $('dech-parametres');
    div.innerHTML = '<table class="info-table">' + LISTES.parametres.map(function (x) {
      return '<tr><td title="' + esc(x.description) + '">' + esc(LIB_PARAM[x.cle] || x.cle) + '</td><td>' +
        (gerer() ? '<input type="number" min="0" step="1" data-k="' + esc(x.cle) + '" value="' + x.valeur + '" style="width:80px"> ' : A.fmt(x.valeur)) + '</td></tr>';
    }).join('') + '</table>' + (gerer() ? '<div class="row"><button type="button" id="dech-param-ok">Enregistrer les paramètres</button></div>' : '');
    if ($('dech-param-ok')) $('dech-param-ok').onclick = function () {
      Promise.all(Array.prototype.map.call(div.querySelectorAll('[data-k]'), function (inp) {
        return api('PUT', '/parametres/' + inp.dataset.k, { valeur: parseFloat(inp.value) || 0 });
      })).then(function () { return api('GET', '/listes'); }).then(function (l) { LISTES = l; LabeTerrain.toast('Paramètres enregistrés.'); rendreParametres(); }).catch(fail);
    };
  }

  // ---------- Tables attributaires ----------
  function tablePoints() {
    return points.map(function (f) {
      var p = f.properties;
      return { layer: parId[p.id] && parId[p.id].l, feature: { type: 'Feature', geometry: f.geometry, properties: {
        'Numéro': p.numero, 'Type': p.type, 'Nom': p.nom, 'État': p.etat, 'Volume (m³)': p.volume_m3, 'Capacité (m³)': p.capacite_m3,
        'Accès': p.acces, 'Quartier': p.quartier, 'Tournées': p.tournees.join(', '), 'Vérifié': p.verifie ? 'oui' : 'non',
        'Recensé le': p.cree_le, 'Dernier constat': p.dernier_constat, 'Résorbé / fermé le': p.resorbe_le } } };
    });
  }
  function tableTournees() {
    return tournees.filter(function (f) { return f.geometry; }).map(function (f) {
      var p = f.properties;
      return { layer: null, feature: { type: 'Feature', geometry: f.geometry, properties: {
        'Code': p.code, 'Nom': p.nom, 'Jours': p.jours_texte, 'Départ': p.heure_depart, 'Moyen': p.moyen, 'Véhicule': p.vehicule,
        'Équipe': p.equipe, 'Prestataire': p.prestataire, 'Points': p.points.length, 'Longueur (m)': p.longueur_m, 'Durée (min)': p.duree_min,
        'Quartiers': p.quartiers.join(', '), 'Active': p.active ? 'oui' : 'non', 'Dernier passage': p.dernier_passage } } };
    });
  }

  // ---------- Démarrage ----------
  function start() {
    $('dech-date').value = jourIso();
    api('GET', '/listes').then(function (l) {
      LISTES = l;
      remplir($('dech-f-type'), l.types, 'Tous les types');
      A.ready.then(function () {
        A.enregistrerIdentifiable(couche, 'Points de collecte et dépotoirs');
        A.enregistrerIdentifiable(coucheTournees, 'Tournées de collecte');
        A.addOverlay({ name: 'Points de collecte et dépotoirs', layer: couche, on: true, group: 'Gestion des déchets', table: tablePoints,
          swatch: '<span class="swatch dot" style="background:' + S.CLASSES[1].couleur + '"></span>',
          legend: S.legende().concat([['Bord en tirets : à vérifier', '#fff', 'dot']]) });
        A.addOverlay({ name: 'Tournées de collecte', layer: coucheTournees, on: true, group: 'Gestion des déchets', table: tableTournees,
          swatch: '<span class="swatch line" style="background:' + S.TOURNEE + '"></span>' });
        ndLab = A.addOverlay({ name: 'Bâtiments non desservis (couverture)', on: false, group: 'Gestion des déchets', table: false,
          onToggle: function (on) { if (on) { if (!nonDesservis.getLayers().length) afficherNonDesservis(); else nonDesservis.addTo(map); } else map.removeLayer(nonDesservis); },
          swatch: '<span class="swatch dot" style="background:' + S.SATURE + '"></span>' });
      });
      majFile(); viderFile();
      return charger();
    }).catch(fail);
  }

  window.LabeDechets = { start: start, ouvrirPoint: ouvrirPoint, ouvrirTournee: ouvrirTournee, sousOnglet: sousOnglet };
})();
