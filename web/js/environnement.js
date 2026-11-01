/* Protection de l'environnement (espace agents) :
 * - zones protégées : calculées (berges, pentes fortes, bas-fonds, boisements) ou dessinées (forêts classées…),
 *   bâtiments situés dedans ; elles alimentent les contrôles du foncier ;
 * - atteintes : signalement (point, surface, GPS), constat, mise en demeure, sanction, remise en état, clôture ;
 * - arbres et reboisement : plantations et suivis de survie ;
 * - sources et points d'eau : périmètres de protection, constats, menaces (bâtiments, dépôts d'ordures) ;
 * - feux de brousse : saisie et import des détections satellite (NASA FIRMS) ;
 * - bilan. Les saisies de terrain partent même sans réseau (file d'attente partagée avec les déchets). */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc, C = window.LabeEnvCarte;
  var OUVERTES = ['Signalée', 'Constatée', 'Mise en demeure', 'Sanctionnée'];

  function $(id) { return document.getElementById(id); }
  function api(m, p, b) { return Auth.api(m, '/environnement' + p, b); }
  function envoyer(m, p, b) { return LabeDechets.envoyer(m, '/environnement' + p, b); }
  function fail(e) { alert('Erreur : ' + e.message); }
  function gerer() { return !!(LISTES && LISTES.peut_gerer); }
  function dateFr(d) { return d ? new Date(d).toLocaleDateString('fr-FR') : ''; }
  function heureFr(d) { return d ? new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''; }
  function aujourdhui() { var x = new Date(); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
  function cls(s) { return 'e-' + String(s).replace(/[\s'/]/g, '-'); }
  function ha(v) { return v != null ? A.fmt(v, v < 10 ? 2 : 1) + ' ha' : null; }
  function btn(parent, texte, classe, fn) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = texte;
    if (classe) b.className = classe; b.onclick = fn; parent.appendChild(b); return b;
  }
  function table(rows) {
    return '<table class="info-table">' + rows.filter(function (r) { return r[1] !== null && r[1] !== undefined && r[1] !== ''; })
      .map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + (r[2] ? r[1] : esc(r[1])) + '</td></tr>'; }).join('') + '</table>';
  }
  function carte(v, lib, extra) { return '<div class="stat-card' + (extra ? ' ' + extra : '') + '"><b>' + v + '</b><span>' + lib + '</span></div>'; }
  function remplir(sel, valeurs, vide) {
    var cur = sel.value;
    sel.innerHTML = vide != null ? '<option value="">' + esc(vide) + '</option>' : '';
    valeurs.forEach(function (v) { sel.add(new Option(v, v, false, v === cur)); });
  }
  function telecharger(chemin, nom) {
    Auth.blobUrl('/api/environnement' + chemin).then(function (u) { var a = document.createElement('a'); a.href = u; a.download = nom; a.click(); })
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
    if (mode === 'line') return { type: 'LineString', coordinates: c };
    return { type: 'Polygon', coordinates: [c.concat([c[0]])] };
  }
  function photoLien(url) { return url ? ' <a href="#" data-photo="' + esc(url) + '">📷 photo</a>' : ''; }
  function activerPhotos(el) {
    el.querySelectorAll('[data-photo]').forEach(function (a) {
      a.onclick = function (e) { e.preventDefault(); Auth.blobUrl(a.dataset.photo).then(function (u) { window.open(u, '_blank'); }); };
    });
  }
  function photoFiche(el, url) {
    if (!url) return;
    var d = document.createElement('div'); d.className = 'dech-photo'; d.textContent = 'Chargement de la photo…'; el.appendChild(d);
    Auth.blobUrl(url).then(function (u) { d.innerHTML = '<a href="' + u + '" target="_blank"><img src="' + u + '" alt="Photo"></a>'; })
      .catch(function () { d.textContent = ''; });
  }

  // ---------- Formulaire générique ----------
  // champs : { n, l, t: text|textarea|number|date|select|check|photo, o: options, req, ph, min, max, step, aide }
  var MF = { form: $('env-form'), modal: $('env-modal'), champs: [], photos: {}, envoi: null };
  function formulaire(titre, champs, valeurs, envoi, alertesHtml) {
    valeurs = valeurs || {};
    MF.champs = champs; MF.photos = {}; MF.envoi = envoi;
    $('env-mf-titre').textContent = titre;
    $('env-mf-msg').textContent = '';
    $('env-mf-alertes').innerHTML = alertesHtml || '';
    var div = $('env-mf-champs'); div.innerHTML = '';
    champs.forEach(function (c) {
      var lab = document.createElement('label'), v = valeurs[c.n], el;
      if (c.t === 'check') {
        lab.className = 'check';
        lab.innerHTML = '<input type="checkbox" name="' + c.n + '"' + (v ? ' checked' : '') + '> ' + esc(c.l);
        div.appendChild(lab); return;
      }
      lab.textContent = c.l + (c.req ? ' *' : '');
      if (c.t === 'select') {
        el = document.createElement('select');
        (c.o || []).forEach(function (o) { el.add(new Option(o, o, false, o === v)); });
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
  $('env-mf-annuler').onclick = function () { MF.modal.classList.add('hidden'); apercu.clearLayers(); };
  MF.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var el = MF.form.elements, v = {};
    MF.champs.forEach(function (c) {
      if (c.t === 'photo') { if (MF.photos[c.n]) v[c.n] = MF.photos[c.n]; return; }
      var x = el[c.n];
      if (c.t === 'check') v[c.n] = x.checked;
      else if (c.t === 'number') v[c.n] = x.value === '' ? null : parseFloat(String(x.value).replace(',', '.'));
      else v[c.n] = x.value.trim() === '' ? null : x.value.trim();
    });
    var bouton = MF.form.querySelector('[type=submit]'); bouton.disabled = true;
    Promise.resolve().then(function () { return MF.envoi(v); }).then(function () {
      MF.modal.classList.add('hidden'); apercu.clearLayers();
    }).catch(function (err) { $('env-mf-msg').textContent = err.message; }).then(function () { bouton.disabled = false; });
  });
  function apresEnvoi(r, ouvrir) {
    if (r && r.enAttente) { LabeTerrain.toast('Pas de réseau : la saisie est gardée dans le téléphone et sera envoyée automatiquement.'); return; }
    return charger().then(function () { if (ouvrir && r) ouvrir(r.id); });
  }

  // ---------- Données et couches ----------
  var LISTES = null, zones = [], atteintes = [], plantations = [], eaux = [], feux = [], signalements = [];
  var parId = { zone: {}, att: {}, pl: {}, eau: {}, feu: {} };
  var cZones = A.markClicks(L.featureGroup()), cAtt = A.markClicks(L.featureGroup()), cPl = A.markClicks(L.featureGroup());
  var cEau = A.markClicks(L.featureGroup()), cFeu = A.markClicks(L.featureGroup());
  var surbrillance = L.featureGroup().addTo(map), apercu = L.featureGroup().addTo(map);
  var rendu = L.canvas({ padding: 0.3 }), batiZones = L.layerGroup(), batiZone = L.layerGroup().addTo(map);
  var recherches = [], ficheCourante = null;

  function popupAvec(titre, rows, ouvrir) {
    var d = document.createElement('div');
    d.className = 'popup';
    d.innerHTML = '<h4>' + esc(titre) + '</h4><table>' + rows.filter(function (r) { return r[1]; })
      .map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>';
    var bar = document.createElement('div'); bar.className = 'row';
    btn(bar, 'Ouvrir la fiche', 'primary', function () { map.closePopup(); ouvrir(); });
    d.appendChild(bar);
    return d;
  }
  function chercher(name, type, layer, parent) {
    var it = { name: name, type: type, layer: layer, parent: parent };
    A.searchIndex.push(it); recherches.push(it);
  }
  function ajouter(groupe, cle, f, opts, info, popup, recherche) {
    var p = f.properties;
    var l = L.geoJSON(f, { style: opts.style, pointToLayer: opts.point }).getLayers()[0];
    l.feature = { type: 'Feature', geometry: f.geometry, properties: info(p) };
    l.bindPopup(function () { return popup(p); }, { maxWidth: 300 });
    groupe.addLayer(l);
    parId[cle][p.id] = { f: f, l: l };
    if (recherche) chercher(recherche, info(p).libelle, l.getLatLng ? l : L.featureGroup([l]), groupe);
  }
  function dessiner() {
    [cZones, cAtt, cPl, cEau, cFeu].forEach(function (g) { g.clearLayers(); });
    parId = { zone: {}, att: {}, pl: {}, eau: {}, feu: {} };
    recherches.forEach(function (it) { var i = A.searchIndex.indexOf(it); if (i >= 0) A.searchIndex.splice(i, 1); });
    recherches = [];
    zones.forEach(function (f) {
      ajouter(cZones, 'zone', f, { style: function () { return C.styleZone(f.properties); } }, function (p) {
        return { libelle: 'Zone protégée ' + p.code, 'Nom': p.nom, 'Type': p.type, 'Règle': p.regle, 'Superficie': ha(p.superficie_ha),
          'Bâtiments': A.fmt(p.batiments), 'Active': p.active ? 'oui' : 'non' };
      }, function (p) {
        return popupAvec('Zone ' + p.code + ' — ' + p.nom, [['Type', p.type], ['Règle', p.regle], ['Superficie', ha(p.superficie_ha)],
          ['Bâtiments', A.fmt(p.batiments)]], function () { ouvrirZone(p.id); });
      }, f.properties.nom + ' · ' + f.properties.code);
    });
    atteintes.forEach(function (f) {
      var p = f.properties;
      ajouter(cAtt, 'att', f, { style: function () { return { color: C.ATTEINTE, weight: 2, dashArray: '4 3', fillColor: C.ATTEINTE, fillOpacity: 0.12 }; },
        point: function (g, ll) { return L.marker(ll, { icon: C.iconeAtteinte(p), keyboard: false }); } }, function (q) {
        return { libelle: 'Atteinte ' + q.numero, 'Type': q.type, 'Statut': q.statut, 'Gravité': q.gravite, 'Quartier': q.quartier,
          'Signalée le': dateFr(q.cree_le) };
      }, function (q) {
        return popupAvec(q.numero + ' — ' + q.type, [['Statut', q.statut], ['Gravité', q.gravite], ['Quartier', q.quartier],
          ['Zones', q.zones.join(', ')]], function () { ouvrirAtteinte(q.id); });
      }, p.numero + ' · ' + p.type);
    });
    plantations.forEach(function (f) {
      ajouter(cPl, 'pl', f, { style: function () { return C.STYLE_PLANTATION; }, point: function (g, ll) { return L.marker(ll, { icon: C.iconePlantation(), keyboard: false }); } },
        function (q) {
          return { libelle: 'Plantation ' + q.numero, 'Type': q.type, 'Espèces': q.espece, 'Plants': A.fmt(q.nombre_plants),
            'Survie': q.survie_pct != null ? q.survie_pct + ' %' : 'pas encore suivie', 'Campagne': q.campagne, 'Organisme': q.organisme };
        }, function (q) {
          return popupAvec('Plantation ' + q.numero, [['Type', q.type], ['Espèces', q.espece], ['Plants', A.fmt(q.nombre_plants)],
            ['Survie', q.survie_pct != null ? q.survie_pct + ' %' : null]], function () { ouvrirPlantation(q.id); });
        }, 'Plantation ' + f.properties.numero + (f.properties.espece ? ' · ' + f.properties.espece : ''));
    });
    eaux.forEach(function (f) {
      ajouter(cEau, 'eau', f, { point: function (g, ll) { return L.marker(ll, { icon: C.iconeEau(f.properties), keyboard: false }); } }, function (q) {
        return { libelle: (q.nom || q.type) + ' (' + q.numero + ')', 'Type': q.type, 'État': q.etat, 'Usage': q.usage, 'Quartier': q.quartier,
          'Bâtiments dans le périmètre': A.fmt(q.batiments), 'Dépôts d\'ordures dans le périmètre': A.fmt(q.depots) };
      }, function (q) {
        return popupAvec((q.nom || q.type) + ' (' + q.numero + ')', [['Type', q.type], ['État', q.etat],
          ['Menaces', q.batiments || q.depots ? q.batiments + ' bâtiment(s), ' + q.depots + ' dépôt(s) dans le périmètre' : null]], function () { ouvrirEau(q.id); });
      }, (f.properties.nom ? f.properties.nom + ' · ' : '') + f.properties.numero);
    });
    feux.forEach(function (f) {
      ajouter(cFeu, 'feu', f, { style: function () { return C.STYLE_FEU; }, point: function (g, ll) { return L.marker(ll, { icon: C.iconeFeu(), keyboard: false }); } },
        function (q) {
          return { libelle: 'Feu de brousse du ' + dateFr(q.date_feu), 'Saison': q.saison, 'Origine': q.origine, 'Cause': q.cause,
            'Surface brûlée': ha(q.surface_ha), 'Quartier': q.quartier };
        }, function (q) {
          return popupAvec('Feu du ' + dateFr(q.date_feu), [['Origine', q.origine], ['Cause', q.cause], ['Surface', ha(q.surface_ha)]],
            function () { ouvrirFeu(q.id); });
        }, null);
    });
  }

  function charger() {
    return Promise.all([api('GET', '/zones'), api('GET', '/atteintes'), api('GET', '/plantations'), api('GET', '/points-eau'), api('GET', '/feux'),
      gerer() ? api('GET', '/signalements') : Promise.resolve([])])
      .then(function (r) {
        zones = r[0].features; atteintes = r[1].features; plantations = r[2].features; eaux = r[3].features; feux = r[4].features; signalements = r[5];
        dessiner(); rendre();
      }).catch(fail);
  }

  function surligner(geometry) {
    surbrillance.clearLayers();
    if (!geometry) return;
    if (geometry.type === 'Point') {
      var ll = L.latLng(geometry.coordinates[1], geometry.coordinates[0]);
      L.circleMarker(ll, { radius: 18, color: '#f2c230', weight: 4, fill: false, interactive: false }).addTo(surbrillance);
      map.setView(ll, Math.max(map.getZoom(), 17));
      return;
    }
    var l = L.geoJSON(geometry, { style: { color: '#f2c230', weight: 5, fillOpacity: 0.05, interactive: false } }).addTo(surbrillance);
    if (l.getBounds().isValid()) map.fitBounds(l.getBounds(), { padding: [50, 50], maxZoom: 17 });
  }

  // ---------- Sous-onglets et fiches ----------
  var sousCourant = 'zon';
  function sousOnglet(k) {
    sousCourant = k;
    document.querySelectorAll('.env-switch button').forEach(function (b) { b.classList.toggle('active', b.dataset.env === k); });
    ['zon', 'att', 'arb', 'eau', 'feu', 'bil'].forEach(function (x) { $('env-' + x).classList.toggle('hidden', x !== k); });
    fermerFiche();
    if (k === 'bil') chargerBilan();
  }
  document.querySelectorAll('.env-switch button').forEach(function (b) { b.onclick = function () { sousOnglet(b.dataset.env); }; });
  function montrerFiche(el) {
    $('env-liste-vue').classList.add('hidden');
    $('env-fiche-vue').classList.remove('hidden');
    var f = $('env-fiche'); f.innerHTML = ''; f.appendChild(el);
    $('tab-env').scrollTop = 0;
  }
  function fermerFiche() {
    ficheCourante = null;
    $('env-fiche-vue').classList.add('hidden');
    $('env-liste-vue').classList.remove('hidden');
    surbrillance.clearLayers(); batiZone.clearLayers();
  }
  $('env-retour').onclick = fermerFiche;

  function rendre() {
    rendreZones(); rendreAtteintes(); rendrePlantations(); rendreEaux(); rendreFeux(); rendreSignalements();
    var aTraiter = atteintes.filter(function (f) { return f.properties.statut === 'Signalée' || f.properties.en_retard; }).length;
    $('env-att-badge').textContent = aTraiter; $('env-att-badge').classList.toggle('hidden', !aTraiter);
    var nb = gerer() ? aTraiter + signalements.length : 0;
    $('env-badge').textContent = nb; $('env-badge').classList.toggle('hidden', !nb);
  }

  // ---------- Zones ----------
  function rendreZones() {
    var actives = zones.filter(function (f) { return f.properties.active; });
    var surf = actives.reduce(function (s, f) { return s + (f.properties.superficie_ha || 0); }, 0);
    var integrale = actives.filter(function (f) { return f.properties.regle === 'Protection intégrale'; }).length;
    $('env-z-cartes').innerHTML = carte(actives.length, 'zones protégées actives') + carte(A.fmt(surf, 0) + ' ha', 'superficie (avec recouvrements)') +
      carte(integrale, 'en protection intégrale');
    $('env-z-calcul').classList.toggle('hidden', !gerer());
    var ul = $('env-zones');
    ul.innerHTML = zones.length ? '' : '<li class="empty"><small>Aucune zone protégée.' + (gerer() ? ' Commencez par « Berges des cours d\'eau » et « Pentes fortes ».' :
      ' Le service de l\'environnement les crée.') + '</small></li>';
    zones.forEach(function (f) {
      var p = f.properties, li = document.createElement('li');
      li.className = 'fon-li' + (p.active ? '' : ' d-inactive');
      li.style.borderLeftColor = C.groupe(p.type).couleur;
      li.innerHTML = '<b>' + esc(p.code) + '</b> · ' + esc(p.nom) + '<small>' + esc(p.type) + ' · <span class="badge ' + cls(p.regle) + '">' + esc(p.regle) +
        '</span> · ' + ha(p.superficie_ha) + ' · ' + A.fmt(p.batiments) + ' bâtiment(s)' + (p.calcul && p.calcul !== 'source' ? ' · calculée' : '') +
        (p.active ? '' : ' · inactive') + '</small>';
      li.onclick = function () { ouvrirZone(p.id); };
      ul.appendChild(li);
    });
  }
  document.querySelectorAll('#env-z-calcul [data-calcul]').forEach(function (b) {
    b.onclick = function () {
      b.disabled = true;
      api('POST', '/zones/calculer/' + b.dataset.calcul).then(function (f) {
        LabeTerrain.toast('Zone ' + f.properties.code + ' : ' + f.properties.nom + ' — ' + ha(f.properties.superficie_ha) + '.');
        if (!map.hasLayer(cZones)) cZones.addTo(map);
        return charger().then(function () { ouvrirZone(f.id); });
      }).catch(fail).then(function () { b.disabled = false; });
    };
  });
  function champsZone(calculee) {
    return (calculee ? [] : [{ n: 'type', l: 'Type', t: 'select', o: LISTES.types_zone.filter(function (t) { return t !== 'Périmètre de source'; }), req: true }])
      .concat([{ n: 'nom', l: 'Nom', req: true, ph: 'ex. Forêt classée de …, espace vert du quartier …' },
        { n: 'regle', l: 'Règle', t: 'select', o: LISTES.regles, req: true,
          aide: 'Protection intégrale : toute nouvelle parcelle y est bloquée. Inconstructible : alerte. Sous conditions : information.' },
        { n: 'reference', l: 'Référence (arrêté, plan…)' }, { n: 'observations', l: 'Observations', t: 'textarea' }]);
  }
  $('env-z-dessiner').onclick = function () {
    A.startSketch('area', { btn: this, label: 'Nouvelle zone protégée', onFinish: function (pts) {
      var g = geometrie('area', pts);
      L.geoJSON(g, { style: { color: '#f2c230', weight: 3, fillOpacity: 0.15, interactive: false } }).addTo(apercu);
      formulaire('Nouvelle zone protégée (' + A.fmtArea(A.polygonArea(pts)) + ')', champsZone(false), { type: 'Forêt classée', regle: 'Protection intégrale' }, function (v) {
        v.geometry = g;
        return api('POST', '/zones', v).then(function (f) { if (!map.hasLayer(cZones)) cZones.addTo(map); return apresEnvoi(f, ouvrirZone); });
      });
    } });
  };
  $('env-z-bati').onchange = function () {
    if (!this.checked) { map.removeLayer(batiZones); return; }
    api('GET', '/batiments-zones').then(function (pts) {
      batiZones.clearLayers();
      pts.forEach(function (c) {
        L.circleMarker([c[1], c[0]], { renderer: rendu, radius: 3, stroke: false, fillColor: C.ALERTE, fillOpacity: 0.9, interactive: false }).addTo(batiZones);
      });
      batiZones.addTo(map);
      LabeTerrain.toast(A.fmt(pts.length) + ' bâtiment(s) en zone protégée stricte, en rouge sur la carte.');
    }).catch(fail);
  };
  function ouvrirZone(id) {
    api('GET', '/zones/' + id).then(function (f) {
      var p = f.properties, d = document.createElement('div');
      ficheCourante = { zone: id };
      d.innerHTML = '<h3>' + esc(p.code) + ' — ' + esc(p.nom) + '</h3><p><span class="badge ' + cls(p.regle) + '">' + esc(p.regle) + '</span>' +
        (p.active ? '' : ' <span class="badge e-inactive">inactive</span>') + '</p>' +
        table([['Type', p.type], ['Superficie', ha(p.superficie_ha)], ['Référence', p.reference],
          ['Origine', p.calcul === 'source' ? 'périmètre d\'un point d\'eau' : p.calcul ? 'calculée à partir des données de la commune' : 'dessinée'],
          ['Bâtiments dans la zone', A.fmt(p.batiments)], ['Parcelles du registre concernées', String(f.parcelles)], ['Observations', p.observations],
          ['Créée le', dateFr(p.cree_le)], ['Modifiée le', dateFr(p.modifie_le)]]);
      var bar = document.createElement('div'); bar.className = 'row';
      if (p.batiments) btn(bar, 'Montrer les bâtiments', '', function () {
        api('GET', '/zones/' + p.id + '/batiments').then(function (pts) {
          batiZone.clearLayers();
          pts.forEach(function (c) { L.circleMarker([c[1], c[0]], { renderer: rendu, radius: 3.5, stroke: false, fillColor: C.ALERTE, fillOpacity: 0.95, interactive: false }).addTo(batiZone); });
        }).catch(fail);
      });
      if (gerer()) {
        btn(bar, 'Modifier', '', function () {
          formulaire('Modifier la zone ' + p.code, champsZone(!!p.calcul), p, function (v) {
            return api('PUT', '/zones/' + p.id, v).then(function () { return charger().then(function () { ouvrirZone(p.id); }); });
          });
        });
        if (p.calcul && p.calcul !== 'source') btn(bar, 'Recalculer', '', function () {
          api('POST', '/zones/calculer/' + p.calcul).then(function () { return charger().then(function () { ouvrirZone(p.id); }); }).catch(fail);
        });
        btn(bar, p.active ? 'Désactiver' : 'Réactiver', '', function () {
          api('PUT', '/zones/' + p.id, { active: !p.active }).then(function () { return charger().then(function () { ouvrirZone(p.id); }); }).catch(fail);
        });
        if (p.calcul !== 'source') btn(bar, 'Supprimer', 'danger', function () {
          if (confirm('Supprimer la zone ' + p.code + ' ?')) api('DELETE', '/zones/' + p.id).then(function () { fermerFiche(); charger(); }).catch(fail);
        });
      }
      d.appendChild(bar);
      var x = document.createElement('div');
      x.innerHTML = (f.batiments_quartiers.length ? '<h4>Bâtiments par quartier</h4><table class="info-table fon-table">' +
        f.batiments_quartiers.map(function (q) { return '<tr><td>' + esc(q.quartier) + '</td><td>' + A.fmt(q.n) + '</td></tr>'; }).join('') + '</table>' : '') +
        (f.atteintes.length ? '<h4>Atteintes dans la zone</h4><ul class="fon-ctl">' + f.atteintes.map(function (a) {
          return '<li data-a="' + a.id + '"><b>' + esc(a.numero) + '</b> ' + esc(a.type) + ' · ' + esc(a.statut) + '</li>';
        }).join('') + '</ul>' : '');
      d.appendChild(x);
      x.querySelectorAll('[data-a]').forEach(function (li) { li.onclick = function () { ouvrirAtteinte(+li.dataset.a); }; });
      montrerFiche(d);
      surligner(f.geometry);
    }).catch(fail);
  }

  // ---------- Atteintes ----------
  var FA = { statut: '', type: '', retard: false };
  function rendreAtteintes() {
    var list = atteintes.filter(function (f) {
      var p = f.properties;
      if (FA.statut === '' ? OUVERTES.indexOf(p.statut) < 0 : FA.statut !== 'tous' && p.statut !== FA.statut) return false;
      if (FA.type && p.type !== FA.type) return false;
      return !FA.retard || p.en_retard;
    });
    var ul = $('env-atteintes');
    ul.innerHTML = list.length ? '' : '<li class="empty"><small>Aucune atteinte pour ces critères.</small></li>';
    list.slice(0, 300).forEach(function (f) {
      var p = f.properties, li = document.createElement('li');
      li.className = 'fon-dossier' + (p.en_retard ? ' retard' : '');
      li.innerHTML = '<b>' + esc(p.numero) + ' — ' + esc(p.type) + '</b><small>' + esc(p.quartier || '—') + ' · <span class="badge ' + cls(p.statut) + '">' + esc(p.statut) +
        '</span> · gravité ' + esc(p.gravite.toLowerCase()) + (p.zones.length ? ' · zone(s) ' + esc(p.zones.join(', ')) : '') + ' · ' + dateFr(p.cree_le) +
        (p.en_retard ? ' · <b class="retard-txt">délai dépassé (' + dateFr(p.echeance) + ')</b>' : '') + '</small>';
      li.onclick = function () { ouvrirAtteinte(p.id); };
      ul.appendChild(li);
    });
  }
  $('env-a-statut').onchange = function () { FA.statut = this.value; rendreAtteintes(); };
  $('env-a-type').onchange = function () { FA.type = this.value; rendreAtteintes(); };
  $('env-a-retard').onchange = function () { FA.retard = this.checked; rendreAtteintes(); };
  $('env-a-export').onclick = function () { telecharger('/export/atteintes.csv', 'atteintes_environnement_labe.csv'); };
  function rendreSignalements() {
    var div = $('env-signalements');
    if (!gerer() || !signalements.length) { div.innerHTML = ''; return; }
    div.innerHTML = '<details class="adr-detail" open><summary>Signalements à prendre en charge : <b>' + signalements.length + '</b></summary><ul class="fon-ctl" id="env-sig"></ul></details>';
    signalements.forEach(function (s) {
      var li = document.createElement('li');
      li.innerHTML = '<b>' + esc(s.type) + '</b> ' + esc(s.nom || '') + ' <small>n° ' + s.id + ' · ' + esc(s.quartier || '—') + ' · ' + dateFr(s.cree_le) + ' · ' +
        esc(s.auteur || '') + (s.description ? '<br>' + esc(s.description) : '') + '</small>';
      var bar = document.createElement('div'); bar.className = 'row';
      btn(bar, 'Voir', '', function () { surligner(s.geometry); });
      btn(bar, 'Ouvrir un dossier d\'atteinte', 'primary', function () {
        api('POST', '/signalements/' + s.id + '/convertir').then(function (f) { return apresEnvoi(f, ouvrirAtteinte); }).catch(fail);
      });
      li.appendChild(bar);
      $('env-sig').appendChild(li);
    });
  }
  function nouvelleAtteinte(g) {
    L.geoJSON(g, { style: { color: '#f2c230', weight: 3, fillOpacity: 0.15 }, pointToLayer: function (f, ll) {
      return L.circleMarker(ll, { radius: 14, color: '#f2c230', weight: 4, fill: false });
    } }).addTo(apercu);
    var champs = [{ n: 'type', l: 'Type', t: 'select', o: LISTES.types_atteinte, req: true },
      { n: 'gravite', l: 'Gravité', t: 'select', o: LISTES.gravites, req: true },
      { n: 'description', l: 'Description', t: 'textarea', req: true, ph: 'Ce qui a été constaté, depuis quand, risques…' },
      { n: 'surface_m2', l: 'Surface touchée (m²)', t: 'number', min: 0, ph: g.type === 'Polygon' ? 'calculée à partir du tracé' : '' },
      { n: 'responsable', l: 'Personne ou entreprise mise en cause (si connue)', ph: 'visible seulement du service de l\'environnement' },
      { n: 'photo', l: 'Photo', t: 'photo' }];
    function ouvrir(alertes) {
      formulaire('Signaler une atteinte à l\'environnement', champs, { gravite: 'Moyenne' }, function (v) {
        v.geometry = g; v.uid = LabeTerrain.uuid();
        return envoyer('POST', '/atteintes', v).then(function (r) { return apresEnvoi(r, ouvrirAtteinte); });
      }, alertes);
    }
    api('POST', '/controle', { geometry: g }).then(function (al) {
      ouvrir(al.length ? '<ul class="fon-alertes">' + al.map(function (a) { return '<li class="n-' + a.niveau + '">' + esc(a.message) + '</li>'; }).join('') + '</ul>' : '');
    }, function () { ouvrir(''); });
  }
  $('env-a-point').onclick = function () { A.startSketch('point', { btn: this, label: 'Atteinte à l\'environnement', onFinish: function (pts) { nouvelleAtteinte(geometrie('point', pts)); } }); };
  $('env-a-surface').onclick = function () { A.startSketch('area', { btn: this, label: 'Surface touchée', onFinish: function (pts) { nouvelleAtteinte(geometrie('area', pts)); } }); };
  $('env-a-gps').onclick = function () { LabeTerrain.pointGps(function (ll) { nouvelleAtteinte(geometrie('point', [ll])); }); };

  // actions sur une atteinte : statuts de départ, réservée au service, champs
  var ACTIONS = [
    { a: 'constater', l: 'Constat sur place', de: ['Signalée'], g: false, champs: ['gravite', 'surface_m2', 'commentaire', 'photo'] },
    { a: 'mettre_en_demeure', l: 'Mise en demeure', de: ['Signalée', 'Constatée'], g: true, champs: ['echeance', 'responsable', 'commentaire'] },
    { a: 'sanctionner', l: 'Sanction', de: ['Constatée', 'Mise en demeure'], g: true, champs: ['amende_gnf', 'commentaire!'] },
    { a: 'remettre_en_etat', l: 'Remise en état constatée', de: ['Constatée', 'Mise en demeure', 'Sanctionnée'], g: true, champs: ['commentaire', 'photo'] },
    { a: 'clore', l: 'Clore', de: ['Sanctionnée', 'Remise en état'], g: true, champs: ['commentaire'] },
    { a: 'classer', l: 'Classer sans suite', de: OUVERTES, g: true, champs: ['commentaire!'] },
    { a: 'rouvrir', l: 'Rouvrir', de: ['Close', 'Classée sans suite', 'Remise en état'], g: true, champs: ['commentaire'] },
    { a: 'commenter', l: 'Commenter', de: null, g: false, champs: ['commentaire', 'photo'] }
  ];
  var CHAMPS_ACTION = {
    gravite: { n: 'gravite', l: 'Gravité', t: 'select', o: ['Faible', 'Moyenne', 'Grave'] },
    surface_m2: { n: 'surface_m2', l: 'Surface touchée (m²)', t: 'number', min: 0 },
    echeance: { n: 'echeance', l: 'Délai accordé (échéance)', t: 'date', req: true },
    responsable: { n: 'responsable', l: 'Personne ou entreprise mise en cause' },
    amende_gnf: { n: 'amende_gnf', l: 'Amende (GNF)', t: 'number', min: 0, step: 1000 },
    commentaire: { n: 'commentaire', l: 'Commentaire', t: 'textarea' },
    photo: { n: 'photo', l: 'Photo', t: 'photo' }
  };
  function ouvrirAtteinte(id) {
    api('GET', '/atteintes/' + id).then(function (f) {
      var p = f.properties, d = document.createElement('div');
      ficheCourante = { atteinte: id };
      d.innerHTML = '<h3>' + esc(p.numero) + ' — ' + esc(p.type) + '</h3><p><span class="badge ' + cls(p.statut) + '">' + esc(p.statut) + '</span> ' +
        '<span class="badge ' + cls('g-' + p.gravite) + '">gravité ' + esc(p.gravite.toLowerCase()) + '</span>' +
        (p.en_retard ? ' <b class="retard-txt">délai dépassé</b>' : '') + '</p>' +
        table([['Description', p.description], ['Surface touchée', p.surface_m2 ? A.fmt(p.surface_m2) + ' m²' : null], ['Quartier', p.quartier],
          ['Zones protégées', p.zones.join(', ')], ['Mis en cause', p.responsable], ['Échéance', dateFr(p.echeance)],
          ['Amende', p.amende_gnf ? A.fmt(p.amende_gnf) + ' GNF' : null], ['Signalée le', dateFr(p.cree_le) + (p.cree_par_nom ? ' par ' + p.cree_par_nom : '')],
          ['Close le', dateFr(p.clos_le)], ['Signalement d\'origine', p.contribution ? 'n° ' + p.contribution : null]]);
      photoFiche(d, p.photo_url);
      var bar = document.createElement('div'); bar.className = 'row';
      ACTIONS.forEach(function (x) {
        if (x.g && !f.peut_gerer) return;
        if (x.de && x.de.indexOf(p.statut) < 0) return;
        btn(bar, x.l, x.a === 'commenter' ? '' : 'primary', function () {
          var champs = x.champs.map(function (c) { var o = Object.assign({}, CHAMPS_ACTION[c.replace('!', '')]); if (c.slice(-1) === '!') o.req = true; return o; });
          formulaire(x.l + ' — ' + p.numero, champs, { gravite: p.gravite, responsable: p.responsable, surface_m2: p.surface_m2 }, function (v) {
            v.action = x.a;
            if (v.responsable === null && x.champs.indexOf('responsable') < 0) delete v.responsable;
            return api('POST', '/atteintes/' + p.id + '/action', v).then(function () { return charger().then(function () { ouvrirAtteinte(p.id); }); });
          });
        });
      });
      if (A.itineraire) btn(bar, 'Itinéraire jusqu\'ici', '', function () {
        var b = L.geoJSON(f.geometry).getBounds().getCenter(); A.itineraire.ajouter(b, p.numero, 'end');
      });
      d.appendChild(bar);
      var h = document.createElement('div');
      h.innerHTML = '<h4>Historique</h4><ul class="histo fon-histo">' + f.historique.map(function (x) {
        return '<li><b>' + dateFr(x.date) + ' ' + heureFr(x.date) + '</b> — ' + esc(x.action) +
          (x.statut_avant && x.statut_apres && x.statut_avant !== x.statut_apres ? ' : ' + esc(x.statut_avant) + ' → ' + esc(x.statut_apres) : '') +
          (x.utilisateur ? ' <small>(' + esc(x.utilisateur) + ')</small>' : '') + (x.commentaire ? '<br><small>' + esc(x.commentaire) + '</small>' : '') +
          photoLien(x.photo_url) + '</li>';
      }).join('') + '</ul>';
      d.appendChild(h); activerPhotos(h);
      montrerFiche(d);
      surligner(f.geometry);
    }).catch(fail);
  }

  // ---------- Plantations ----------
  var FP = { campagne: '' };
  function rendrePlantations() {
    var plants = 0, suivis = 0, vivants = 0;
    plantations.forEach(function (f) {
      var p = f.properties; plants += p.nombre_plants;
      if (p.vivants != null) { suivis += p.nombre_plants; vivants += p.vivants; }
    });
    $('env-p-cartes').innerHTML = carte(plantations.length, 'plantations') + carte(A.fmt(plants), 'plants mis en terre') +
      carte(suivis ? Math.round(100 * vivants / suivis) + ' %' : '—', 'survie (plantations suivies)');
    var camps = {};
    plantations.forEach(function (f) { if (f.properties.campagne) camps[f.properties.campagne] = 1; });
    remplir($('env-p-campagne'), Object.keys(camps).sort().reverse(), 'Toutes les campagnes');
    var list = plantations.filter(function (f) { return !FP.campagne || f.properties.campagne === FP.campagne; });
    var ul = $('env-plantations');
    ul.innerHTML = list.length ? '' : '<li class="empty"><small>Aucune plantation enregistrée.</small></li>';
    list.slice(0, 300).forEach(function (f) {
      var p = f.properties, li = document.createElement('li');
      li.className = 'fon-li' + (p.survie_pct != null && p.survie_pct < 50 ? ' retard' : '');
      li.style.borderLeftColor = C.VERT;
      li.innerHTML = '<b>' + esc(p.numero) + '</b> · ' + esc(p.type) + (p.espece ? ' — ' + esc(p.espece) : '') + '<small>' + A.fmt(p.nombre_plants) + ' plants · ' +
        dateFr(p.date_plantation) + ' · ' + esc(p.quartier || '—') + (p.organisme ? ' · ' + esc(p.organisme) : '') + ' · ' +
        (p.survie_pct != null ? 'survie <b>' + p.survie_pct + ' %</b> (' + dateFr(p.dernier_suivi) + ')' : 'pas encore suivie') + '</small>';
      li.onclick = function () { ouvrirPlantation(p.id); };
      ul.appendChild(li);
    });
  }
  $('env-p-campagne').onchange = function () { FP.campagne = this.value; rendrePlantations(); };
  $('env-p-export').onclick = function () { telecharger('/export/plantations.csv', 'plantations_labe.csv'); };
  function champsPlantation() {
    return [{ n: 'type', l: 'Type', t: 'select', o: LISTES.types_plantation, req: true }, { n: 'espece', l: 'Espèce(s)', ph: 'ex. teck, gmelina, manguier, néré…' },
      { n: 'nombre_plants', l: 'Nombre de plants', t: 'number', min: 1, req: true }, { n: 'date_plantation', l: 'Date de plantation', t: 'date', req: true },
      { n: 'campagne', l: 'Campagne', ph: 'par défaut « Campagne <année> »' }, { n: 'organisme', l: 'Organisme', ph: 'mairie, école, ONG, association…' },
      { n: 'observations', l: 'Observations', t: 'textarea' }, { n: 'photo', l: 'Photo', t: 'photo' }];
  }
  function nouvellePlantation(mode, defaut) {
    A.startSketch(mode, { label: 'Nouvelle plantation', onFinish: function (pts) {
      var g = geometrie(mode, pts);
      L.geoJSON(g, { style: C.STYLE_PLANTATION, pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 12, color: '#f2c230', weight: 4, fill: false }); } }).addTo(apercu);
      formulaire('Nouvelle plantation' + (mode === 'area' ? ' (' + A.fmtArea(A.polygonArea(pts)) + ')' : mode === 'line' ? ' (' + A.fmtLen(A.lineLength(pts)) + ')' : ''),
        champsPlantation(), { type: defaut, date_plantation: aujourdhui(), nombre_plants: mode === 'point' ? 1 : null }, function (v) {
          v.geometry = g; v.uid = LabeTerrain.uuid();
          return envoyer('POST', '/plantations', v).then(function (r) { return apresEnvoi(r, ouvrirPlantation); });
        });
    } });
  }
  $('env-p-point').onclick = function () { nouvellePlantation('point', 'Arbre isolé'); };
  $('env-p-ligne').onclick = function () { nouvellePlantation('line', 'Arbres d\'alignement'); };
  $('env-p-surface').onclick = function () { nouvellePlantation('area', 'Reboisement'); };
  function ouvrirPlantation(id) {
    api('GET', '/plantations/' + id).then(function (f) {
      var p = f.properties, d = document.createElement('div');
      ficheCourante = { plantation: id };
      d.innerHTML = '<h3>' + esc(p.numero) + ' — ' + esc(p.type) + '</h3>' +
        (p.survie_pct != null ? '<div class="dech-progres"><i style="width:' + p.survie_pct + '%"></i></div><p class="hint">Survie : <b>' + p.survie_pct + ' %</b> (' +
          A.fmt(p.vivants) + ' / ' + A.fmt(p.nombre_plants) + ' au ' + dateFr(p.dernier_suivi) + ')</p>' : '<p class="hint">Pas encore de suivi.</p>') +
        table([['Espèces', p.espece], ['Plants mis en terre', A.fmt(p.nombre_plants)], ['Plantée le', dateFr(p.date_plantation)], ['Campagne', p.campagne],
          ['Organisme', p.organisme], ['Quartier', p.quartier], ['Observations', p.observations],
          ['Enregistrée par', p.cree_par_nom]]);
      photoFiche(d, p.photo_url);
      var bar = document.createElement('div'); bar.className = 'row';
      btn(bar, '+ Suivi (plants vivants)', 'primary', function () {
        formulaire('Suivi de ' + p.numero + ' (' + A.fmt(p.nombre_plants) + ' plants)', [
          { n: 'date', l: 'Date de la visite', t: 'date', req: true }, { n: 'vivants', l: 'Plants vivants', t: 'number', min: 0, max: p.nombre_plants, req: true },
          { n: 'etat', l: 'État général', t: 'select', o: LISTES.etats_suivi }, { n: 'commentaire', l: 'Commentaire', t: 'textarea', ph: 'arrosage, divagation des animaux, feux…' },
          { n: 'photo', l: 'Photo', t: 'photo' }], { date: aujourdhui(), vivants: p.vivants, etat: 'Bon' }, function (v) {
          return envoyer('POST', '/plantations/' + p.id + '/suivi', v).then(function (r) { return apresEnvoi(r ? { id: p.id, enAttente: r.enAttente } : null, ouvrirPlantation); });
        });
      });
      if (f.peut_modifier) {
        btn(bar, 'Modifier', '', function () {
          formulaire('Modifier ' + p.numero, champsPlantation(), p, function (v) {
            return api('PUT', '/plantations/' + p.id, v).then(function () { return charger().then(function () { ouvrirPlantation(p.id); }); });
          });
        });
        btn(bar, 'Supprimer', 'danger', function () {
          if (confirm('Supprimer la plantation ' + p.numero + ' ?')) api('DELETE', '/plantations/' + p.id).then(function () { fermerFiche(); charger(); }).catch(fail);
        });
      }
      d.appendChild(bar);
      var h = document.createElement('div');
      h.innerHTML = '<h4>Suivis</h4>' + (f.suivis.length ? '<ul class="histo fon-histo">' + f.suivis.map(function (s) {
        return '<li><b>' + dateFr(s.date) + '</b> — ' + A.fmt(s.vivants) + ' vivant(s) (' + Math.round(100 * s.vivants / p.nombre_plants) + ' %) · état ' +
          esc(s.etat.toLowerCase()) + (s.utilisateur ? ' <small>(' + esc(s.utilisateur) + ')</small>' : '') +
          (s.commentaire ? '<br><small>' + esc(s.commentaire) + '</small>' : '') + photoLien(s.photo_url) + '</li>';
      }).join('') + '</ul>' : '<p class="hint">Aucun suivi. Comptez les plants vivants quelques mois après la plantation, puis chaque année.</p>');
      d.appendChild(h); activerPhotos(h);
      montrerFiche(d);
      surligner(f.geometry);
    }).catch(fail);
  }

  // ---------- Points d'eau ----------
  var FE = { type: '', etat: '' };
  function rendreEaux() {
    var ul = $('env-eaux');
    var list = eaux.filter(function (f) { return (!FE.type || f.properties.type === FE.type) && (!FE.etat || f.properties.etat === FE.etat); });
    ul.innerHTML = list.length ? '' : '<li class="empty"><small>Aucun point d\'eau.</small></li>';
    list.forEach(function (f) {
      var p = f.properties, li = document.createElement('li'), menace = p.batiments || p.depots;
      li.className = 'fon-li' + (p.etat === 'Pollué' || menace ? ' retard' : '');
      li.style.borderLeftColor = p.etat === 'Tari' ? C.GRIS : C.EAU;
      li.innerHTML = '<b>' + esc(p.numero) + '</b> · ' + esc(p.nom || p.type) + '<small>' + esc(p.type) + ' · <span class="badge ' + cls(p.etat) + '">' + esc(p.etat) +
        '</span> · ' + esc(p.quartier || '—') + (menace ? ' · <b class="retard-txt">dans le périmètre : ' + p.batiments + ' bâtiment(s), ' + p.depots + ' dépôt(s)</b>' : '') + '</small>';
      li.onclick = function () { ouvrirEau(p.id); };
      ul.appendChild(li);
    });
  }
  $('env-e-type').onchange = function () { FE.type = this.value; rendreEaux(); };
  $('env-e-etat').onchange = function () { FE.etat = this.value; rendreEaux(); };
  $('env-e-export').onclick = function () { telecharger('/export/points-eau.csv', 'points_eau_labe.csv'); };
  function champsEau() {
    var def = LISTES.parametres.filter(function (x) { return x.cle === 'perimetre_source_m'; })[0].valeur;
    return [{ n: 'type', l: 'Type', t: 'select', o: LISTES.types_eau, req: true }, { n: 'nom', l: 'Nom', ph: 'nom local de la source…' },
      { n: 'etat', l: 'État', t: 'select', o: LISTES.etats_eau }, { n: 'usage', l: 'Usage', ph: 'boisson, lessive, maraîchage, bétail…' },
      { n: 'amenage', l: 'Aménagé (captage, margelle, pompe…)', t: 'check' },
      { n: 'perimetre_m', l: 'Périmètre de protection (m)', t: 'number', min: 0, ph: 'par défaut ' + def + ' m' },
      { n: 'observations', l: 'Observations', t: 'textarea' }, { n: 'photo', l: 'Photo', t: 'photo' }];
  }
  function nouveauPointEau(ll) {
    L.circleMarker(ll, { radius: 14, color: '#f2c230', weight: 4, fill: false }).addTo(apercu);
    formulaire('Nouveau point d\'eau', champsEau(), { type: 'Source', etat: 'Permanent' }, function (v) {
      v.geometry = geometrie('point', [ll]); v.uid = LabeTerrain.uuid();
      return envoyer('POST', '/points-eau', v).then(function (r) { return apresEnvoi(r, ouvrirEau); });
    });
  }
  $('env-e-point').onclick = function () { A.startSketch('point', { btn: this, label: 'Point d\'eau', onFinish: function (pts) { nouveauPointEau(pts[0]); } }); };
  $('env-e-gps').onclick = function () { LabeTerrain.pointGps(nouveauPointEau); };
  function ouvrirEau(id) {
    api('GET', '/points-eau/' + id).then(function (f) {
      var p = f.properties, d = document.createElement('div');
      ficheCourante = { eau: id };
      var r = p.perimetre_m || LISTES.parametres.filter(function (x) { return x.cle === 'perimetre_source_m'; })[0].valeur;
      d.innerHTML = '<h3>' + esc(p.numero) + ' — ' + esc(p.nom || p.type) + '</h3><p><span class="badge ' + cls(p.etat) + '">' + esc(p.etat) + '</span></p>' +
        table([['Type', p.type], ['Usage', p.usage], ['Aménagé', p.amenage ? 'oui' : 'non'], ['Quartier', p.quartier],
          ['Périmètre de protection', r + ' m' + (p.zone_code ? ' (zone ' + p.zone_code + ', inconstructible)' : '')],
          ['Dans le périmètre', A.fmt(p.batiments) + ' bâtiment(s), ' + A.fmt(p.depots) + ' dépôt(s) d\'ordures'],
          ['Dernier constat', dateFr(p.dernier_constat)], ['Observations', p.observations], ['Recensé par', p.cree_par_nom]]);
      photoFiche(d, p.photo_url);
      var bar = document.createElement('div'); bar.className = 'row';
      btn(bar, '+ Constat', 'primary', function () {
        formulaire('Constat — ' + p.numero, [{ n: 'etat', l: 'État', t: 'select', o: LISTES.etats_eau, req: true }, { n: 'debit', l: 'Débit', ph: 'ex. 2 l/s, faible, fort' },
          { n: 'qualite', l: 'Qualité de l\'eau', ph: 'claire, trouble, odeur, couleur…' }, { n: 'commentaire', l: 'Commentaire', t: 'textarea' },
          { n: 'photo', l: 'Photo', t: 'photo' }], { etat: p.etat }, function (v) {
          return envoyer('POST', '/points-eau/' + p.id + '/constat', v).then(function (x) { return apresEnvoi(x ? { id: p.id, enAttente: x.enAttente } : null, ouvrirEau); });
        });
      });
      if (f.peut_modifier) btn(bar, 'Modifier', '', function () {
        formulaire('Modifier ' + p.numero, champsEau().filter(function (c) { return c.n !== 'etat'; }), p, function (v) {
          return api('PUT', '/points-eau/' + p.id, v).then(function () { return charger().then(function () { ouvrirEau(p.id); }); });
        });
      });
      if (p.zone_id) btn(bar, 'Voir le périmètre', '', function () { ouvrirZone(p.zone_id); });
      if (gerer()) btn(bar, 'Supprimer', 'danger', function () {
        if (confirm('Supprimer ' + p.numero + ' et son périmètre ?')) api('DELETE', '/points-eau/' + p.id).then(function () { fermerFiche(); charger(); }).catch(fail);
      });
      d.appendChild(bar);
      var h = document.createElement('div');
      h.innerHTML = (f.depots.length ? '<h4>Dépôts d\'ordures dans le périmètre</h4><ul class="fon-ctl">' + f.depots.map(function (x) {
        return '<li><b>' + esc(x.numero) + '</b> ' + esc(x.type) + ' · ' + esc(x.etat) + '</li>'; }).join('') + '</ul>' : '') +
        (f.atteintes.length ? '<h4>Atteintes dans le périmètre</h4><ul class="fon-ctl">' + f.atteintes.map(function (x) {
          return '<li data-a="' + x.id + '"><b>' + esc(x.numero) + '</b> ' + esc(x.type) + ' · ' + esc(x.statut) + '</li>'; }).join('') + '</ul>' : '') +
        '<h4>Constats</h4><ul class="histo fon-histo">' + f.constats.map(function (k) {
          return '<li><b>' + dateFr(k.date) + '</b> — ' + esc(k.etat) + (k.debit ? ' · débit ' + esc(k.debit) : '') + (k.qualite ? ' · ' + esc(k.qualite) : '') +
            (k.utilisateur ? ' <small>(' + esc(k.utilisateur) + ')</small>' : '') + (k.commentaire ? '<br><small>' + esc(k.commentaire) + '</small>' : '') + photoLien(k.photo_url) + '</li>';
        }).join('') + '</ul>';
      d.appendChild(h); activerPhotos(h);
      h.querySelectorAll('[data-a]').forEach(function (li) { li.onclick = function () { ouvrirAtteinte(+li.dataset.a); }; });
      montrerFiche(d);
      surligner(f.geometry);
    }).catch(fail);
  }

  // ---------- Feux ----------
  var FF = { saison: '' };
  function rendreFeux() {
    var saisons = {};
    feux.forEach(function (f) { saisons[f.properties.saison] = 1; });
    remplir($('env-f-saison'), Object.keys(saisons).sort().reverse(), 'Toutes les saisons');
    $('env-f-import-btn').classList.toggle('hidden', !gerer());
    $('env-f-aide').innerHTML = 'Saison des feux ' + esc(LISTES.saison) + '. ' + (gerer() ? 'Détections satellite : téléchargez le fichier CSV des « feux actifs » (VIIRS ou MODIS) sur ' +
      '<a href="https://firms.modaps.eosdis.nasa.gov/download/" target="_blank" rel="noopener">NASA FIRMS</a> pour la Guinée, puis importez-le : seuls les feux de la commune sont gardés.' : '');
    var list = feux.filter(function (f) { return !FF.saison || f.properties.saison === FF.saison; });
    var ul = $('env-feux');
    ul.innerHTML = list.length ? '' : '<li class="empty"><small>Aucun feu enregistré.</small></li>';
    list.slice(0, 300).forEach(function (f) {
      var p = f.properties, li = document.createElement('li');
      li.className = 'fon-li'; li.style.borderLeftColor = C.FEU;
      li.innerHTML = '<b>' + dateFr(p.date_feu) + '</b> · ' + esc(p.origine) + '<small>' + esc(p.cause) + (p.surface_ha ? ' · ' + ha(p.surface_ha) : '') + ' · ' +
        esc(p.quartier || 'hors quartier') + (p.confiance ? ' · confiance ' + esc(p.confiance) : '') + '</small>';
      li.onclick = function () { ouvrirFeu(p.id); };
      ul.appendChild(li);
    });
  }
  $('env-f-saison').onchange = function () { FF.saison = this.value; rendreFeux(); };
  $('env-f-export').onclick = function () { telecharger('/export/feux.csv', 'feux_brousse_labe.csv'); };
  function nouveauFeu(mode) {
    A.startSketch(mode, { label: mode === 'area' ? 'Surface brûlée' : 'Feu de brousse', onFinish: function (pts) {
      var g = geometrie(mode, pts);
      L.geoJSON(g, { style: C.STYLE_FEU, pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 12, color: '#f2c230', weight: 4, fill: false }); } }).addTo(apercu);
      formulaire('Feu de brousse' + (mode === 'area' ? ' (' + A.fmtArea(A.polygonArea(pts)) + ')' : ''), [
        { n: 'date_feu', l: 'Date du feu', t: 'date', req: true }, { n: 'cause', l: 'Cause', t: 'select', o: LISTES.causes_feu },
        { n: 'surface_ha', l: 'Surface brûlée (ha)', t: 'number', min: 0, step: 0.1, ph: mode === 'area' ? 'calculée à partir du tracé' : 'estimation' },
        { n: 'description', l: 'Description', t: 'textarea' }], { date_feu: aujourdhui(), cause: 'Inconnue' }, function (v) {
        v.geometry = g;
        return envoyer('POST', '/feux', v).then(function (r) { return apresEnvoi(r, ouvrirFeu); });
      });
    } });
  }
  $('env-f-point').onclick = function () { nouveauFeu('point'); };
  $('env-f-surface').onclick = function () { nouveauFeu('area'); };
  $('env-f-import-btn').onclick = function () { $('env-f-import').click(); };
  $('env-f-import').onchange = function () {
    var file = this.files[0]; this.value = '';
    if (!file) return;
    file.text().then(function (txt) { return api('POST', '/feux/import-firms', { csv: txt }); }).then(function (r) {
      alert(r.lus + ' détection(s) dans le fichier, ' + r.dans_commune + ' dans la commune : ' + r.ajoutes + ' ajoutée(s), ' + r.doublons + ' déjà connue(s).');
      charger();
    }).catch(fail);
  };
  function ouvrirFeu(id) {
    var x = parId.feu[id];
    if (!x) return;
    var p = x.f.properties, d = document.createElement('div');
    ficheCourante = { feu: id };
    d.innerHTML = '<h3>Feu de brousse du ' + dateFr(p.date_feu) + '</h3>' + table([['Saison', p.saison], ['Origine', p.origine], ['Cause', p.cause],
      ['Surface brûlée', ha(p.surface_ha)], ['Confiance (satellite)', p.confiance], ['Quartier', p.quartier], ['Description', p.description],
      ['Enregistré par', p.cree_par_nom]]);
    var bar = document.createElement('div'); bar.className = 'row';
    if (gerer() || p.cree_par === Auth.user().id) btn(bar, 'Supprimer', 'danger', function () {
      if (confirm('Supprimer ce feu ?')) api('DELETE', '/feux/' + id).then(function () { fermerFiche(); charger(); }).catch(fail);
    });
    d.appendChild(bar);
    montrerFiche(d);
    surligner(x.f.geometry);
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
  function colonnes(mois, titre) {
    var W = 300, H = 90, pad = 18, n = mois.length, max = Math.max.apply(null, mois.map(function (m) { return m.n; }).concat([1])), bw = (W - 2) / n;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + (H + pad) + '" class="fon-col" role="img" aria-label="' + esc(titre) + '"><line x1="0" y1="' + H + '" x2="' + W + '" y2="' + H + '" class="axe"/>';
    mois.forEach(function (m, i) {
      var h = (H - 14) * m.n / max, x = 1 + i * bw, hh = Math.max(h, m.n ? 2 : 0);
      var lib = new Date(m.mois + '-01').toLocaleDateString('fr-FR', { month: 'short' });
      svg += '<g><title>' + esc(lib + ' : ' + m.n) + '</title><rect x="' + (x + 3) + '" y="' + (H - hh) + '" width="' + (bw - 6) + '" height="' + hh + '" rx="2"/>' +
        '<rect x="' + x + '" y="0" width="' + bw + '" height="' + H + '" class="cible"/>' + (m.n ? '<text x="' + (x + bw / 2) + '" y="' + (H - h - 3) + '" class="v">' + m.n + '</text>' : '') +
        '<text x="' + (x + bw / 2) + '" y="' + (H + 12) + '" class="m">' + esc(lib) + '</text></g>';
    });
    return svg + '</svg>';
  }
  function chargerBilan() {
    var div = $('env-bilan');
    api('GET', '/bilan').then(function (b) {
      var ouvertes = OUVERTES.reduce(function (s, k) { return s + (b.atteintes_statut[k] || 0); }, 0);
      var plants = b.campagnes.reduce(function (s, c) { return s + c.plants; }, 0);
      var suivis = b.campagnes.reduce(function (s, c) { return s + (c.plants_suivis || 0); }, 0), viv = b.campagnes.reduce(function (s, c) { return s + (c.vivants || 0); }, 0);
      var bz = b.bati_zones_type.reduce(function (s, x) { return s + x.n; }, 0);
      var saison = b.feux_saisons.filter(function (s) { return s.saison === LISTES.saison; })[0] || { n: 0, ha: 0 };
      var html = '<div class="stat-cards">' + carte(ouvertes, 'atteintes en cours', ouvertes ? 'alerte' : '') +
        carte(b.en_retard, 'mises en demeure dépassées', b.en_retard ? 'alerte' : '') +
        carte(b.delai.j != null ? A.fmt(b.delai.j, 1) + ' j' : '—', 'délai moyen de traitement') + carte(A.fmt(plants), 'plants mis en terre') +
        carte(suivis ? Math.round(100 * viv / suivis) + ' %' : '—', 'survie des plantations suivies') +
        carte(A.fmt(bz), 'bâtiments en zone protégée stricte', bz ? 'alerte' : '') +
        carte(saison.n + (saison.ha ? ' · ' + A.fmt(saison.ha, 1) + ' ha' : ''), 'feux, saison ' + LISTES.saison) + '</div>';
      html += '<h4>Atteintes par type (en cours / total)</h4>' + (b.atteintes_type.length ? barres(b.atteintes_type, function (x) { return x.total; },
        function (x) { return x.type; }, function (x) { return x.ouvertes + ' / ' + x.total; }) : '<p class="hint">Aucune atteinte.</p>');
      if (b.atteintes_quartier.length) html += '<h4>Atteintes en cours par quartier</h4>' + barres(b.atteintes_quartier.slice(0, 15), function (x) { return x.n; }, function (x) { return x.quartier; });
      html += '<h4>Bâtiments en zone protégée stricte</h4>' + (bz ? barres(b.bati_zones_type, function (x) { return x.n; }, function (x) { return x.lib; }) +
        '<p class="hint">Par quartier :</p>' + barres(b.bati_zones_quartier.slice(0, 15), function (x) { return x.n; }, function (x) { return x.lib; }) +
        '<div class="row"><button type="button" id="env-b-bz">Liste des bâtiments (CSV, Excel)</button></div>' : '<p class="hint">Aucun (ou pas encore de zone protégée).</p>');
      html += '<h4>Plantations par campagne</h4>' + (b.campagnes.length ? '<table class="info-table fon-table"><tr><th>Campagne</th><th>Plantations</th><th>Plants</th><th>Survie</th></tr>' +
        b.campagnes.map(function (c) {
          return '<tr><td>' + esc(c.campagne) + '</td><td>' + c.plantations + '</td><td>' + A.fmt(c.plants) + '</td><td>' +
            (c.plants_suivis ? Math.round(100 * c.vivants / c.plants_suivis) + ' % <small>(' + A.fmt(c.vivants) + ' / ' + A.fmt(c.plants_suivis) + ' suivis)</small>' : '—') + '</td></tr>';
        }).join('') + '</table>' : '<p class="hint">Aucune plantation.</p>');
      html += '<h4>Sources et points d\'eau</h4>' + (b.eau.length ? '<table class="info-table fon-table">' + b.eau.map(function (x) {
        return '<tr><td>' + esc(x.type) + '</td><td>' + esc(x.etat) + '</td><td>' + x.n + '</td></tr>'; }).join('') + '</table>' : '<p class="hint">Aucun point d\'eau.</p>');
      html += '<h4>Feux de brousse par saison</h4>' + (b.feux_saisons.length ? '<table class="info-table fon-table"><tr><th>Saison</th><th>Feux</th><th>dont satellite</th><th>Surface</th></tr>' +
        b.feux_saisons.map(function (s) { return '<tr><td>' + esc(s.saison) + '</td><td>' + s.n + '</td><td>' + s.satellite + '</td><td>' + (s.ha ? A.fmt(s.ha, 1) + ' ha' : '—') + '</td></tr>'; }).join('') +
        '</table>' : '<p class="hint">Aucun feu enregistré.</p>') + '<p class="hint">Feux par mois, saison ' + esc(LISTES.saison) + ' :</p>' + colonnes(b.feux_mois, 'Feux de brousse par mois');
      html += '<h4>Couverture végétale par quartier</h4><p class="hint">Boisements, forêts, espaces verts et reboisements cartographiés (les moins verts en premier).</p>' +
        barres(b.vegetation, function (x) { return x.pct; }, function (x) { return x.quartier; }, function (x) { return A.fmt(x.pct, 1) + ' % · ' + A.fmt(x.plants) + ' plants'; });
      div.innerHTML = html;
      if ($('env-b-bz')) $('env-b-bz').onclick = function () { telecharger('/export/batiments-zones.csv', 'batiments_zones_protegees_labe.csv'); };
    }).catch(function (e) { div.innerHTML = '<p class="form-msg">' + esc(e.message) + '</p>'; });
    rendreParametres();
  }
  var LIB_PARAM = { perimetre_source_m: 'Périmètre des points d\'eau (m)', pente_forte_pct: 'Pente forte à partir de (%)',
    surface_min_ha: 'Surface minimale d\'une zone calculée (ha)', mois_debut_saison_feux: 'Début de la saison des feux (mois)' };
  function rendreParametres() {
    var div = $('env-parametres');
    div.innerHTML = '<table class="info-table">' + LISTES.parametres.map(function (x) {
      return '<tr><td title="' + esc(x.description) + '">' + esc(LIB_PARAM[x.cle] || x.cle) + '</td><td>' +
        (gerer() ? '<input type="number" min="0" step="any" data-k="' + esc(x.cle) + '" value="' + x.valeur + '" style="width:80px">' : A.fmt(x.valeur, 1)) + '</td></tr>';
    }).join('') + '</table><p class="hint">Largeur des berges : ' + LISTES.berge_m + ' m (paramètre du foncier, partagé).</p>' +
      (gerer() ? '<div class="row"><button type="button" id="env-param-ok">Enregistrer les paramètres</button></div>' : '');
    if ($('env-param-ok')) $('env-param-ok').onclick = function () {
      Promise.all(Array.prototype.map.call(div.querySelectorAll('[data-k]'), function (inp) {
        return api('PUT', '/parametres/' + inp.dataset.k, { valeur: parseFloat(inp.value) || 0 });
      })).then(function () { return api('GET', '/listes'); }).then(function (l) { LISTES = l; LabeTerrain.toast('Paramètres enregistrés.'); rendreParametres(); charger(); }).catch(fail);
    };
  }

  // ---------- Tables attributaires ----------
  function tableDe(liste, cle) {
    return function () {
      return liste().map(function (f) { var x = parId[cle][f.id]; return { layer: x && x.l, feature: { type: 'Feature', geometry: f.geometry, properties: x ? x.l.feature.properties : f.properties } }; });
    };
  }

  // ---------- Démarrage ----------
  function start() {
    api('GET', '/listes').then(function (l) {
      LISTES = l;
      remplir($('env-a-type'), l.types_atteinte, 'Tous les types');
      remplir($('env-a-statut'), l.statuts); $('env-a-statut').insertBefore(new Option('En cours', ''), $('env-a-statut').firstChild);
      $('env-a-statut').add(new Option('Toutes', 'tous')); $('env-a-statut').value = '';
      remplir($('env-e-type'), l.types_eau, 'Tous les types'); remplir($('env-e-etat'), l.etats_eau, 'Tous les états');
      A.ready.then(function () {
        var G = 'Protection de l\'environnement';
        [[cZones, 'Zones protégées'], [cEau, 'Sources et points d\'eau'], [cPl, 'Plantations'], [cAtt, 'Atteintes à l\'environnement'], [cFeu, 'Feux de brousse']]
          .forEach(function (x) { A.enregistrerIdentifiable(x[0], x[1]); });
        A.addOverlay({ name: 'Zones protégées', layer: cZones, on: true, group: G, table: tableDe(function () { return zones; }, 'zone'),
          swatch: '<span class="swatch" style="background:' + C.EAU + '"></span>', legend: C.legendeZones() });
        A.addOverlay({ name: 'Atteintes à l\'environnement', layer: cAtt, on: true, group: G, table: tableDe(function () { return atteintes; }, 'att'),
          swatch: '<span class="swatch dot" style="background:' + C.ATTEINTE + '"></span>' });
        A.addOverlay({ name: 'Sources et points d\'eau', layer: cEau, on: true, group: G, table: tableDe(function () { return eaux; }, 'eau'),
          swatch: '<span class="swatch dot" style="background:' + C.EAU + '"></span>',
          legend: [['S source · P puits · F forage · M mare', C.EAU, 'dot'], ['Pollué (anneau rouge et « ! »)', C.ALERTE, 'dot'], ['Tari', C.GRIS, 'dot']] });
        A.addOverlay({ name: 'Plantations', layer: cPl, on: true, group: G, table: tableDe(function () { return plantations; }, 'pl'),
          swatch: '<span class="swatch dot" style="background:' + C.VERT + '"></span>' });
        A.addOverlay({ name: 'Feux de brousse', layer: cFeu, on: false, group: G, table: tableDe(function () { return feux; }, 'feu'),
          swatch: '<span class="swatch" style="background:' + C.FEU + '"></span>' });
      });
      return charger();
    }).catch(fail);
  }
  var fileDiv = null;
  window.LabeEnvironnement = {
    start: start, recharger: function () { if (LISTES) charger(); }, ouvrirAtteinte: ouvrirAtteinte, sousOnglet: sousOnglet,
    file: function (n) {   // saisies de terrain en attente de réseau (file partagée avec les déchets)
      if (!fileDiv) { fileDiv = document.createElement('p'); fileDiv.className = 'fon-avert'; $('env-liste-vue').insertBefore(fileDiv, $('env-liste-vue').children[1]); }
      fileDiv.textContent = '📶 ' + n + ' saisie(s) en attente de réseau, envoyée(s) automatiquement.';
      fileDiv.classList.toggle('hidden', !n);
    }
  };
})();
