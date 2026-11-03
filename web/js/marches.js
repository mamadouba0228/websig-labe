/* Marchés et gares routières (espace agents) :
 * - sites : marchés et gares recensés sur la carte (point ou emprise) ou au GPS, importés des équipements de la carte,
 *   ou venus des saisies « Marché » / « Gare routière » de l'onglet Saisie ;
 * - emplacements : boutiques, étals, places, bureaux de ligne… avec leur occupant et leur loyer (service seulement) ;
 * - recettes : loyers, tickets journaliers, droits de stationnement, quittance imprimable, annulation par un superviseur ;
 * - impayés et bilan. Les encaissements faits sans réseau partent au retour de la connexion (file partagée avec les déchets). */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc, C = window.LabeMarCarte;

  function $(id) { return document.getElementById(id); }
  function api(m, p, b) { return Auth.api(m, '/marches' + p, b); }
  function envoyer(m, p, b) { return LabeDechets.envoyer(m, '/marches' + p, b); }
  function fail(e) { alert('Erreur : ' + e.message); }
  function gerer() { return !!(LISTES && LISTES.peut_gerer); }
  function dateFr(d) { return d ? new Date(d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('fr-FR') : ''; }
  function moisFr(m) { return m ? new Date(m.slice(0, 7) + '-15').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }) : ''; }
  function gnf(v) { return A.fmt(v || 0) + ' GNF'; }
  function cls(s) { return 'm-' + String(s).replace(/[\s'/]/g, '-'); }
  function badge(s) { return '<span class="badge ' + cls(s) + '">' + esc(s) + '</span>'; }
  function aujourdhui() { var d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function btn(parent, texte, classe, fn) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = texte;
    if (classe) b.className = classe; b.onclick = fn; parent.appendChild(b); return b;
  }
  function table(rows) {
    return '<table class="info-table">' + rows.filter(function (r) { return r[1] !== null && r[1] !== undefined && r[1] !== ''; })
      .map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + (r[2] ? r[1] : esc(r[1])) + '</td></tr>'; }).join('') + '</table>';
  }
  function carte(v, lib, extra) { return '<div class="stat-card' + (extra ? ' ' + extra : '') + '"><b>' + v + '</b><span>' + lib + '</span></div>'; }
  function pct(a, b) { return b ? Math.round(100 * a / b) + ' %' : '—'; }
  function remplir(sel, valeurs, vide) {
    var cur = sel.value;
    sel.innerHTML = vide != null ? '<option value="">' + esc(vide) + '</option>' : '';
    valeurs.forEach(function (v) { var o = Array.isArray(v) ? v : [v, v]; sel.add(new Option(o[1], o[0], false, String(o[0]) === cur)); });
  }
  function telecharger(chemin, nom) {
    Auth.blobUrl('/api/marches' + chemin).then(function (u) { var a = document.createElement('a'); a.href = u; a.download = nom; a.click(); })
      .catch(function () { alert('Export impossible.'); });
  }
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
  function geometrie(mode, pts) {
    var c = pts.map(function (p) { return [+p.lng.toFixed(7), +p.lat.toFixed(7)]; });
    if (mode === 'point') return { type: 'Point', coordinates: c[0] };
    return { type: 'Polygon', coordinates: [c.concat([c[0]])] };
  }
  function photoFiche(el, url) {
    if (!url) return;
    var d = document.createElement('div'); d.className = 'dech-photo'; d.textContent = 'Chargement de la photo…'; el.appendChild(d);
    Auth.blobUrl(url).then(function (u) { d.innerHTML = '<a href="' + u + '" target="_blank"><img src="' + u + '" alt="Photo"></a>'; })
      .catch(function () { d.textContent = ''; });
  }

  // ---------- Formulaire générique ----------
  // champs : { n, l, t: text|textarea|number|date|month|select|photo, o: options, req, ph, min, max, step, aide, vide }
  var MF = { form: $('mar-form'), modal: $('mar-modal'), champs: [], photos: {}, envoi: null };
  function formulaire(titre, champs, valeurs, envoi) {
    valeurs = valeurs || {};
    MF.champs = champs; MF.photos = {}; MF.envoi = envoi;
    $('mar-mf-titre').textContent = titre;
    $('mar-mf-msg').textContent = '';
    var div = $('mar-mf-champs'); div.innerHTML = '';
    champs.forEach(function (c) {
      var lab = document.createElement('label'), v = valeurs[c.n], el;
      lab.textContent = c.l + (c.req ? ' *' : '');
      if (c.t === 'select') {
        el = document.createElement('select');
        (c.o || []).forEach(function (o) { var x = Array.isArray(o) ? o : [o, o]; el.add(new Option(x[1], x[0], false, String(x[0]) === String(v))); });
        if (c.vide) el.insertBefore(new Option(c.vide, ''), el.firstChild);
        if (v == null && c.vide) el.value = '';
      } else if (c.t === 'textarea') {
        el = document.createElement('textarea'); el.rows = 2; el.value = v != null ? v : '';
      } else {
        el = document.createElement('input');
        el.type = c.t === 'photo' ? 'file' : c.t || 'text';
        if (c.t === 'photo') { el.accept = 'image/*'; el.setAttribute('capture', 'environment'); }
        else el.value = v != null ? v : '';
        ['min', 'max', 'step'].forEach(function (k) { if (c[k] != null) el[k] = c[k]; });
      }
      el.name = c.n;
      if (c.req && c.t !== 'photo') el.required = true;
      if (c.ph) el.placeholder = c.ph;
      lab.appendChild(el);
      div.appendChild(lab);
      if (c.t === 'photo') {
        var ap = document.createElement('div'); ap.className = 'dech-photo'; div.appendChild(ap);
        el.onchange = function () { lirePhoto(el, ap).then(function (d) { MF.photos[c.n] = d; }); };
      }
      if (c.aide) { var h = document.createElement('p'); h.className = 'hint'; h.textContent = c.aide; div.appendChild(h); }
    });
    MF.modal.classList.remove('hidden');
  }
  $('mar-mf-annuler').onclick = function () { MF.modal.classList.add('hidden'); apercu.clearLayers(); };
  MF.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var el = MF.form.elements, v = {};
    MF.champs.forEach(function (c) {
      if (c.t === 'photo') { if (MF.photos[c.n]) v[c.n] = MF.photos[c.n]; return; }
      var x = el[c.n];
      if (c.t === 'number') v[c.n] = x.value === '' ? null : parseFloat(String(x.value).replace(',', '.'));
      else v[c.n] = x.value.trim() === '' ? null : x.value.trim();
    });
    var bouton = MF.form.querySelector('[type=submit]'); bouton.disabled = true;
    Promise.resolve().then(function () { return MF.envoi(v); }).then(function () {
      MF.modal.classList.add('hidden'); apercu.clearLayers();
    }).catch(function (err) { $('mar-mf-msg').textContent = err.message; }).then(function () { bouton.disabled = false; });
  });
  function enAttente(r) {
    if (r && r.enAttente) { LabeTerrain.toast('Pas de réseau : la saisie est gardée dans le téléphone et sera envoyée automatiquement.'); return true; }
    return false;
  }
  // site tout près d'un autre : on demande avant d'enregistrer quand même
  function avecDoublon(envoi) {
    return envoi(false).catch(function (e) {
      if (e.status === 409 && e.detail && e.detail.proche && confirm(e.message + '\n\nEnregistrer quand même ?')) return envoi(true);
      throw e;
    });
  }

  // ---------- Données et couches ----------
  var LISTES = null, sites = [], saisies = [], impayes = [], recettes = [], placesCarte = {};
  var parId = {};
  var cSites = A.markClicks(L.featureGroup()), cPlaces = A.markClicks(L.featureGroup());
  var surbrillance = L.featureGroup().addTo(map), apercu = L.featureGroup().addTo(map);
  var recherches = [], siteOuvert = null;

  function infoSite(q) {
    return { libelle: q.nom + ' (' + q.numero + ')', 'Type': q.type, 'État': q.etat, 'Gestion': q.gestion, 'Jours': q.jours, 'Horaires': q.horaires,
      'Destinations': q.destinations, 'Capacité': q.capacite ? q.capacite + ' véhicules' : null, 'Emplacements': q.places || null,
      'Occupés': q.places ? q.occupees : null, 'Libres': q.places ? q.libres : null, 'Responsable': q.responsable, 'Quartier': q.quartier };
  }
  function popupSite(q) {
    var d = document.createElement('div'); d.className = 'popup';
    d.innerHTML = '<h4>' + esc(q.nom) + ' (' + esc(q.numero) + ')</h4><table>' + [['Type', q.type], ['État', q.etat], ['Jours', q.jours],
      ['Emplacements', q.places ? q.places + ' dont ' + q.libres + ' libre(s)' : null], ['Destinations', q.destinations]]
      .filter(function (r) { return r[1]; }).map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>';
    var bar = document.createElement('div'); bar.className = 'row';
    btn(bar, 'Ouvrir la fiche', 'primary', function () { map.closePopup(); ouvrirSite(q.id); });
    d.appendChild(bar);
    return d;
  }
  function dessiner() {
    cSites.clearLayers(); parId = {};
    recherches.forEach(function (it) { var i = A.searchIndex.indexOf(it); if (i >= 0) A.searchIndex.splice(i, 1); });
    recherches = [];
    sites.forEach(function (f) {
      var p = f.properties, g = L.featureGroup();
      var m = C.dessinerSite(f, g, function () { return popupSite(p); });
      m.feature = { type: 'Feature', geometry: p.centre, properties: infoSite(p) };
      g.eachLayer(function (l) { cSites.addLayer(l); });
      parId[p.id] = { f: f, l: m };
      var it = { name: p.nom, type: p.type, layer: m, parent: cSites };
      A.searchIndex.push(it); recherches.push(it);
    });
  }
  // emplacements placés sur la carte (ceux du site ouvert, ou de tous les sites quand la couche est affichée)
  function dessinerPlaces() {
    cPlaces.clearLayers();
    var dus = {};
    impayes.forEach(function (x) { dus[x.id] = x; });
    Object.keys(placesCarte).forEach(function (sid) {
      placesCarte[sid].forEach(function (p) {
        if (!p.geometry) return;
        p.impaye = !!dus[p.id];
        var l = L.circleMarker([p.geometry.coordinates[1], p.geometry.coordinates[0]], C.stylePlace(p));
        l.feature = { type: 'Feature', geometry: p.geometry, properties: { libelle: 'Emplacement ' + p.numero, 'Type': p.type, 'Statut': p.statut,
          'Activité': p.activite, 'Occupant': p.occupant, 'Loyer mensuel': p.loyer_gnf ? gnf(p.loyer_gnf) : null, 'Loyer impayé': p.impaye ? 'oui' : null } };
        l.bindTooltip(p.numero + ' · ' + p.statut + (p.occupant ? ' · ' + p.occupant : '') + (p.impaye ? ' · impayé' : ''));
        if (gerer()) l.on('click', function () { ouvrirPlace(p.id); });
        cPlaces.addLayer(l);
      });
    });
  }

  function charger() {
    return Promise.all([api('GET', '/sites'), gerer() ? api('GET', '/saisies') : Promise.resolve([]),
      gerer() ? api('GET', '/impayes') : Promise.resolve([])])
      .then(function (r) {
        sites = r[0].features; saisies = r[1]; impayes = r[2];
        var opts = sites.map(function (f) { return [f.properties.id, f.properties.nom]; });
        remplir($('mar-r-site'), opts, 'Tous les sites'); remplir($('mar-i-site'), opts, 'Tous les sites');
        dessiner(); dessinerPlaces(); rendre();
        if (!$('mar-rec').classList.contains('hidden')) chargerRecettes();
      }).catch(fail);
  }

  function surligner(geometry) {
    surbrillance.clearLayers();
    if (!geometry) return;
    if (geometry.type === 'Point') {
      var ll = L.latLng(geometry.coordinates[1], geometry.coordinates[0]);
      L.circleMarker(ll, { radius: 20, color: '#f2c230', weight: 4, fill: false, interactive: false }).addTo(surbrillance);
      map.setView(ll, Math.max(map.getZoom(), 17));
    } else {
      var g = L.geoJSON(geometry, { style: { color: '#f2c230', weight: 4, fill: false }, interactive: false }).addTo(surbrillance);
      map.fitBounds(g.getBounds(), { maxZoom: 18, padding: [30, 30] });
    }
  }

  // ---------- Sous-onglets et fiches ----------
  function sousOnglet(k) {
    document.querySelectorAll('.mar-switch button').forEach(function (b) { b.classList.toggle('active', b.dataset.mar === k); });
    ['sit', 'rec', 'imp', 'bil'].forEach(function (x) { $('mar-' + x).classList.toggle('hidden', x !== k); });
    fermerFiche();
    if (k === 'rec') chargerRecettes();
    if (k === 'bil') chargerBilan();
  }
  document.querySelectorAll('.mar-switch button').forEach(function (b) { b.onclick = function () { sousOnglet(b.dataset.mar); }; });
  function montrerFiche(el) {
    $('mar-liste-vue').classList.add('hidden');
    $('mar-fiche-vue').classList.remove('hidden');
    var f = $('mar-fiche'); f.innerHTML = ''; f.appendChild(el);
    $('tab-mar').scrollTop = 0;
  }
  function fermerFiche() {
    $('mar-fiche-vue').classList.add('hidden');
    $('mar-liste-vue').classList.remove('hidden');
    surbrillance.clearLayers();
  }
  $('mar-retour').onclick = function () { if (siteOuvert && $('mar-fiche').dataset.vue === 'place') ouvrirSite(siteOuvert); else fermerFiche(); };

  function rendre() {
    rendreSites(); rendreImpayes();
    var nImp = impayes.length;
    $('mar-imp-badge').textContent = nImp; $('mar-imp-badge').classList.toggle('hidden', !nImp);
    var nb = gerer() ? nImp + saisies.length : 0;
    $('mar-badge').textContent = nb; $('mar-badge').classList.toggle('hidden', !nb);
  }

  // ---------- Sites ----------
  var FS = { type: '', etat: '' };
  function rendreSites() {
    var nMa = 0, nGr = 0, places = 0, occ = 0;
    sites.forEach(function (f) { var p = f.properties; if (p.type === 'Gare routière') nGr++; else nMa++; places += p.places; occ += p.occupees; });
    $('mar-s-cartes').innerHTML = carte(nMa, 'marchés') + carte(nGr, 'gares routières') + carte(A.fmt(places), 'emplacements') +
      carte(pct(occ, places), 'occupés');
    var imp = $('mar-import'); imp.innerHTML = '';
    if (gerer()) {
      if (!sites.some(function (f) { return f.properties.equipement; })) {
        var p = document.createElement('p'); p.className = 'hint';
        p.textContent = 'Les marchés et gares déjà présents sur la carte (équipements) peuvent devenir des sites en un clic.';
        imp.appendChild(p);
        btn(imp, 'Importer les marchés et gares de la carte', '', function () {
          api('POST', '/sites/importer').then(function (r) { LabeTerrain.toast(r.crees + ' site(s) créé(s).'); return charger(); }).catch(fail);
        });
      }
      if (saisies.length) {
        var det = document.createElement('details'); det.className = 'adr-detail'; det.open = true;
        det.innerHTML = '<summary>Saisies « Marché » ou « Gare routière » à enregistrer : <b>' + saisies.length + '</b></summary><ul class="fon-ctl"></ul>';
        saisies.forEach(function (s) {
          var li = document.createElement('li');
          li.innerHTML = '<b>' + esc(s.type) + '</b> ' + esc(s.nom || '') + ' <small>n° ' + s.id + ' · ' + esc(s.quartier || '—') + ' · ' + dateFr(s.cree_le) +
            ' · ' + esc(s.auteur || '') + '</small>';
          var bar = document.createElement('div'); bar.className = 'row';
          btn(bar, 'Voir', '', function () { surligner(s.geometry); });
          btn(bar, 'Créer le site', 'primary', function () {
            api('POST', '/saisies/' + s.id + '/convertir').then(function (f) { return charger().then(function () { ouvrirSite(f.id); }); }).catch(fail);
          });
          li.appendChild(bar); det.querySelector('ul').appendChild(li);
        });
        imp.appendChild(det);
      }
    }
    var list = sites.filter(function (f) { return (!FS.type || f.properties.type === FS.type) && (!FS.etat || f.properties.etat === FS.etat); });
    var ul = $('mar-sites');
    ul.innerHTML = list.length ? '' : '<li class="empty"><small>Aucun site' + (sites.length ? ' pour ces critères' : ' : placez un marché ou une gare, ou importez ceux de la carte') + '.</small></li>';
    list.forEach(function (f) {
      var p = f.properties, li = document.createElement('li'), du = 0;
      impayes.forEach(function (x) { if (x.site === p.id) du += x.du; });
      li.className = 'fon-li' + (du ? ' retard' : '');
      li.style.borderLeftColor = C.couleur(p);
      li.innerHTML = '<b>' + esc(p.nom) + '</b> · ' + esc(p.numero) + '<small>' + badge(p.etat) + ' · ' + esc(p.type) + ' · ' + esc(p.quartier || '—') +
        (p.places ? ' · ' + p.occupees + '/' + p.places + ' emplacements occupés' : '') + (p.jours ? ' · ' + esc(p.jours) : '') +
        (du ? ' · <b class="retard-txt">' + gnf(du) + ' impayés</b>' : '') + '</small>';
      li.onclick = function () { ouvrirSite(p.id); };
      ul.appendChild(li);
    });
  }
  $('mar-s-type').onchange = function () { FS.type = this.value; rendreSites(); };
  $('mar-s-etat').onchange = function () { FS.etat = this.value; rendreSites(); };
  $('mar-s-export').onclick = function () { telecharger('/export/sites.csv', 'marches_gares_labe.csv'); };
  function champsSite(type) {
    var gare = type === 'Gare routière';
    var c = [{ n: 'type', l: 'Type', t: 'select', o: LISTES.types_site, req: true }, { n: 'nom', l: 'Nom', req: true, ph: gare ? 'ex. Gare voitures Mali' : 'ex. Grand marché de Labé' },
      { n: 'etat', l: 'État', t: 'select', o: LISTES.etats_site, req: true }, { n: 'gestion', l: 'Gestion', t: 'select', o: LISTES.gestions },
      { n: 'jours', l: gare ? 'Jours d\'affluence' : 'Jours de marché', ph: 'ex. tous les jours, lundi…' }, { n: 'horaires', l: 'Horaires', ph: 'ex. 7 h – 18 h' },
      { n: 'responsable', l: gare ? 'Chef de gare' : 'Régisseur ou responsable' }, { n: 'telephone', l: 'Téléphone du responsable', t: 'tel' }];
    if (gare || !type) c.push({ n: 'destinations', l: 'Destinations (gares)', ph: 'ex. Conakry, Mamou, Mali' },
      { n: 'capacite', l: 'Capacité (véhicules)', t: 'number', min: 0 });
    c.push({ n: 'tarif_ticket_gnf', l: gare ? 'Droit de stationnement par véhicule (GNF)' : 'Ticket journalier (GNF)', t: 'number', min: 0, step: 100,
      aide: 'Sert à calculer le montant à partir du nombre de tickets ou de véhicules.' },
      { n: 'observations', l: 'Observations', t: 'textarea' }, { n: 'photo', l: 'Photo', t: 'photo' });
    return c;
  }
  function nouveauSite(geom) {
    if (geom.type === 'Point') L.circleMarker([geom.coordinates[1], geom.coordinates[0]], { radius: 16, color: '#f2c230', weight: 4, fill: false }).addTo(apercu);
    else L.geoJSON(geom, { style: { color: '#f2c230', weight: 3, fillOpacity: 0.1 } }).addTo(apercu);
    formulaire('Nouveau marché ou gare routière', champsSite(null), { type: 'Marché quotidien', etat: 'En activité', gestion: 'Régie communale' }, function (v) {
      v.geometry = geom; v.uid = LabeTerrain.uuid();
      return avecDoublon(function (forcer) { v.forcer = forcer; return envoyer('POST', '/sites', v); }).then(function (r) {
        if (!map.hasLayer(cSites)) cSites.addTo(map);
        if (enAttente(r)) return;
        return charger().then(function () { ouvrirSite(r.id); });
      });
    });
  }
  $('mar-s-point').onclick = function () { A.startSketch('point', { btn: this, label: 'Marché ou gare', onFinish: function (pts) { nouveauSite(geometrie('point', pts)); } }); };
  $('mar-s-surface').onclick = function () { A.startSketch('area', { btn: this, label: 'Emprise du marché ou de la gare', onFinish: function (pts) { nouveauSite(geometrie('area', pts)); } }); };
  $('mar-s-gps').onclick = function () { LabeTerrain.pointGps(function (ll) { nouveauSite(geometrie('point', [ll])); }); };

  function ouvrirSite(id) {
    api('GET', '/sites/' + id).then(function (f) {
      siteOuvert = id;
      var p = f.properties, d = document.createElement('div'), gare = p.type === 'Gare routière';
      placesCarte = {}; placesCarte[id] = f.places; dessinerPlaces();
      if (f.places.some(function (x) { return x.geometry; }) && !map.hasLayer(cPlaces)) cPlaces.addTo(map);
      d.innerHTML = '<h3>' + esc(p.nom) + '</h3><p>' + esc(p.numero) + ' · ' + esc(p.type) + ' ' + badge(p.etat) + '</p>' +
        table([['Gestion', p.gestion], [gare ? 'Jours d\'affluence' : 'Jours de marché', p.jours], ['Horaires', p.horaires],
          ['Destinations', p.destinations], ['Capacité', p.capacite ? p.capacite + ' véhicules' : null],
          [gare ? 'Chef de gare' : 'Responsable', p.responsable], ['Téléphone', p.telephone],
          [gare ? 'Droit de stationnement' : 'Ticket journalier', p.tarif_ticket_gnf ? gnf(p.tarif_ticket_gnf) : null],
          ['Emprise', p.surface_m2 ? A.fmt(p.surface_m2) + ' m²' : null], ['Quartier', p.quartier], ['Observations', p.observations],
          ['Origine', p.equipement ? 'équipement de la carte' : p.contribution ? 'saisie n° ' + p.contribution : null], ['Recensé par', p.cree_par_nom]]);
      photoFiche(d, p.photo_url);
      if (f.recettes) {
        var r = f.recettes, du = f.impayes.reduce(function (s, x) { return s + x.du; }, 0);
        d.insertAdjacentHTML('beforeend', '<div class="stat-cards">' + carte(gnf(r.mois), 'encaissés ce mois') + carte(gnf(r.loyers_attendus), 'loyers attendus par mois') +
          carte(gnf(du), 'loyers impayés', du ? 'alerte' : '') + (gare ? carte(A.fmt(r.vehicules_30j), 'véhicules en 30 jours') : carte(gnf(r.annee), 'encaissés en 12 mois')) + '</div>');
      }
      var bar = document.createElement('div'); bar.className = 'row';
      if (f.peut_gerer) {
        btn(bar, gare ? 'Encaisser des droits de stationnement' : 'Encaisser des tickets', 'primary', function () { encaisserDroits(p); });
        btn(bar, 'Ajouter des emplacements', '', function () { ajouterPlaces(p); });
      }
      if (f.peut_modifier) {
        btn(bar, 'Modifier', '', function () {
          formulaire('Modifier ' + p.nom, champsSite(p.type), p, function (v) {
            return api('PUT', '/sites/' + p.id, v).then(function () { return charger().then(function () { ouvrirSite(p.id); }); });
          });
        });
        btn(bar, f.geometry.type === 'Point' ? 'Déplacer' : 'Redessiner l\'emprise', '', function () {
          var mode = f.geometry.type === 'Point' ? 'point' : 'area';
          A.startSketch(mode, { label: 'Nouvelle position de ' + p.nom, onFinish: function (pts) {
            avecDoublon(function (forcer) { return api('PUT', '/sites/' + p.id, { geometry: geometrie(mode, pts), forcer: forcer }); })
              .then(function () { return charger().then(function () { ouvrirSite(p.id); }); }).catch(fail);
          } });
        });
        btn(bar, 'Supprimer', 'danger', function () {
          if (confirm('Supprimer ' + p.nom + ' (' + p.numero + ') ?')) api('DELETE', '/sites/' + p.id).then(function () { fermerFiche(); charger(); }).catch(fail);
        });
      }
      if (A.itineraire) btn(bar, 'Itinéraire jusqu\'ici', '', function () {
        A.itineraire.ajouter(L.latLng(p.centre.coordinates[1], p.centre.coordinates[0]), p.nom, 'end');
      });
      d.appendChild(bar);
      // emplacements
      var h = document.createElement('div');
      var stats = {}; f.places.forEach(function (x) { stats[x.statut] = (stats[x.statut] || 0) + 1; });
      h.innerHTML = '<h4>Emplacements (' + f.places.length + ')</h4>' + (f.places.length ? '<p class="hint">' + LISTES.statuts_place.map(function (s) {
        return (stats[s] || 0) + ' ' + s.toLowerCase(); }).join(' · ') + '</p><div class="filters"><select id="mar-pl-statut"></select><select id="mar-pl-type"></select></div>' : '') +
        '<ul class="suivi-liste fon-liste" id="mar-places"></ul>';
      d.appendChild(h);
      montrerFiche(d);
      $('mar-fiche').dataset.vue = 'site';
      if (f.places.length) {
        remplir($('mar-pl-statut'), LISTES.statuts_place.concat([['impaye', 'Loyer impayé']]), 'Tous les statuts');
        remplir($('mar-pl-type'), LISTES.types_place.filter(function (t) { return f.places.some(function (x) { return x.type === t; }); }), 'Tous les types');
        $('mar-pl-statut').onchange = $('mar-pl-type').onchange = function () { listePlaces(f); };
      }
      listePlaces(f);
      surligner(f.geometry);
    }).catch(fail);
  }
  function listePlaces(f) {
    var st = $('mar-pl-statut') ? $('mar-pl-statut').value : '', ty = $('mar-pl-type') ? $('mar-pl-type').value : '';
    var dus = {}; (f.impayes || []).forEach(function (x) { dus[x.id] = x; });
    var ul = $('mar-places'); ul.innerHTML = '';
    var list = f.places.filter(function (x) { return (!st || (st === 'impaye' ? dus[x.id] : x.statut === st)) && (!ty || x.type === ty); });
    if (!f.places.length) ul.innerHTML = '<li class="empty"><small>Aucun emplacement' + (f.peut_gerer ? ' : « Ajouter des emplacements » (boutiques, étals, places…)' : '') + '.</small></li>';
    list.forEach(function (x) {
      var li = document.createElement('li'), du = dus[x.id];
      li.className = 'fon-li' + (du ? ' retard' : '');
      li.style.borderLeftColor = x.statut === 'Occupée' ? C.OCCUPEE : x.statut === 'Libre' ? C.LIBRE : C.GRIS;
      li.innerHTML = '<b>' + esc(x.numero) + '</b> · ' + esc(x.type) + (x.occupant ? ' · ' + esc(x.occupant) : '') + '<small>' + badge(x.statut) +
        (x.activite ? ' · ' + esc(x.activite) : '') + (x.loyer_gnf ? ' · ' + gnf(x.loyer_gnf) + '/mois' : '') + (x.surface_m2 ? ' · ' + A.fmt(x.surface_m2, 1) + ' m²' : '') +
        (du ? ' · <b class="retard-txt">' + du.nb_mois + ' mois impayé(s)</b>' : x.dernier_mois_paye ? ' · payé jusqu\'à ' + moisFr(x.dernier_mois_paye) : '') + '</small>';
      if (f.peut_gerer) li.onclick = function () { ouvrirPlace(x.id); };
      ul.appendChild(li);
    });
  }
  function ajouterPlaces(p) {
    var gare = p.type === 'Gare routière';
    formulaire('Ajouter des emplacements — ' + p.nom, [{ n: 'type', l: 'Type', t: 'select', o: LISTES.types_place, req: true },
      { n: 'nombre', l: 'Nombre d\'emplacements identiques', t: 'number', min: 1, max: 300, req: true,
        aide: 'Ils sont numérotés à la suite (' + p.numero + '-001, -002…). Indiquez ensuite l\'occupant de chacun.' },
      { n: 'surface_m2', l: 'Surface de chacun (m²)', t: 'number', min: 0, step: 0.5 }, { n: 'loyer_gnf', l: 'Loyer mensuel (GNF)', t: 'number', min: 0, step: 500 },
      { n: 'observations', l: 'Observations', t: 'textarea' }],
    { type: gare ? 'Bureau de ligne' : 'Boutique', nombre: 1 }, function (v) {
      v.nombre = Math.max(1, Math.round(v.nombre || 1));
      return api('POST', '/sites/' + p.id + '/places', v).then(function (r) {
        LabeTerrain.toast(r.numeros.length + ' emplacement(s) créé(s)' + (r.numeros.length ? ' : ' + r.numeros[0] + (r.numeros.length > 1 ? ' à ' + r.numeros[r.numeros.length - 1] : '') : '') + '.');
        return charger().then(function () { ouvrirSite(p.id); });
      });
    });
  }

  // ---------- Emplacement ----------
  function champsPlace() {
    return [{ n: 'type', l: 'Type', t: 'select', o: LISTES.types_place, req: true }, { n: 'statut', l: 'Statut', t: 'select', o: LISTES.statuts_place, req: true,
      aide: '« Libre » ou « Hors service » efface l\'occupant.' },
      { n: 'occupant', l: 'Occupant', ph: 'nom et prénom' }, { n: 'telephone', l: 'Téléphone', t: 'tel' }, { n: 'activite', l: 'Activité', ph: 'ex. tissus, condiments, ligne Labé – Conakry' },
      { n: 'depuis', l: 'Occupé depuis', t: 'date', aide: 'Les loyers sont dus à partir de ce mois (vide : aujourd\'hui).' },
      { n: 'surface_m2', l: 'Surface (m²)', t: 'number', min: 0, step: 0.5 }, { n: 'loyer_gnf', l: 'Loyer mensuel (GNF)', t: 'number', min: 0, step: 500 },
      { n: 'observations', l: 'Observations', t: 'textarea' }];
  }
  function ouvrirPlace(id) {
    api('GET', '/places/' + id).then(function (f) {
      var p = f.properties, d = document.createElement('div'), du = f.impayes[0];
      siteOuvert = p.site;
      d.innerHTML = '<h3>Emplacement ' + esc(p.numero) + '</h3><p>' + esc(p.type) + ' · ' + esc(p.site_nom) + ' ' + badge(p.statut) +
        (du ? ' <b class="retard-txt">' + du.nb_mois + ' mois impayé(s) : ' + gnf(du.du) + '</b>' : '') + '</p>' +
        table([['Occupant', p.occupant], ['Téléphone', p.telephone], ['Activité', p.activite], ['Occupé depuis', dateFr(p.depuis)],
          ['Loyer mensuel', p.loyer_gnf ? gnf(p.loyer_gnf) : null], ['Surface', p.surface_m2 ? A.fmt(p.surface_m2, 1) + ' m²' : null],
          ['Mois impayés', du ? du.mois.map(moisFr).join(', ') : null], ['Observations', p.observations]]);
      var bar = document.createElement('div'); bar.className = 'row';
      if (p.statut === 'Occupée') btn(bar, 'Encaisser le loyer', 'primary', function () { encaisserLoyer(p, du); });
      btn(bar, p.statut === 'Occupée' ? 'Modifier' : 'Attribuer ou modifier', p.statut === 'Occupée' ? '' : 'primary', function () {
        formulaire('Emplacement ' + p.numero, champsPlace(), Object.assign({}, p, p.statut === 'Libre' ? { statut: 'Occupée' } : {}), function (v) {
          return api('PUT', '/places/' + p.id, v).then(function () { return charger().then(function () { ouvrirPlace(p.id); }); });
        });
      });
      if (p.statut === 'Occupée') btn(bar, 'Libérer', '', function () {
        if (confirm('Libérer l\'emplacement ' + p.numero + ' (' + p.occupant + ') ?')) api('PUT', '/places/' + p.id, { statut: 'Libre' })
          .then(function () { return charger().then(function () { ouvrirPlace(p.id); }); }).catch(fail);
      });
      btn(bar, p.placee ? 'Déplacer sur la carte' : 'Placer sur la carte', '', function () {
        A.startSketch('point', { label: 'Position de l\'emplacement ' + p.numero, onFinish: function (pts) {
          api('PUT', '/places/' + p.id, { geometry: geometrie('point', pts) }).then(function () {
            if (!map.hasLayer(cPlaces)) cPlaces.addTo(map);
            return charger().then(function () { return api('GET', '/sites/' + p.site); }).then(function (s) { placesCarte = {}; placesCarte[p.site] = s.places; dessinerPlaces(); ouvrirPlace(p.id); });
          }).catch(fail);
        } });
      });
      btn(bar, 'Supprimer', 'danger', function () {
        if (confirm('Supprimer l\'emplacement ' + p.numero + ' ?')) api('DELETE', '/places/' + p.id).then(function () { return charger().then(function () { ouvrirSite(p.site); }); }).catch(fail);
      });
      d.appendChild(bar);
      var h = document.createElement('div');
      h.innerHTML = '<h4>Quittances</h4>' + (f.perceptions.length ? '<ul class="fon-ctl">' + f.perceptions.map(function (x) {
        return '<li data-q="' + x.id + '"' + (x.statut === 'Annulée' ? ' class="annulee"' : '') + '><b>' + esc(x.numero) + '</b> ' + esc(x.nature) +
          (x.mois ? ' de ' + moisFr(x.mois) : '') + ' · ' + gnf(x.montant_gnf) + ' · ' + dateFr(x.date_perception) +
          (x.statut === 'Annulée' ? ' ' + badge('Annulée') : '') + '</li>';
      }).join('') + '</ul>' : '<p class="hint">Aucune quittance.</p>');
      d.appendChild(h);
      h.querySelectorAll('[data-q]').forEach(function (li) { li.onclick = function () { ouvrirQuittance(+li.dataset.q); }; });
      montrerFiche(d);
      $('mar-fiche').dataset.vue = 'place';
      surligner(f.geometry);
    }).catch(fail);
  }

  // ---------- Encaissements ----------
  function moisCourant() { return aujourdhui().slice(0, 7); }
  function encaisserLoyer(p, du) {
    var premier = du && du.mois.length ? du.mois[0] : moisCourant();
    formulaire('Loyer — ' + p.numero + (p.occupant ? ' (' + p.occupant + ')' : ''), [
      { n: 'mois', l: 'Mois payé', t: 'month', req: true, aide: du ? 'Mois impayés : ' + du.mois.map(moisFr).join(', ') + '.' : null },
      { n: 'montant_gnf', l: 'Montant (GNF)', t: 'number', min: 1, step: 'any', req: true }, { n: 'mode', l: 'Mode de paiement', t: 'select', o: LISTES.modes },
      { n: 'payeur', l: 'Payé par' }, { n: 'observation', l: 'Observation', t: 'textarea' }],
    { mois: premier, montant_gnf: p.loyer_gnf, mode: 'Espèces', payeur: p.occupant }, function (v) {
      v.place = p.id; v.nature = 'Loyer mensuel'; v.uid = LabeTerrain.uuid();
      return envoyer('POST', '/perceptions', v).then(function (r) {
        if (enAttente(r)) return;
        return charger().then(function () { ouvrirQuittance(r.id, true); });
      });
    });
  }
  function encaisserDroits(site) {
    var choix = !site, gare = site && site.type === 'Gare routière';
    var champs = [];
    if (choix) champs.push({ n: 'site', l: 'Site', t: 'select', req: true, o: sites.map(function (f) { return [f.properties.id, f.properties.nom + ' (' + f.properties.numero + ')']; }) });
    champs.push({ n: 'nature', l: 'Nature', t: 'select', req: true, o: LISTES.natures.filter(function (n) { return n !== 'Loyer mensuel'; }),
      aide: 'Pour un loyer, ouvrez l\'emplacement (fiche du site ou liste des impayés).' },
    { n: 'nombre', l: gare ? 'Nombre de véhicules' : 'Nombre de tickets', t: 'number', min: 1 },
    { n: 'montant_gnf', l: 'Montant total (GNF)', t: 'number', min: 1, step: 'any',
      aide: site && site.tarif_ticket_gnf ? 'Vide : nombre × ' + gnf(site.tarif_ticket_gnf) + '.' : 'Vide : nombre × tarif du site, s\'il est indiqué.' },
    { n: 'mode', l: 'Mode de paiement', t: 'select', o: LISTES.modes }, { n: 'date_perception', l: 'Date de la perception', t: 'date', max: aujourdhui() },
    { n: 'payeur', l: 'Payé par', ph: gare ? 'transporteur, syndicat…' : 'collecte du jour' }, { n: 'observation', l: 'Observation', t: 'textarea' });
    formulaire(site ? (gare ? 'Droits de stationnement — ' : 'Tickets — ') + site.nom : 'Encaisser une recette', champs,
      { nature: gare ? 'Droits de stationnement' : 'Tickets journaliers', mode: 'Espèces', date_perception: aujourdhui(), site: site && site.id }, function (v) {
        v.site = choix ? +v.site : site.id; v.uid = LabeTerrain.uuid();
        if (v.nombre != null) v.nombre = Math.round(v.nombre);
        return envoyer('POST', '/perceptions', v).then(function (r) {
          if (enAttente(r)) return;
          return charger().then(function () { ouvrirQuittance(r.id, true); });
        });
      });
  }
  $('mar-r-encaisser').onclick = function () { encaisserDroits(null); };

  function ouvrirQuittance(id, nouvelle) {
    api('GET', '/perceptions/' + id).then(function (q) {
      var d = document.createElement('div');
      d.innerHTML = '<h3>Quittance ' + esc(q.numero) + '</h3><p>' + badge(q.statut) + (nouvelle ? ' <b>Recette enregistrée.</b>' : '') + '</p>' +
        table([['Site', q.site_nom + ' (' + q.site_numero + ')'], ['Emplacement', q.place_numero], ['Nature', q.nature], ['Mois payé', moisFr(q.mois)],
          ['Nombre', q.nombre], ['Montant', gnf(q.montant_gnf)], ['Mode', q.mode], ['Payé par', q.payeur], ['Date', dateFr(q.date_perception)],
          ['Encaissé par', q.collecteur], ['Observation', q.observation],
          ['Annulée le', q.annulee_le ? dateFr(q.annulee_le) + (q.annulee_par_nom ? ' par ' + q.annulee_par_nom : '') : null], ['Motif', q.motif_annulation]]);
      var bar = document.createElement('div'); bar.className = 'row';
      if (q.statut === 'Valide') btn(bar, '🖨 Imprimer la quittance', 'primary', function () { imprimer(q); });
      if (q.place) btn(bar, 'Emplacement ' + q.place_numero, '', function () { ouvrirPlace(q.place); });
      btn(bar, 'Site', '', function () { ouvrirSite(q.site); });
      if (q.statut === 'Valide' && LISTES.peut_annuler) btn(bar, 'Annuler la quittance', 'danger', function () {
        formulaire('Annuler la quittance ' + q.numero, [{ n: 'motif', l: 'Motif', t: 'textarea', req: true, ph: 'erreur de saisie, double encaissement…' }], {}, function (v) {
          return api('POST', '/perceptions/' + q.id + '/annuler', v).then(function () { return charger().then(function () { ouvrirQuittance(q.id); }); });
        });
      });
      d.appendChild(bar);
      montrerFiche(d);
      $('mar-fiche').dataset.vue = 'quittance';
    }).catch(fail);
  }
  // quittance A5 imprimable (ou enregistrée en PDF depuis la fenêtre d'impression)
  function quittanceHtml(q) {
    var lignes = [['Site', q.site_nom], ['Emplacement', q.place_numero], ['Nature', q.nature], ['Mois payé', moisFr(q.mois)], ['Nombre', q.nombre],
      ['Mode de paiement', q.mode], ['Payé par', q.payeur], ['Date', dateFr(q.date_perception)], ['Encaissé par', q.collecteur]]
      .filter(function (r) { return r[1] != null && r[1] !== ''; });
    return '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Quittance ' + esc(q.numero) + '</title><style>' +
      '@page{size:A5;margin:12mm}body{font-family:Arial,sans-serif;color:#212529}h1{font-size:18px;margin:0}h2{font-size:15px;margin:14px 0 4px}' +
      '.ent{border-bottom:3px solid #c8102e;padding-bottom:6px}.ent small{display:block;color:#555}table{width:100%;border-collapse:collapse;margin-top:8px}' +
      'td{padding:5px 4px;border-bottom:1px solid #dee2e6;font-size:13px}td:first-child{color:#555;width:40%}.mt{font-size:22px;font-weight:700;margin:12px 0}' +
      '.sig{margin-top:28px;display:flex;justify-content:space-between;font-size:12px}</style></head><body>' +
      '<div class="ent"><small>République de Guinée — Travail · Justice · Solidarité</small><h1>Commune urbaine de Labé</h1><small>Marchés et gares routières — droits de place</small></div>' +
      '<h2>Quittance n° ' + esc(q.numero) + '</h2><div class="mt">' + esc(gnf(q.montant_gnf)) + '</div><table>' +
      lignes.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>' +
      '<div class="sig"><span>Le payeur</span><span>Le collecteur</span></div></body></html>';
  }
  function imprimer(q) {
    var w = window.open('', '_blank');
    if (!w) { alert('Autorisez les fenêtres pour imprimer la quittance.'); return; }
    w.document.write(quittanceHtml(q)); w.document.close();
    w.focus(); setTimeout(function () { w.print(); }, 300);
  }

  // ---------- Recettes ----------
  function chargerRecettes() {
    if (!gerer()) return;
    var q = '?du=' + $('mar-r-du').value + '&au=' + $('mar-r-au').value + ($('mar-r-site').value ? '&site=' + $('mar-r-site').value : '');
    api('GET', '/perceptions' + q).then(function (l) { recettes = l; rendreRecettes(); }).catch(fail);
  }
  function rendreRecettes() {
    var valides = recettes.filter(function (x) { return x.statut === 'Valide'; });
    var total = valides.reduce(function (s, x) { return s + x.montant_gnf; }, 0), auj = aujourdhui();
    var jour = valides.filter(function (x) { return x.date_perception === auj; }).reduce(function (s, x) { return s + x.montant_gnf; }, 0);
    var miens = valides.filter(function (x) { return x.cree_par === Auth.user().id && x.date_perception === auj; }).reduce(function (s, x) { return s + x.montant_gnf; }, 0);
    $('mar-r-cartes').innerHTML = carte(gnf(total), 'encaissés sur la période') + carte(gnf(jour), 'aujourd\'hui') + carte(gnf(miens), 'encaissés par moi aujourd\'hui') +
      carte(recettes.length - valides.length, 'quittance(s) annulée(s)', recettes.length - valides.length ? 'alerte' : '');
    var ul = $('mar-recettes');
    ul.innerHTML = recettes.length ? '' : '<li class="empty"><small>Aucune recette sur la période.</small></li>';
    recettes.slice(0, 400).forEach(function (x) {
      var li = document.createElement('li');
      li.className = 'fon-li' + (x.statut === 'Annulée' ? ' annulee' : '');
      li.innerHTML = '<b>' + esc(x.numero) + '</b> · ' + gnf(x.montant_gnf) + '<small>' + dateFr(x.date_perception) + ' · ' + esc(x.nature) +
        (x.mois ? ' ' + moisFr(x.mois) : '') + (x.nombre ? ' · ' + x.nombre : '') + ' · ' + esc(x.site_nom) + (x.place_numero ? ' · ' + esc(x.place_numero) : '') +
        ' · ' + esc(x.collecteur || '') + (x.statut === 'Annulée' ? ' ' + badge('Annulée') : '') + '</small>';
      li.onclick = function () { ouvrirQuittance(x.id); };
      ul.appendChild(li);
    });
  }
  $('mar-r-site').onchange = $('mar-r-du').onchange = $('mar-r-au').onchange = chargerRecettes;
  $('mar-r-export').onclick = function () {
    telecharger('/export/perceptions.csv?du=' + $('mar-r-du').value + '&au=' + $('mar-r-au').value, 'recettes_marches_labe.csv');
  };

  // ---------- Impayés ----------
  function rendreImpayes() {
    var sid = $('mar-i-site').value, ul = $('mar-impayes');
    var list = impayes.filter(function (x) { return !sid || String(x.site) === sid; });
    var total = list.reduce(function (s, x) { return s + x.du; }, 0);
    $('mar-i-total').innerHTML = list.length ? '<b>' + list.length + '</b> emplacement(s) en retard · <b>' + gnf(total) + '</b> dus' : '';
    ul.innerHTML = list.length ? '' : '<li class="empty"><small>Aucun loyer impayé' + (gerer() ? '' : ' visible') + '.</small></li>';
    list.forEach(function (x) {
      var li = document.createElement('li');
      li.className = 'fon-li retard';
      li.innerHTML = '<b>' + esc(x.numero) + '</b> · ' + esc(x.occupant || '—') + ' · ' + gnf(x.du) + '<small>' + esc(x.site_nom) + ' · ' + esc(x.type) +
        (x.activite ? ' · ' + esc(x.activite) : '') + (x.telephone ? ' · ' + esc(x.telephone) : '') + ' · ' + x.nb_mois + ' mois : ' + x.mois.map(moisFr).join(', ') + '</small>';
      var bar = document.createElement('div'); bar.className = 'row';
      btn(bar, 'Encaisser', 'primary', function (e) { e.stopPropagation(); encaisserLoyer({ id: x.id, numero: x.numero, occupant: x.occupant, loyer_gnf: x.loyer_gnf }, x); });
      li.appendChild(bar);
      li.onclick = function () { ouvrirPlace(x.id); };
      ul.appendChild(li);
    });
  }
  $('mar-i-site').onchange = rendreImpayes;
  $('mar-i-export').onclick = function () { telecharger('/export/impayes.csv', 'impayes_marches_labe.csv'); };

  // ---------- Bilan ----------
  function barres(items, val, lib, fmt) {
    var max = Math.max.apply(null, items.map(val).concat([1]));
    return '<div class="fon-barres">' + items.map(function (it) {
      var v = val(it), txt = fmt ? fmt(it) : A.fmt(v);
      return '<div class="fon-barre" title="' + esc(lib(it)) + ' : ' + esc(txt) + '"><span>' + esc(lib(it)) + '</span>' +
        '<i><b style="width:' + (100 * v / max).toFixed(1) + '%"></b></i><em>' + esc(txt) + '</em></div>';
    }).join('') + '</div>';
  }
  // recettes par mois : colonnes en millions de GNF, valeur exacte au survol
  function colonnes(mois, titre) {
    var W = 300, H = 90, pad = 18, n = mois.length, max = Math.max.apply(null, mois.map(function (m) { return m.n; }).concat([1])), bw = (W - 2) / n;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + (H + pad) + '" class="fon-col" role="img" aria-label="' + esc(titre) + '"><line x1="0" y1="' + H + '" x2="' + W + '" y2="' + H + '" class="axe"/>';
    mois.forEach(function (m, i) {
      var h = (H - 14) * m.n / max, x = 1 + i * bw, hh = Math.max(h, m.n ? 2 : 0);
      var lib = new Date(m.mois + '-15').toLocaleDateString('fr-FR', { month: 'short' }), v = m.n ? A.fmt(m.n / 1e6, m.n < 1e7 ? 1 : 0) : '';
      svg += '<g><title>' + esc(lib + ' : ' + gnf(m.n)) + '</title><rect x="' + (x + 3) + '" y="' + (H - hh) + '" width="' + (bw - 6) + '" height="' + hh + '" rx="2"/>' +
        '<rect x="' + x + '" y="0" width="' + bw + '" height="' + H + '" class="cible"/>' + (v ? '<text x="' + (x + bw / 2) + '" y="' + (H - h - 3) + '" class="v">' + v + '</text>' : '') +
        '<text x="' + (x + bw / 2) + '" y="' + (H + 12) + '" class="m">' + esc(lib) + '</text></g>';
    });
    return svg + '</svg>';
  }
  function chargerBilan() {
    var div = $('mar-bilan');
    api('GET', '/bilan').then(function (b) {
      var pl = 0, occ = 0, att = 0;
      b.sites.forEach(function (s) { pl += s.places; occ += s.occupees; att += s.loyers_attendus || 0; });
      var html = '<div class="stat-cards">' + carte(b.sites.filter(function (s) { return s.type !== 'Gare routière'; }).length, 'marchés') +
        carte(b.sites.filter(function (s) { return s.type === 'Gare routière'; }).length, 'gares routières') + carte(A.fmt(pl), 'emplacements') + carte(pct(occ, pl), 'occupés');
      if (b.peut_gerer) {
        var mc = b.mois[b.mois.length - 1].n, an = b.mois.reduce(function (s, m) { return s + m.n; }, 0);
        html += carte(gnf(mc), 'encaissés ce mois') + carte(gnf(an), 'encaissés en 12 mois') +
          carte(pct(b.loyers_mois.payes, b.loyers_mois.attendus), 'des loyers du mois encaissés') +
          carte(gnf(b.impayes.montant), 'loyers impayés (' + b.impayes.places + ' emplacement(s))', b.impayes.montant ? 'alerte' : '') +
          carte(b.annulees_30j.n, 'quittance(s) annulée(s) en 30 jours', b.annulees_30j.n ? 'alerte' : '');
      }
      html += '</div>';
      if (b.peut_gerer) {
        html += '<p class="hint">Recettes encaissées par mois (millions de GNF, 12 derniers mois) :</p>' + colonnes(b.mois, 'Recettes des marchés et gares par mois');
        var rec = b.sites.filter(function (s) { return s.recettes_annee > 0; }).sort(function (a, c) { return c.recettes_annee - a.recettes_annee; });
        if (rec.length) html += '<h4>Recettes des 12 derniers mois par site</h4>' + barres(rec, function (s) { return s.recettes_annee; }, function (s) { return s.nom; },
          function (s) { return gnf(s.recettes_annee) + (s.impayes ? ' · ' + gnf(s.impayes) + ' impayés' : ''); });
        if (b.natures.length) html += '<h4>Recettes par nature (12 mois)</h4>' + barres(b.natures, function (x) { return x.montant; }, function (x) { return x.nature; },
          function (x) { return gnf(x.montant) + ' · ' + x.n + ' quittance(s)'; });
        if (b.collecteurs.length) html += '<h4>Encaissements du mois par agent</h4>' + barres(b.collecteurs, function (x) { return x.montant; }, function (x) { return x.collecteur; },
          function (x) { return gnf(x.montant) + ' · ' + x.n + ' quittance(s)'; });
        var gares = b.sites.filter(function (s) { return s.type === 'Gare routière' && s.vehicules_30j; });
        if (gares.length) html += '<h4>Véhicules en stationnement payé (30 jours)</h4>' + barres(gares, function (s) { return s.vehicules_30j; }, function (s) { return s.nom; });
      }
      var occs = b.sites.filter(function (s) { return s.places; });
      if (occs.length) html += '<h4>Occupation des emplacements par site</h4>' + barres(occs, function (s) { return s.occupees / s.places * 100; }, function (s) { return s.nom; },
        function (s) { return pct(s.occupees, s.places) + ' · ' + s.occupees + '/' + s.places + (s.hors_service ? ' · ' + s.hors_service + ' hors service' : ''); });
      if (b.types_place.length) html += '<h4>Emplacements par type</h4>' + barres(b.types_place, function (x) { return x.n; }, function (x) { return x.type; });
      html += '<div class="row"><button type="button" id="mar-b-sites">Sites (CSV, Excel)</button>' + (b.peut_gerer ? '<button type="button" id="mar-b-places">Emplacements et occupants (CSV, Excel)</button>' : '') + '</div>';
      div.innerHTML = html;
      $('mar-b-sites').onclick = function () { telecharger('/export/sites.csv', 'marches_gares_labe.csv'); };
      if ($('mar-b-places')) $('mar-b-places').onclick = function () { telecharger('/export/places.csv', 'emplacements_marches_labe.csv'); };
    }).catch(function (e) { div.innerHTML = '<p class="form-msg">' + esc(e.message) + '</p>'; });
    rendreParametres();
  }
  var LIB_PARAM = { jour_echeance: 'Jour d\'échéance du loyer (1 à 28)', mois_impayes_max: 'Mois examinés pour les impayés' };
  function rendreParametres() {
    var div = $('mar-parametres');
    div.innerHTML = '<table class="info-table">' + LISTES.parametres.map(function (x) {
      return '<tr><td title="' + esc(x.description) + '">' + esc(LIB_PARAM[x.cle] || x.cle) + '</td><td>' +
        (gerer() ? '<input type="number" min="1" step="1" data-k="' + esc(x.cle) + '" value="' + x.valeur + '" style="width:80px">' : A.fmt(x.valeur)) + '</td></tr>';
    }).join('') + '</table>' + (gerer() ? '<div class="row"><button type="button" id="mar-param-ok">Enregistrer les paramètres</button></div>' : '');
    if ($('mar-param-ok')) $('mar-param-ok').onclick = function () {
      Promise.all(Array.prototype.map.call(div.querySelectorAll('[data-k]'), function (inp) {
        return api('PUT', '/parametres/' + inp.dataset.k, { valeur: parseFloat(inp.value) || 0 });
      })).then(function () { return api('GET', '/listes'); }).then(function (l) { LISTES = l; LabeTerrain.toast('Paramètres enregistrés.'); chargerBilan(); charger(); }).catch(fail);
    };
  }

  // ---------- Tables attributaires ----------
  function tableSites() {
    return sites.map(function (f) { var x = parId[f.id]; return { layer: x && x.l, feature: { type: 'Feature', geometry: f.properties.centre, properties: infoSite(f.properties) } }; });
  }
  function tablePlaces() {
    var out = [];
    cPlaces.eachLayer(function (l) { out.push({ layer: l, feature: l.feature }); });
    return out;
  }

  // ---------- Démarrage ----------
  function start() {
    api('GET', '/listes').then(function (l) {
      LISTES = l;
      remplir($('mar-s-type'), l.types_site, 'Tous les types'); remplir($('mar-s-etat'), l.etats_site, 'Tous les états');
      document.querySelectorAll('.mar-gestion').forEach(function (el) { el.classList.toggle('hidden', !l.peut_gerer); });
      var d = new Date(); d.setDate(1);
      $('mar-r-du').value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); $('mar-r-au').value = aujourdhui();
      A.ready.then(function () {
        A.enregistrerIdentifiable(cSites, 'Marchés et gares routières');
        A.enregistrerIdentifiable(cPlaces, 'Emplacements des marchés');
        A.addOverlay({ name: 'Marchés et gares routières', layer: cSites, on: true, group: 'Économie', table: tableSites,
          swatch: '<span class="swatch dot" style="background:' + C.MARCHE + '"></span>', legend: C.LEGENDE_SITES });
        A.addOverlay({ name: 'Emplacements (site ouvert)', layer: cPlaces, on: false, group: 'Économie', table: tablePlaces,
          swatch: '<span class="swatch dot" style="background:' + C.OCCUPEE + '"></span>', legend: C.LEGENDE_PLACES });
      });
      return charger();
    }).catch(fail);
  }
  var fileDiv = null;
  window.LabeMarches = {
    start: start, recharger: function () { if (LISTES) charger(); }, ouvrirSite: ouvrirSite, ouvrirPlace: ouvrirPlace, ouvrirQuittance: ouvrirQuittance,
    sousOnglet: sousOnglet, quittanceHtml: quittanceHtml,
    file: function (n) {   // encaissements et saisies en attente de réseau (file partagée avec les déchets)
      if (!fileDiv) { fileDiv = document.createElement('p'); fileDiv.className = 'fon-avert'; $('mar-liste-vue').insertBefore(fileDiv, $('mar-liste-vue').children[1]); }
      fileDiv.textContent = '📶 ' + n + ' saisie(s) en attente de réseau, envoyée(s) automatiquement.';
      fileDiv.classList.toggle('hidden', !n);
    }
  };
})();
