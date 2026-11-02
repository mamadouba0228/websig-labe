/* Réseaux (espace agents) :
 * - éclairage public : lampadaires (solaires ou raccordés), état, rues éclairées et non éclairées ;
 * - bornes-fontaines : recensement, état, bâtiments loin d'une borne en service ;
 * - pannes et fuites : signalement (sur un équipement, sur la carte ou au GPS), transmission à l'EDG, à la SEG
 *   ou à une entreprise, réparation, délais ; signalements de l'onglet Saisie pris en charge ;
 * - bilan par quartier. Les saisies de terrain partent même sans réseau (file d'attente partagée avec les déchets). */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc, C = window.LabeResCarte;
  var OUVERTES = ['Signalée', 'Transmise', 'En réparation'];

  function $(id) { return document.getElementById(id); }
  function api(m, p, b) { return Auth.api(m, '/reseaux' + p, b); }
  function envoyer(m, p, b) { return LabeDechets.envoyer(m, '/reseaux' + p, b); }
  function fail(e) { alert('Erreur : ' + e.message); }
  function gerer() { return !!(LISTES && LISTES.peut_gerer); }
  function dateFr(d) { return d ? new Date(d).toLocaleDateString('fr-FR') : ''; }
  function heureFr(d) { return d ? new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''; }
  function cls(s) { return 'r-' + String(s).replace(/[\s'/]/g, '-'); }
  function badge(s) { return '<span class="badge ' + cls(s) + '">' + esc(s) + '</span>'; }
  function param(k) { return LISTES.parametres.filter(function (x) { return x.cle === k; })[0].valeur; }
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
    valeurs.forEach(function (v) { sel.add(new Option(v, v, false, v === cur)); });
  }
  function telecharger(chemin, nom) {
    Auth.blobUrl('/api/reseaux' + chemin).then(function (u) { var a = document.createElement('a'); a.href = u; a.download = nom; a.click(); })
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
  function point(ll) { return { type: 'Point', coordinates: [+ll.lng.toFixed(7), +ll.lat.toFixed(7)] }; }
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
  // champs : { n, l, t: text|textarea|number|date|select|check|photo, o: options, req, ph, min, max, step, aide, vide }
  var MF = { form: $('res-form'), modal: $('res-modal'), champs: [], photos: {}, envoi: null };
  function formulaire(titre, champs, valeurs, envoi) {
    valeurs = valeurs || {};
    MF.champs = champs; MF.photos = {}; MF.envoi = envoi;
    $('res-mf-titre').textContent = titre;
    $('res-mf-msg').textContent = '';
    var div = $('res-mf-champs'); div.innerHTML = '';
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
  $('res-mf-annuler').onclick = function () { MF.modal.classList.add('hidden'); apercu.clearLayers(); };
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
    }).catch(function (err) { $('res-mf-msg').textContent = err.message; }).then(function () { bouton.disabled = false; });
  });
  function apresEnvoi(r, ouvrir) {
    if (r && r.enAttente) { LabeTerrain.toast('Pas de réseau : la saisie est gardée dans le téléphone et sera envoyée automatiquement.'); return; }
    return charger().then(function () { if (ouvrir && r) ouvrir(r.id); });
  }
  // équipement tout près d'un autre : on demande avant d'enregistrer quand même
  function avecDoublon(envoi) {
    return envoi(false).catch(function (e) {
      if (e.status === 409 && e.detail && e.detail.proche && confirm(e.message + '\n\nEnregistrer quand même ?')) return envoi(true);
      throw e;
    });
  }

  // ---------- Données et couches ----------
  var LISTES = null, lampadaires = [], bornes = [], interventions = [], signalements = [];
  var parId = { lp: {}, bf: {}, in: {} };
  var cLamp = A.markClicks(L.featureGroup()), cBorne = A.markClicks(L.featureGroup()), cInter = A.markClicks(L.featureGroup());
  var surbrillance = L.featureGroup().addTo(map), apercu = L.featureGroup().addTo(map);
  var rendu = L.canvas({ padding: 0.3 }), cVoies = L.featureGroup(), cLoin = L.layerGroup();
  var recherches = [];

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
  function ajouter(groupe, cle, f, icone, info, popup, recherche) {
    var p = f.properties;
    var l = L.marker([f.geometry.coordinates[1], f.geometry.coordinates[0]], { icon: icone(p), keyboard: false });
    l.feature = { type: 'Feature', geometry: f.geometry, properties: info(p) };
    l.bindPopup(function () { return popup(p); }, { maxWidth: 300 });
    groupe.addLayer(l);
    parId[cle][p.id] = { f: f, l: l };
    if (recherche) {
      var it = { name: recherche, type: info(p).libelle, layer: l, parent: groupe };
      A.searchIndex.push(it); recherches.push(it);
    }
  }
  function infoLampadaire(q) {
    return { libelle: 'Lampadaire ' + q.numero, 'État': q.etat, 'Alimentation': q.alimentation, 'Lampe': q.lampe,
      'Puissance': q.puissance_w ? q.puissance_w + ' W' : null, 'Rue': q.voie, 'Quartier': q.quartier, 'Gestionnaire': q.gestionnaire,
      'Pannes en cours': q.ouvertes || null };
  }
  function infoBorne(q) {
    return { libelle: (q.nom || q.type) + ' (' + q.numero + ')', 'Type': q.type, 'État': q.etat, 'Gestionnaire': q.gestionnaire,
      'Robinets': q.robinets, 'Payante': q.payante ? 'oui' : 'non', 'Prix du bidon': q.prix_gnf ? A.fmt(q.prix_gnf) + ' GNF' : null,
      'Horaires': q.horaires, 'Quartier': q.quartier, 'Pannes en cours': q.ouvertes || null };
  }
  function infoIntervention(q) {
    return { libelle: q.numero + ' — ' + q.nature, 'Réseau': q.reseau, 'Statut': q.statut, 'Urgence': q.urgence, 'Équipement': q.equipement,
      'Transmise à': q.transmise_a, 'Quartier': q.quartier, 'Signalée le': dateFr(q.cree_le), 'Délai dépassé': q.en_retard ? 'oui' : null };
  }
  function dessiner() {
    [cLamp, cBorne, cInter].forEach(function (g) { g.clearLayers(); });
    parId = { lp: {}, bf: {}, in: {} };
    recherches.forEach(function (it) { var i = A.searchIndex.indexOf(it); if (i >= 0) A.searchIndex.splice(i, 1); });
    recherches = [];
    lampadaires.forEach(function (f) {
      ajouter(cLamp, 'lp', f, C.iconeLampadaire, infoLampadaire, function (q) {
        return popupAvec('Lampadaire ' + q.numero, [['État', q.etat], ['Alimentation', q.alimentation], ['Rue', q.voie],
          ['Pannes en cours', q.ouvertes ? String(q.ouvertes) : null]], function () { ouvrirLampadaire(q.id); });
      }, 'Lampadaire ' + f.properties.numero + (f.properties.voie ? ' · ' + f.properties.voie : ''));
    });
    bornes.forEach(function (f) {
      ajouter(cBorne, 'bf', f, C.iconeBorne, infoBorne, function (q) {
        return popupAvec((q.nom || q.type) + ' (' + q.numero + ')', [['État', q.etat], ['Gestionnaire', q.gestionnaire],
          ['Prix du bidon', q.prix_gnf ? A.fmt(q.prix_gnf) + ' GNF' : null], ['Pannes en cours', q.ouvertes ? String(q.ouvertes) : null]], function () { ouvrirBorne(q.id); });
      }, (f.properties.nom ? f.properties.nom + ' · ' : '') + f.properties.numero);
    });
    interventions.forEach(function (f) {
      if (OUVERTES.indexOf(f.properties.statut) < 0) return;   // carte : pannes et fuites en cours seulement
      ajouter(cInter, 'in', f, C.iconeIntervention, infoIntervention, function (q) {
        return popupAvec(q.numero + ' — ' + q.nature, [['Statut', q.statut], ['Urgence', q.urgence], ['Équipement', q.equipement],
          ['Délai', q.en_retard ? 'dépassé' : null]], function () { ouvrirIntervention(q.id); });
      }, f.properties.numero + ' · ' + f.properties.nature);
    });
  }

  function charger() {
    return Promise.all([api('GET', '/lampadaires'), api('GET', '/bornes'), api('GET', '/interventions'),
      gerer() ? api('GET', '/signalements') : Promise.resolve([])])
      .then(function (r) {
        lampadaires = r[0].features; bornes = r[1].features; interventions = r[2].features; signalements = r[3];
        dessiner(); rendre();
        if (map.hasLayer(cVoies)) chargerVoies(true);
        if (map.hasLayer(cLoin)) chargerLoin(true);
      }).catch(fail);
  }

  function surligner(geometry) {
    surbrillance.clearLayers();
    if (!geometry) return;
    var ll = L.latLng(geometry.coordinates[1], geometry.coordinates[0]);
    L.circleMarker(ll, { radius: 18, color: '#f2c230', weight: 4, fill: false, interactive: false }).addTo(surbrillance);
    map.setView(ll, Math.max(map.getZoom(), 17));
  }

  // ---------- Sous-onglets et fiches ----------
  function sousOnglet(k) {
    document.querySelectorAll('.res-switch button').forEach(function (b) { b.classList.toggle('active', b.dataset.res === k); });
    ['ecl', 'eau', 'pan', 'bil'].forEach(function (x) { $('res-' + x).classList.toggle('hidden', x !== k); });
    fermerFiche();
    if (k === 'bil') chargerBilan();
  }
  document.querySelectorAll('.res-switch button').forEach(function (b) { b.onclick = function () { sousOnglet(b.dataset.res); }; });
  function montrerFiche(el) {
    $('res-liste-vue').classList.add('hidden');
    $('res-fiche-vue').classList.remove('hidden');
    var f = $('res-fiche'); f.innerHTML = ''; f.appendChild(el);
    $('tab-res').scrollTop = 0;
  }
  function fermerFiche() {
    $('res-fiche-vue').classList.add('hidden');
    $('res-liste-vue').classList.remove('hidden');
    surbrillance.clearLayers();
  }
  $('res-retour').onclick = fermerFiche;

  function rendre() {
    rendreLampadaires(); rendreBornes(); rendreInterventions(); rendreSignalements();
    var aTraiter = interventions.filter(function (f) { return f.properties.statut === 'Signalée' || f.properties.en_retard; }).length;
    $('res-pan-badge').textContent = aTraiter; $('res-pan-badge').classList.toggle('hidden', !aTraiter);
    var nb = gerer() ? aTraiter + signalements.length : 0;
    $('res-badge').textContent = nb; $('res-badge').classList.toggle('hidden', !nb);
  }
  function listeInterventions(list) {
    return list.length ? '<h4>Pannes et fuites</h4><ul class="fon-ctl">' + list.map(function (i) {
      return '<li data-i="' + i.id + '"><b>' + esc(i.numero) + '</b> ' + esc(i.nature) + ' · ' + badge(i.statut) + ' · ' + dateFr(i.cree_le) +
        (i.repare_le ? ' → réparée le ' + dateFr(i.repare_le) : '') + '</li>';
    }).join('') + '</ul>' : '<p class="hint">Aucune panne enregistrée.</p>';
  }
  function activerInterventions(el) {
    el.querySelectorAll('[data-i]').forEach(function (li) { li.onclick = function () { ouvrirIntervention(+li.dataset.i); }; });
  }
  function deplacer(quoi, p, rouvrir) {
    A.startSketch('point', { label: 'Nouvel emplacement de ' + p.numero, onFinish: function (pts) {
      avecDoublon(function (forcer) { return api('PUT', '/' + quoi + '/' + p.id, { geometry: point(pts[0]), forcer: forcer }); })
        .then(function () { return charger().then(function () { rouvrir(p.id); }); }).catch(fail);
    } });
  }

  // ---------- Éclairage public ----------
  var FL = { etat: '', alim: '' };
  function rendreLampadaires() {
    var n = lampadaires.length, ok = 0, panne = 0;
    lampadaires.forEach(function (f) { if (f.properties.etat === 'En service') ok++; if (f.properties.etat === 'En panne') panne++; });
    $('res-l-cartes').innerHTML = carte(A.fmt(n), 'lampadaires recensés') + carte(pct(ok, n), 'en service') + carte(panne, 'en panne', panne ? 'alerte' : '');
    var list = lampadaires.filter(function (f) { return (!FL.etat || f.properties.etat === FL.etat) && (!FL.alim || f.properties.alimentation === FL.alim); });
    var ul = $('res-lampadaires');
    ul.innerHTML = list.length ? '' : '<li class="empty"><small>Aucun lampadaire' + (n ? ' pour ces critères' : ' recensé : commencez par « Placer un lampadaire »') + '.</small></li>';
    list.slice(0, 300).forEach(function (f) {
      var p = f.properties, li = document.createElement('li');
      li.className = 'fon-li' + (p.etat === 'En panne' ? ' retard' : '');
      li.style.borderLeftColor = p.etat === 'En service' || p.etat === 'En panne' ? C.LUMIERE : C.GRIS;
      li.innerHTML = '<b>' + esc(p.numero) + '</b> · ' + esc(p.voie || 'rue inconnue') + '<small>' + badge(p.etat) + ' · ' + esc(p.alimentation) +
        (p.lampe ? ' · ' + esc(p.lampe) : '') + ' · ' + esc(p.quartier || '—') + '</small>';
      li.onclick = function () { ouvrirLampadaire(p.id); };
      ul.appendChild(li);
    });
    if (list.length > 300) ul.insertAdjacentHTML('beforeend', '<li class="empty"><small>… ' + (list.length - 300) + ' autres : filtrez ou utilisez la table attributaire.</small></li>');
  }
  $('res-l-etat').onchange = function () { FL.etat = this.value; rendreLampadaires(); };
  $('res-l-alim').onchange = function () { FL.alim = this.value; rendreLampadaires(); };
  $('res-l-export').onclick = function () { telecharger('/export/lampadaires.csv', 'lampadaires_labe.csv'); };
  function champsLampadaire() {
    return [{ n: 'etat', l: 'État', t: 'select', o: LISTES.etats_lampadaire, req: true,
      aide: '« En panne » ouvre automatiquement une panne à réparer.' },
      { n: 'alimentation', l: 'Alimentation', t: 'select', o: LISTES.alimentations, req: true },
      { n: 'lampe', l: 'Lampe', t: 'select', o: LISTES.lampes, vide: '—' }, { n: 'puissance_w', l: 'Puissance (W)', t: 'number', min: 1 },
      { n: 'hauteur_m', l: 'Hauteur du mât (m)', t: 'number', min: 1, step: 0.5 },
      { n: 'gestionnaire', l: 'Gestionnaire', ph: 'commune, projet, ONG, EDG…' }, { n: 'date_pose', l: 'Date de pose', t: 'date' },
      { n: 'observations', l: 'Observations', t: 'textarea' }, { n: 'photo', l: 'Photo', t: 'photo' }];
  }
  function nouveauLampadaire(ll) {
    L.circleMarker(ll, { radius: 14, color: '#f2c230', weight: 4, fill: false }).addTo(apercu);
    formulaire('Nouveau lampadaire', champsLampadaire(), { etat: 'En service', alimentation: 'Solaire' }, function (v) {
      v.geometry = point(ll); v.uid = LabeTerrain.uuid();
      return avecDoublon(function (forcer) { v.forcer = forcer; return envoyer('POST', '/lampadaires', v); })
        .then(function (r) { if (!map.hasLayer(cLamp)) cLamp.addTo(map); return apresEnvoi(r, ouvrirLampadaire); });
    });
  }
  $('res-l-point').onclick = function () { A.startSketch('point', { btn: this, label: 'Lampadaire', onFinish: function (pts) { nouveauLampadaire(pts[0]); } }); };
  $('res-l-gps').onclick = function () { LabeTerrain.pointGps(nouveauLampadaire); };
  function ouvrirLampadaire(id) {
    api('GET', '/lampadaires/' + id).then(function (f) {
      var p = f.properties, d = document.createElement('div');
      d.innerHTML = '<h3>Lampadaire ' + esc(p.numero) + '</h3><p>' + badge(p.etat) + '</p>' +
        table([['Rue', p.voie], ['Quartier', p.quartier], ['Alimentation', p.alimentation], ['Lampe', p.lampe],
          ['Puissance', p.puissance_w ? p.puissance_w + ' W' : null], ['Hauteur du mât', p.hauteur_m ? A.fmt(p.hauteur_m, 1) + ' m' : null],
          ['Gestionnaire', p.gestionnaire], ['Posé le', dateFr(p.date_pose)], ['Dernier constat', dateFr(p.dernier_constat)],
          ['Observations', p.observations], ['Recensé par', p.cree_par_nom]]);
      photoFiche(d, p.photo_url);
      var bar = document.createElement('div'); bar.className = 'row';
      btn(bar, 'Signaler une panne', 'primary', function () { nouvelleIntervention('Éclairage', null, { lampadaire: p.id, numero: p.numero }); });
      if (f.peut_modifier) {
        btn(bar, 'Modifier', '', function () {
          formulaire('Modifier le lampadaire ' + p.numero, champsLampadaire(), p, function (v) {
            return api('PUT', '/lampadaires/' + p.id, v).then(function () { return charger().then(function () { ouvrirLampadaire(p.id); }); });
          });
        });
        btn(bar, 'Déplacer', '', function () { deplacer('lampadaires', p, ouvrirLampadaire); });
        btn(bar, 'Supprimer', 'danger', function () {
          if (confirm('Supprimer le lampadaire ' + p.numero + ' ?')) api('DELETE', '/lampadaires/' + p.id).then(function () { fermerFiche(); charger(); }).catch(fail);
        });
      }
      d.appendChild(bar);
      var h = document.createElement('div'); h.innerHTML = listeInterventions(f.interventions); d.appendChild(h); activerInterventions(h);
      montrerFiche(d);
      surligner(f.geometry);
    }).catch(fail);
  }
  function chargerVoies(silence) {
    return api('GET', '/eclairage/voies').then(function (fc) {
      cVoies.clearLayers();
      var tot = 0, ecl = 0;
      L.geoJSON(fc, { style: function (f) { return C.styleVoie(f.properties); }, onEachFeature: function (f, l) {
        var p = f.properties; tot += p.longueur_m; ecl += p.eclaire_m;
        l.bindPopup('<div class="popup"><h4>' + esc(p.nom || p.code) + '</h4><table><tr><td>Longueur</td><td>' + A.fmt(p.longueur_m) + ' m</td></tr>' +
          '<tr><td>Éclairée</td><td>' + A.fmt(p.eclaire_m) + ' m (' + (p.pct || 0) + ' %)</td></tr><tr><td>Quartier</td><td>' + esc(p.quartier || '—') + '</td></tr></table></div>');
        cVoies.addLayer(l);
      } });
      cVoies.addTo(map); cVoies.bringToFront();
      if (!silence) LabeTerrain.toast(A.fmt(ecl / 1000, 1) + ' km de rues éclairées sur ' + A.fmt(tot / 1000, 0) + ' km (' + pct(ecl, tot) + ').');
    }).catch(fail);
  }
  $('res-l-voies').onchange = function () { if (this.checked) chargerVoies(); else map.removeLayer(cVoies); };
  // couche aussi allumée depuis le panneau des couches : on la calcule à ce moment-là
  cVoies.on('add', function () { $('res-l-voies').checked = true; if (!cVoies.getLayers().length) chargerVoies(); });
  cVoies.on('remove', function () { $('res-l-voies').checked = false; });

  // ---------- Bornes-fontaines ----------
  var FB = { type: '', etat: '' };
  function rendreBornes() {
    var n = bornes.length, ok = 0, panne = 0;
    bornes.forEach(function (f) { var e = f.properties.etat; if (e === 'En service' || e === 'Débit faible') ok++; if (e === 'En panne') panne++; });
    $('res-b-cartes').innerHTML = carte(n, 'bornes et points d\'eau potable') + carte(pct(ok, n), 'donnent de l\'eau') + carte(panne, 'en panne', panne ? 'alerte' : '');
    var list = bornes.filter(function (f) { return (!FB.type || f.properties.type === FB.type) && (!FB.etat || f.properties.etat === FB.etat); });
    var ul = $('res-bornes');
    ul.innerHTML = list.length ? '' : '<li class="empty"><small>Aucune borne' + (n ? ' pour ces critères' : ' recensée : commencez par « Placer une borne-fontaine »') + '.</small></li>';
    list.forEach(function (f) {
      var p = f.properties, li = document.createElement('li');
      li.className = 'fon-li' + (p.etat === 'En panne' ? ' retard' : '');
      li.style.borderLeftColor = p.etat === 'Fermée' ? C.GRIS : C.BORNE;
      li.innerHTML = '<b>' + esc(p.numero) + '</b> · ' + esc(p.nom || p.type) + '<small>' + badge(p.etat) + ' · ' + esc(p.type) +
        (p.gestionnaire ? ' · ' + esc(p.gestionnaire) : '') + ' · ' + esc(p.quartier || '—') + (p.ouvertes ? ' · <b class="retard-txt">' + p.ouvertes + ' panne(s) en cours</b>' : '') + '</small>';
      li.onclick = function () { ouvrirBorne(p.id); };
      ul.appendChild(li);
    });
  }
  $('res-b-type').onchange = function () { FB.type = this.value; rendreBornes(); };
  $('res-b-etat').onchange = function () { FB.etat = this.value; rendreBornes(); };
  $('res-b-export').onclick = function () { telecharger('/export/bornes.csv', 'bornes_fontaines_labe.csv'); };
  function champsBorne() {
    return [{ n: 'type', l: 'Type', t: 'select', o: LISTES.types_borne, req: true }, { n: 'nom', l: 'Nom', ph: 'ex. borne du marché central' },
      { n: 'etat', l: 'État', t: 'select', o: LISTES.etats_borne, req: true, aide: '« En panne » ouvre automatiquement une panne à réparer.' },
      { n: 'gestionnaire', l: 'Gestionnaire', ph: 'SEG, commune, comité de gestion, privé…' }, { n: 'robinets', l: 'Nombre de robinets', t: 'number', min: 0 },
      { n: 'payante', l: 'Eau payante', t: 'check' }, { n: 'prix_gnf', l: 'Prix du bidon de 20 litres (GNF)', t: 'number', min: 0, step: 50 },
      { n: 'horaires', l: 'Horaires', ph: 'ex. 6 h – 12 h et 16 h – 19 h' },
      { n: 'observations', l: 'Observations', t: 'textarea' }, { n: 'photo', l: 'Photo', t: 'photo' }];
  }
  function nouvelleBorne(ll) {
    L.circleMarker(ll, { radius: 14, color: '#f2c230', weight: 4, fill: false }).addTo(apercu);
    formulaire('Nouvelle borne-fontaine', champsBorne(), { type: 'Borne-fontaine', etat: 'En service', payante: true }, function (v) {
      v.geometry = point(ll); v.uid = LabeTerrain.uuid();
      return avecDoublon(function (forcer) { v.forcer = forcer; return envoyer('POST', '/bornes', v); })
        .then(function (r) { if (!map.hasLayer(cBorne)) cBorne.addTo(map); return apresEnvoi(r, ouvrirBorne); });
    });
  }
  $('res-b-point').onclick = function () { A.startSketch('point', { btn: this, label: 'Borne-fontaine', onFinish: function (pts) { nouvelleBorne(pts[0]); } }); };
  $('res-b-gps').onclick = function () { LabeTerrain.pointGps(nouvelleBorne); };
  function ouvrirBorne(id) {
    api('GET', '/bornes/' + id).then(function (f) {
      var p = f.properties, d = document.createElement('div');
      d.innerHTML = '<h3>' + esc(p.numero) + ' — ' + esc(p.nom || p.type) + '</h3><p>' + badge(p.etat) + '</p>' +
        table([['Type', p.type], ['Quartier', p.quartier], ['Gestionnaire', p.gestionnaire], ['Robinets', p.robinets],
          ['Eau payante', p.payante ? 'oui' : 'non'], ['Prix du bidon (20 l)', p.prix_gnf ? A.fmt(p.prix_gnf) + ' GNF' : null], ['Horaires', p.horaires],
          ['Dernier constat', dateFr(p.dernier_constat)], ['Observations', p.observations], ['Recensée par', p.cree_par_nom]]);
      photoFiche(d, p.photo_url);
      var bar = document.createElement('div'); bar.className = 'row';
      btn(bar, 'Signaler une panne ou une fuite', 'primary', function () { nouvelleIntervention('Eau', null, { borne: p.id, numero: p.numero }); });
      if (f.peut_modifier) {
        btn(bar, 'Modifier', '', function () {
          formulaire('Modifier ' + p.numero, champsBorne(), p, function (v) {
            return api('PUT', '/bornes/' + p.id, v).then(function () { return charger().then(function () { ouvrirBorne(p.id); }); });
          });
        });
        btn(bar, 'Déplacer', '', function () { deplacer('bornes', p, ouvrirBorne); });
        btn(bar, 'Supprimer', 'danger', function () {
          if (confirm('Supprimer ' + p.numero + ' ?')) api('DELETE', '/bornes/' + p.id).then(function () { fermerFiche(); charger(); }).catch(fail);
        });
      }
      if (A.itineraire) btn(bar, 'Itinéraire jusqu\'ici', '', function () {
        A.itineraire.ajouter(L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]), p.nom || p.numero, 'end');
      });
      d.appendChild(bar);
      var h = document.createElement('div'); h.innerHTML = listeInterventions(f.interventions); d.appendChild(h); activerInterventions(h);
      montrerFiche(d);
      surligner(f.geometry);
    }).catch(fail);
  }
  function chargerLoin(silence) {
    return api('GET', '/eau/non-desservis').then(function (pts) {
      cLoin.clearLayers();
      pts.forEach(function (c) {
        L.circleMarker([c[1], c[0]], { renderer: rendu, radius: 3, stroke: false, fillColor: C.ALERTE, fillOpacity: 0.85, interactive: false }).addTo(cLoin);
      });
      cLoin.addTo(map);
      if (!silence) LabeTerrain.toast(A.fmt(pts.length) + ' bâtiment(s) à plus de ' + param('distance_borne_m') + ' m d\'une borne en service, en rouge sur la carte.');
    }).catch(fail);
  }
  $('res-b-loin').onchange = function () { if (this.checked) chargerLoin(); else map.removeLayer(cLoin); };

  // ---------- Pannes et fuites ----------
  var FI = { statut: '', reseau: '', retard: false };
  function rendreInterventions() {
    var list = interventions.filter(function (f) {
      var p = f.properties;
      if (FI.statut === '' ? OUVERTES.indexOf(p.statut) < 0 : FI.statut !== 'tous' && p.statut !== FI.statut) return false;
      if (FI.reseau && p.reseau !== FI.reseau) return false;
      return !FI.retard || p.en_retard;
    });
    var ul = $('res-interventions');
    ul.innerHTML = list.length ? '' : '<li class="empty"><small>Aucune panne ni fuite pour ces critères.</small></li>';
    list.slice(0, 300).forEach(function (f) {
      var p = f.properties, li = document.createElement('li');
      li.className = 'fon-dossier' + (p.en_retard ? ' retard' : '');
      li.innerHTML = '<b>' + esc(p.numero) + ' — ' + esc(p.nature) + '</b><small>' + (p.reseau === 'Eau' ? '💧 ' : '💡 ') + esc(p.quartier || '—') + ' · ' + badge(p.statut) +
        (p.urgence === 'Urgente' ? ' ' + badge('Urgente') : '') + (p.equipement ? ' · ' + esc(p.equipement) : '') + (p.transmise_a ? ' · ' + esc(p.transmise_a) : '') +
        ' · ' + dateFr(p.cree_le) + (p.en_retard ? ' · <b class="retard-txt">délai dépassé</b>' : '') + '</small>';
      li.onclick = function () { ouvrirIntervention(p.id); };
      ul.appendChild(li);
    });
  }
  $('res-p-statut').onchange = function () { FI.statut = this.value; rendreInterventions(); };
  $('res-p-reseau').onchange = function () { FI.reseau = this.value; rendreInterventions(); };
  $('res-p-retard').onchange = function () { FI.retard = this.checked; rendreInterventions(); };
  $('res-p-export').onclick = function () { telecharger('/export/interventions.csv', 'pannes_fuites_labe.csv'); };
  // reseau : 'Éclairage', 'Eau' ou null (les deux) ; ll : position ; eq : { lampadaire|borne, numero }
  function nouvelleIntervention(reseau, ll, eq) {
    var res = reseau ? [reseau] : ['Éclairage', 'Eau'], options = [];
    res.forEach(function (r) { LISTES.natures[r].forEach(function (n) { options.push(reseau ? n : r + ' — ' + n); }); });
    if (ll) L.circleMarker(ll, { radius: 14, color: '#f2c230', weight: 4, fill: false }).addTo(apercu);
    var titre = (reseau === 'Éclairage' ? 'Panne d\'éclairage' : reseau === 'Eau' ? 'Fuite ou panne d\'eau' : 'Panne ou fuite') + (eq ? ' — ' + eq.numero : '');
    formulaire(titre, [{ n: 'nature', l: 'Nature', t: 'select', o: options, req: true },
      { n: 'urgence', l: 'Urgence', t: 'select', o: LISTES.urgences, aide: 'Urgente : câble à nu, poteau tombé, grosse fuite, quartier sans eau…' },
      { n: 'description', l: 'Description', t: 'textarea', ph: 'depuis quand, ce qui a été vu…' }, { n: 'photo', l: 'Photo', t: 'photo' }],
    { urgence: 'Normale' }, function (v) {
      var body = { reseau: reseau, nature: v.nature, urgence: v.urgence || 'Normale', description: v.description, photo: v.photo, uid: LabeTerrain.uuid() };
      if (!reseau) { var x = v.nature.split(' — '); body.reseau = x[0]; body.nature = x.slice(1).join(' — '); }
      if (eq && eq.lampadaire) body.lampadaire = eq.lampadaire;
      if (eq && eq.borne) body.borne = eq.borne;
      if (ll) body.geometry = point(ll);
      return envoyer('POST', '/interventions', body).then(function (r) { if (!map.hasLayer(cInter)) cInter.addTo(map); return apresEnvoi(r, ouvrirIntervention); });
    });
  }
  $('res-p-eclairage').onclick = function () { A.startSketch('point', { btn: this, label: 'Panne d\'éclairage', onFinish: function (pts) { nouvelleIntervention('Éclairage', pts[0]); } }); };
  $('res-p-eau').onclick = function () { A.startSketch('point', { btn: this, label: 'Fuite ou panne d\'eau', onFinish: function (pts) { nouvelleIntervention('Eau', pts[0]); } }); };
  $('res-p-gps').onclick = function () { LabeTerrain.pointGps(function (ll) { nouvelleIntervention(null, ll); }); };
  function rendreSignalements() {
    var div = $('res-signalements');
    if (!gerer() || !signalements.length) { div.innerHTML = ''; return; }
    div.innerHTML = '<details class="adr-detail" open><summary>Signalements à prendre en charge : <b>' + signalements.length + '</b></summary><ul class="fon-ctl" id="res-sig"></ul></details>';
    signalements.forEach(function (s) {
      var li = document.createElement('li');
      li.innerHTML = '<b>' + esc(s.type) + '</b> ' + esc(s.nom || '') + ' <small>n° ' + s.id + ' · ' + esc(s.quartier || '—') + ' · ' + dateFr(s.cree_le) + ' · ' +
        esc(s.auteur || '') + (s.description ? '<br>' + esc(s.description) : '') + '</small>';
      var bar = document.createElement('div'); bar.className = 'row';
      btn(bar, 'Voir', '', function () { surligner(s.geometry); });
      btn(bar, 'Ouvrir une intervention', 'primary', function () {
        api('POST', '/signalements/' + s.id + '/convertir').then(function (f) { return apresEnvoi(f, ouvrirIntervention); }).catch(fail);
      });
      li.appendChild(bar);
      $('res-sig').appendChild(li);
    });
  }

  var ACTIONS = [
    { a: 'transmettre', l: 'Transmettre', de: ['Signalée', 'En réparation'], g: true, champs: ['transmise_a', 'commentaire'] },
    { a: 'commencer', l: 'Réparation en cours', de: ['Signalée', 'Transmise'], g: true, champs: ['commentaire'] },
    { a: 'reparer', l: 'Réparée', de: OUVERTES, g: true, champs: ['cout_gnf', 'commentaire', 'photo'] },
    { a: 'classer', l: 'Classer sans suite', de: OUVERTES, g: true, champs: ['commentaire!'] },
    { a: 'rouvrir', l: 'Rouvrir', de: ['Réparée', 'Classée sans suite'], g: true, champs: ['commentaire'] },
    { a: 'commenter', l: 'Commenter', de: null, g: false, champs: ['commentaire', 'photo'] }
  ];
  var CHAMPS_ACTION = {
    transmise_a: { n: 'transmise_a', l: 'Transmise à', req: true, ph: 'EDG, SEG, entreprise, équipe municipale…' },
    cout_gnf: { n: 'cout_gnf', l: 'Coût de la réparation (GNF)', t: 'number', min: 0, step: 1000 },
    commentaire: { n: 'commentaire', l: 'Commentaire', t: 'textarea' },
    photo: { n: 'photo', l: 'Photo', t: 'photo' }
  };
  function ouvrirIntervention(id) {
    api('GET', '/interventions/' + id).then(function (f) {
      var p = f.properties, d = document.createElement('div');
      var delai = param(p.reseau === 'Éclairage' ? 'delai_panne_j' : 'delai_fuite_j');
      d.innerHTML = '<h3>' + esc(p.numero) + ' — ' + esc(p.nature) + '</h3><p>' + badge(p.statut) + (p.urgence === 'Urgente' ? ' ' + badge('Urgente') : '') +
        (p.en_retard ? ' <b class="retard-txt">délai de ' + delai + ' jours dépassé</b>' : '') + '</p>' +
        table([['Réseau', p.reseau], ['Équipement', p.equipement ? '<a href="#" id="res-eq">' + esc(p.equipement) + '</a>' : null, true],
          ['Description', p.description], ['Quartier', p.quartier], ['Transmise à', p.transmise_a],
          ['Coût', p.cout_gnf ? A.fmt(p.cout_gnf) + ' GNF' : null], ['Signalée le', dateFr(p.cree_le) + (p.cree_par_nom ? ' par ' + p.cree_par_nom : '')],
          ['Réparée le', dateFr(p.repare_le)], ['Signalement d\'origine', p.contribution ? 'n° ' + p.contribution : null]]);
      photoFiche(d, p.photo_url);
      var bar = document.createElement('div'); bar.className = 'row';
      ACTIONS.forEach(function (x) {
        if (x.g && !f.peut_gerer) return;
        if (x.de && x.de.indexOf(p.statut) < 0) return;
        btn(bar, x.l, x.a === 'commenter' ? '' : 'primary', function () {
          var champs = x.champs.map(function (c) { var o = Object.assign({}, CHAMPS_ACTION[c.replace('!', '')]); if (c.slice(-1) === '!') o.req = true; return o; });
          formulaire(x.l + ' — ' + p.numero, champs, { transmise_a: p.transmise_a || (p.reseau === 'Eau' ? 'SEG' : '') }, function (v) {
            v.action = x.a;
            return api('POST', '/interventions/' + p.id + '/action', v).then(function () { return charger().then(function () { ouvrirIntervention(p.id); }); });
          });
        });
      });
      if (f.peut_gerer && OUVERTES.indexOf(p.statut) >= 0) btn(bar, p.urgence === 'Urgente' ? 'Rendre normale' : 'Rendre urgente', '', function () {
        api('POST', '/interventions/' + p.id + '/action', { action: 'commenter', urgence: p.urgence === 'Urgente' ? 'Normale' : 'Urgente',
          commentaire: p.urgence === 'Urgente' ? 'urgence levée' : 'passée en urgence' })
          .then(function () { return charger().then(function () { ouvrirIntervention(p.id); }); }).catch(fail);
      });
      if (A.itineraire) btn(bar, 'Itinéraire jusqu\'ici', '', function () {
        A.itineraire.ajouter(L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]), p.numero, 'end');
      });
      if (!p.contribution && (f.peut_gerer || (p.cree_par === Auth.user().id && p.statut === 'Signalée'))) btn(bar, 'Supprimer', 'danger', function () {
        if (confirm('Supprimer ' + p.numero + ' ?')) api('DELETE', '/interventions/' + p.id).then(function () { fermerFiche(); charger(); }).catch(fail);
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
      var lien = $('res-eq');
      if (lien) lien.onclick = function (e) { e.preventDefault(); if (p.lampadaire) ouvrirLampadaire(p.lampadaire); else ouvrirBorne(p.borne); };
      surligner(f.geometry);
    }).catch(fail);
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
  function tableEtats(rows, cle) {
    return rows.length ? '<table class="info-table fon-table">' + rows.map(function (x) {
      return '<tr><td>' + esc(x[cle]) + '</td><td>' + badge(x.etat) + '</td><td>' + x.n + '</td></tr>'; }).join('') + '</table>' : '<p class="hint">Aucun recensement.</p>';
  }
  function chargerBilan() {
    var div = $('res-bilan');
    api('GET', '/bilan').then(function (b) {
      var e = b.reseaux['Éclairage'] || { ouvertes: 0, en_retard: 0, delai_j: null, reparees: 0, cout: 0 };
      var o = b.reseaux['Eau'] || { ouvertes: 0, en_retard: 0, delai_j: null, reparees: 0, cout: 0 };
      var km = b.eclairage.reduce(function (s, x) { return s + x.km; }, 0), kme = b.eclairage.reduce(function (s, x) { return s + x.km_eclaires; }, 0);
      var bat = b.eau.reduce(function (s, x) { return s + x.batiments; }, 0), des = b.eau.reduce(function (s, x) { return s + x.desservis; }, 0);
      var html = '<div class="stat-cards">' + carte(pct(kme, km), 'des rues éclairées (' + A.fmt(kme, 1) + ' km)') +
        carte(e.ouvertes, 'pannes d\'éclairage en cours', e.ouvertes ? 'alerte' : '') +
        carte(e.delai_j != null ? A.fmt(e.delai_j, 1) + ' j' : '—', 'délai moyen de réparation (éclairage)') +
        carte(pct(des, bat), 'des bâtiments à moins de ' + param('distance_borne_m') + ' m d\'une borne') +
        carte(o.ouvertes, 'fuites et pannes d\'eau en cours', o.ouvertes ? 'alerte' : '') +
        carte(o.delai_j != null ? A.fmt(o.delai_j, 1) + ' j' : '—', 'délai moyen de réparation (eau)') +
        carte(e.en_retard + o.en_retard, 'en retard sur le délai visé', e.en_retard + o.en_retard ? 'alerte' : '') +
        carte(A.fmt(e.cout + o.cout), 'GNF dépensés en réparations') + '</div>';
      html += '<h4>Éclairage des rues par quartier</h4><p class="hint">Part de la longueur des rues à moins de ' + param('portee_lampadaire_m') +
        ' m d\'un lampadaire en service (les moins éclairés en premier).</p>' +
        barres(b.eclairage.filter(function (x) { return x.km > 0; }), function (x) { return x.pct; }, function (x) { return x.quartier; },
          function (x) { return A.fmt(x.pct, 1) + ' % · ' + x.n + ' lampadaire(s)' + (x.en_panne ? ', ' + x.en_panne + ' en panne' : ''); });
      html += '<h4>Accès à l\'eau par quartier</h4><p class="hint">Bâtiments à moins de ' + param('distance_borne_m') + ' m d\'une borne qui donne de l\'eau (les moins desservis en premier).</p>' +
        barres(b.eau.filter(function (x) { return x.batiments > 0; }), function (x) { return x.pct; }, function (x) { return x.quartier; },
          function (x) { return A.fmt(x.pct, 1) + ' % · ' + x.bornes + ' borne(s)'; });
      html += '<div class="row"><button type="button" id="res-b-q">Tableau par quartier (CSV, Excel)</button></div>';
      html += '<h4>Pannes et fuites par nature (en cours / total)</h4>' + (b.natures.length ? barres(b.natures, function (x) { return x.total; },
        function (x) { return (x.reseau === 'Eau' ? '💧 ' : '💡 ') + x.nature; }, function (x) { return x.ouvertes + ' / ' + x.total; }) : '<p class="hint">Aucune panne enregistrée.</p>');
      if (b.quartiers.length) html += '<h4>Pannes et fuites en cours par quartier</h4>' + barres(b.quartiers.slice(0, 15), function (x) { return x.n; }, function (x) { return x.quartier; });
      html += '<p class="hint">Pannes et fuites signalées par mois (12 derniers mois) :</p>' + colonnes(b.mois, 'Pannes et fuites signalées par mois');
      html += '<h4>Lampadaires</h4>' + tableEtats(b.lampadaires, 'alimentation') + '<h4>Bornes-fontaines</h4>' + tableEtats(b.bornes, 'type');
      div.innerHTML = html;
      $('res-b-q').onclick = function () { telecharger('/export/quartiers.csv', 'reseaux_quartiers_labe.csv'); };
    }).catch(function (e) { div.innerHTML = '<p class="form-msg">' + esc(e.message) + '</p>'; });
    rendreParametres();
  }
  var LIB_PARAM = { portee_lampadaire_m: 'Portée d\'un lampadaire (m)', distance_borne_m: 'Distance maximale à une borne (m)',
    delai_panne_j: 'Délai visé, panne d\'éclairage (jours)', delai_fuite_j: 'Délai visé, fuite ou borne (jours)' };
  function rendreParametres() {
    var div = $('res-parametres');
    div.innerHTML = '<table class="info-table">' + LISTES.parametres.map(function (x) {
      return '<tr><td title="' + esc(x.description) + '">' + esc(LIB_PARAM[x.cle] || x.cle) + '</td><td>' +
        (gerer() ? '<input type="number" min="0" step="any" data-k="' + esc(x.cle) + '" value="' + x.valeur + '" style="width:80px">' : A.fmt(x.valeur, 1)) + '</td></tr>';
    }).join('') + '</table>' + (gerer() ? '<div class="row"><button type="button" id="res-param-ok">Enregistrer les paramètres</button></div>' : '');
    if ($('res-param-ok')) $('res-param-ok').onclick = function () {
      Promise.all(Array.prototype.map.call(div.querySelectorAll('[data-k]'), function (inp) {
        return api('PUT', '/parametres/' + inp.dataset.k, { valeur: parseFloat(inp.value) || 0 });
      })).then(function () { return api('GET', '/listes'); }).then(function (l) { LISTES = l; LabeTerrain.toast('Paramètres enregistrés.'); chargerBilan(); charger(); }).catch(fail);
    };
  }

  // ---------- Tables attributaires ----------
  function tableDe(liste, cle, info) {
    return function () {
      return liste().map(function (f) { var x = parId[cle][f.id]; return { layer: x && x.l, feature: { type: 'Feature', geometry: f.geometry, properties: info(f.properties) } }; });
    };
  }

  // ---------- Démarrage ----------
  function start() {
    api('GET', '/listes').then(function (l) {
      LISTES = l;
      remplir($('res-l-etat'), l.etats_lampadaire, 'Tous les états'); remplir($('res-l-alim'), l.alimentations, 'Toutes les alimentations');
      remplir($('res-b-type'), l.types_borne, 'Tous les types'); remplir($('res-b-etat'), l.etats_borne, 'Tous les états');
      remplir($('res-p-statut'), l.statuts); $('res-p-statut').insertBefore(new Option('En cours', ''), $('res-p-statut').firstChild);
      $('res-p-statut').add(new Option('Toutes', 'tous')); $('res-p-statut').value = '';
      A.ready.then(function () {
        var G = 'Réseaux';
        [[cLamp, 'Éclairage public'], [cBorne, 'Bornes-fontaines'], [cInter, 'Pannes et fuites en cours']]
          .forEach(function (x) { A.enregistrerIdentifiable(x[0], x[1]); });
        A.addOverlay({ name: 'Éclairage public', layer: cLamp, on: true, group: G, table: tableDe(function () { return lampadaires; }, 'lp', infoLampadaire),
          swatch: '<span class="swatch dot" style="background:' + C.LUMIERE + '"></span>', legend: C.LEGENDE_LAMPADAIRES });
        A.addOverlay({ name: 'Bornes-fontaines', layer: cBorne, on: true, group: G, table: tableDe(function () { return bornes; }, 'bf', infoBorne),
          swatch: '<span class="swatch dot" style="background:' + C.BORNE + '"></span>', legend: C.LEGENDE_BORNES });
        A.addOverlay({ name: 'Pannes et fuites en cours', layer: cInter, on: true, group: G,
          table: tableDe(function () { return interventions.filter(function (f) { return OUVERTES.indexOf(f.properties.statut) >= 0; }); }, 'in', infoIntervention),
          swatch: '<span class="swatch" style="background:' + C.PANNE + '"></span>',
          legend: [['P panne d\'éclairage · F fuite ou panne d\'eau', C.PANNE], ['Urgente (anneau rouge)', C.ALERTE], ['Délai dépassé (bord rouge en tirets)', C.ALERTE, 'line']] });
        A.addOverlay({ name: 'Rues éclairées', layer: cVoies, on: false, group: G, swatch: '<span class="swatch" style="background:' + C.LUMIERE + '"></span>',
          legend: C.LEGENDE_VOIES });
      });
      return charger();
    }).catch(fail);
  }
  var fileDiv = null;
  window.LabeReseaux = {
    start: start, recharger: function () { if (LISTES) charger(); }, ouvrirIntervention: ouvrirIntervention, sousOnglet: sousOnglet,
    file: function (n) {   // saisies de terrain en attente de réseau (file partagée avec les déchets)
      if (!fileDiv) { fileDiv = document.createElement('p'); fileDiv.className = 'fon-avert'; $('res-liste-vue').insertBefore(fileDiv, $('res-liste-vue').children[1]); }
      fileDiv.textContent = '📶 ' + n + ' saisie(s) en attente de réseau, envoyée(s) automatiquement.';
      fileDiv.classList.toggle('hidden', !n);
    }
  };
})();
