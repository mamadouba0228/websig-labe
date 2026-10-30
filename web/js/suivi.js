/* Suivi des signalements (espace agents) : tableau de bord, liste à traiter, fiche avec historique,
 * circuit « validé → affecté à un service → en cours → traité », indicateurs par service et points chauds. */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc;
  var STATUTS = ['À valider', 'Validé', 'Affecté', 'En cours', 'Traité', 'Rejeté'];
  var OUVERTS = ['À valider', 'Validé', 'Affecté', 'En cours'];
  var PRIORITE_RANG = { Urgente: 0, Haute: 1, Normale: 2, Basse: 3 };
  // points chauds : une teinte, du clair (peu) au foncé (beaucoup)
  var ROUGES = ['#ffe3e3', '#ffa8a8', '#fa5252', '#c92a2a', '#7d1a1a'];
  var CELLULE_M = 250, KX = 111320 * Math.cos(11.32 * Math.PI / 180), KY = 110574;

  function $(id) { return document.getElementById(id); }
  function cls(statut) { return 's-' + String(statut).replace(/\s/g, '-'); }
  function jours(d1, d2) { return (new Date(d2 || Date.now()) - new Date(d1)) / 86400000; }
  function aujourdhui() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function enRetard(p) { return p.echeance && OUVERTS.indexOf(p.statut) >= 0 && new Date(p.echeance) < aujourdhui(); }
  function age(d) {
    var j = Math.floor(jours(d));
    return j < 1 ? 'aujourd\'hui' : j === 1 ? 'hier' : 'il y a ' + j + ' j';
  }
  function fmtJ(n) { return n == null || isNaN(n) ? '—' : A.fmt(n, 1) + ' j'; }
  function fail(e) { alert('Erreur : ' + e.message); }
  function rangP(p) { return p.priorite in PRIORITE_RANG ? PRIORITE_RANG[p.priorite] : 2; }
  function monService(p) { return Auth.user() && p.service_affecte === Auth.user().service; }

  var tous = [], services = [];
  Auth.api('GET', '/services').then(function (l) { services = l; remplirServices(); }).catch(function () {});

  // ---------- Filtres ----------
  var F = { statut: '', service: '', quartier: '', type: '', retard: false, mien: false };
  function signalements() { return tous.filter(function (f) { return f.properties.categorie === 'Signalement'; }); }
  function filtre(list, ignorerStatut) {
    return list.filter(function (f) {
      var p = f.properties;
      if (!ignorerStatut) {
        if (F.statut === '' && OUVERTS.indexOf(p.statut) < 0) return false;
        if (F.statut && F.statut !== 'tous' && p.statut !== F.statut) return false;
        if (F.retard && !enRetard(p)) return false;
      }
      return (!F.service || p.service_affecte === F.service) && (!F.quartier || p.quartier === F.quartier) &&
        (!F.type || p.type === F.type) && (!F.mien || monService(p));
    });
  }
  function remplirServices() {
    var sel = $('suivi-service'), cur = sel.value;
    sel.innerHTML = '<option value="">Tous les services</option>';
    services.forEach(function (s) { sel.add(new Option(s, s, false, s === cur)); });
  }
  function remplir(sel, valeurs, vide) {
    var cur = sel.value;
    sel.innerHTML = '<option value="">' + vide + '</option>';
    valeurs.forEach(function (v) { sel.add(new Option(v, v, false, v === cur)); });
  }
  [['statut', 'suivi-statut'], ['service', 'suivi-service'], ['quartier', 'suivi-quartier'], ['type', 'suivi-type']].forEach(function (x) {
    $(x[1]).addEventListener('change', function () { F[x[0]] = $(x[1]).value; rendre(); });
  });
  $('suivi-retard').addEventListener('change', function () { F.retard = this.checked; rendre(); });
  $('suivi-mien').addEventListener('change', function () { F.mien = this.checked; rendre(); });

  // ---------- Tableau de bord et liste ----------
  function rendre() {
    var sig = signalements();
    var types = {}, quartiers = {};
    sig.forEach(function (f) { types[f.properties.type] = 1; if (f.properties.quartier) quartiers[f.properties.quartier] = 1; });
    remplir($('suivi-type'), Object.keys(types).sort(), 'Tous les types');
    remplir($('suivi-quartier'), Object.keys(quartiers).sort(), 'Tous les quartiers');

    // cartes de synthèse
    var n = {}, retard = 0, traites30 = [], d30 = Date.now() - 30 * 86400000;
    STATUTS.forEach(function (s) { n[s] = 0; });
    sig.forEach(function (f) {
      var p = f.properties; n[p.statut]++;
      if (enRetard(p)) retard++;
      if (p.statut === 'Traité' && p.traite_le && new Date(p.traite_le) > d30) traites30.push(jours(p.cree_le, p.traite_le));
    });
    var moy = traites30.length ? traites30.reduce(function (s, x) { return s + x; }, 0) / traites30.length : null;
    $('suivi-cartes').innerHTML =
      carte(n['À valider'], 'nouveaux à valider', 'statut', 'À valider') +
      carte(n['Validé'] + n['Affecté'], 'à prendre en charge', 'statut', 'Affecté') +
      carte(n['En cours'], 'en cours', 'statut', 'En cours') +
      carte(retard, 'en retard', 'retard', '1', retard ? 'alerte' : '') +
      carte(traites30.length, 'traités en 30 jours', 'statut', 'Traité') +
      '<div class="stat-card"><b>' + fmtJ(moy) + '</b><span>délai moyen de traitement (30 j)</span></div>';
    $('suivi-cartes').querySelectorAll('[data-f]').forEach(function (c) {
      c.onclick = function () {
        F.retard = c.dataset.f === 'retard'; $('suivi-retard').checked = F.retard;
        F.statut = c.dataset.f === 'statut' ? c.dataset.v : 'tous'; $('suivi-statut').value = F.statut;
        rendre();
      };
    });

    // liste : en retard d'abord, puis priorité, puis ancienneté
    var list = filtre(sig).sort(function (a, b) {
      var p = a.properties, q = b.properties;
      return (enRetard(q) - enRetard(p)) || (rangP(p) - rangP(q)) ||
        (new Date(p.cree_le) - new Date(q.cree_le));
    });
    var ul = $('suivi-liste');
    ul.innerHTML = list.length ? '' : '<li class="empty"><small>Aucun signalement pour ces critères.</small></li>';
    list.slice(0, 200).forEach(function (f) {
      var p = f.properties, li = document.createElement('li');
      li.className = cls(p.statut) + (enRetard(p) ? ' retard' : '');
      li.innerHTML = '<b>' + esc(p.type) + (p.nom ? ' — ' + esc(p.nom) : '') + '</b>' +
        '<small>' + esc(p.quartier || '—') + ' · ' + age(p.cree_le) + ' · <span class="badge ' + cls(p.statut) + '">' + esc(p.statut) + '</span>' +
        (p.priorite && p.priorite !== 'Normale' ? ' <span class="prio prio-' + p.priorite + '">' + esc(p.priorite) + '</span>' : '') +
        (p.service_affecte ? '<br>→ ' + esc(p.service_affecte) : '') +
        (p.echeance ? ' · échéance ' + new Date(p.echeance).toLocaleDateString('fr-FR') + (enRetard(p) ? ' <b class="retard-txt">en retard</b>' : '') : '') + '</small>';
      li.onclick = function () { ouvrir(p.id); };
      ul.appendChild(li);
    });

    indicateurs(sig);
    if ($('suivi-chaleur').checked) pointsChauds();
    // badge de l'onglet : ce qui attend une action de l'utilisateur
    var aFaire = sig.filter(function (f) {
      var p = f.properties;
      return Auth.isValidator() ? (p.statut === 'À valider' || p.statut === 'Validé') : (monService(p) && (p.statut === 'Affecté' || p.statut === 'En cours'));
    }).length;
    $('suivi-badge').textContent = aFaire;
    $('suivi-badge').classList.toggle('hidden', !aFaire);
  }
  function carte(v, lib, f, val, extra) {
    return '<div class="stat-card cliquable ' + (extra || '') + '" data-f="' + f + '" data-v="' + esc(val) + '"><b>' + A.fmt(v) + '</b><span>' + lib + '</span></div>';
  }

  function indicateurs(sig) {
    var par = {};
    sig.forEach(function (f) {
      var p = f.properties, s = p.service_affecte;
      if (!s) return;
      var x = par[s] || (par[s] = { aff: 0, cours: 0, trait: 0, retard: 0, delais: [] });
      if (p.statut === 'Affecté') x.aff++;
      if (p.statut === 'En cours') x.cours++;
      if (p.statut === 'Traité') { x.trait++; if (p.traite_le) x.delais.push(jours(p.cree_le, p.traite_le)); }
      if (enRetard(p)) x.retard++;
    });
    var noms = Object.keys(par).sort();
    $('suivi-indic').innerHTML = !noms.length ? '<p class="hint">Aucun signalement affecté pour l\'instant.</p>' :
      '<table class="ana-table"><thead><tr><th>Service</th><th>À prendre</th><th>En cours</th><th>Traités</th><th>Délai moyen</th><th>En retard</th></tr></thead><tbody>' +
      noms.map(function (s) {
        var x = par[s], moy = x.delais.length ? x.delais.reduce(function (a, b) { return a + b; }, 0) / x.delais.length : null;
        return '<tr><td>' + esc(s) + '</td><td>' + x.aff + '</td><td>' + x.cours + '</td><td>' + x.trait + '</td><td>' + fmtJ(moy) + '</td><td>' +
          (x.retard ? '<b class="retard-txt">' + x.retard + '</b>' : '0') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  // ---------- Points chauds : signalements par maille de 250 m ----------
  var chaleur = L.featureGroup();
  function pointsChauds() {
    chaleur.clearLayers();
    var cells = {}, max = 0;
    filtre(signalements(), true).forEach(function (f) {
      var g = f.geometry, c = g.type === 'Point' ? g.coordinates : g.type === 'LineString' ? g.coordinates[0] : g.coordinates[0][0];
      var i = Math.floor(c[0] * KX / CELLULE_M), j = Math.floor(c[1] * KY / CELLULE_M), k = i + ':' + j;
      var x = cells[k] || (cells[k] = { i: i, j: j, n: 0, types: {} });
      x.n++; x.types[f.properties.type] = (x.types[f.properties.type] || 0) + 1;
      if (x.n > max) max = x.n;
    });
    var seuils = classes(max);
    Object.keys(cells).forEach(function (k) {
      var x = cells[k], cl = 0;
      while (cl < seuils.length - 1 && x.n > seuils[cl][1]) cl++;
      var b = [[x.j * CELLULE_M / KY, x.i * CELLULE_M / KX], [(x.j + 1) * CELLULE_M / KY, (x.i + 1) * CELLULE_M / KX]];
      var detail = Object.keys(x.types).sort(function (a, c) { return x.types[c] - x.types[a]; })
        .map(function (t) { return esc(t) + ' : ' + x.types[t]; }).join('<br>');
      L.rectangle(b, { color: '#fff', weight: 1, fillColor: ROUGES[cl], fillOpacity: 0.75, interactive: true })
        .bindTooltip('<b>' + x.n + ' signalement(s)</b> sur 250 m × 250 m<br>' + detail, { sticky: true }).addTo(chaleur);
    });
    chaleur.addTo(map);
    $('suivi-legende').innerHTML = !max ? '<p class="hint">Aucun signalement pour ces critères.</p>' :
      '<div class="legende-chaleur">' + seuils.map(function (s, k) {
        return '<span><i style="background:' + ROUGES[k] + '"></i>' + (s[0] === s[1] ? s[0] : s[0] + '–' + s[1]) + '</span>';
      }).join('') + '<small>signalements par maille de 250 m (critères de la liste, tous statuts)</small></div>';
    // par quartier
    var parQ = {};
    filtre(signalements(), true).forEach(function (f) { var q = f.properties.quartier || '—'; parQ[q] = (parQ[q] || 0) + 1; });
    var qs = Object.keys(parQ).sort(function (a, b) { return parQ[b] - parQ[a]; }).slice(0, 10), qmax = qs.length ? parQ[qs[0]] : 1;
    $('suivi-quartiers').innerHTML = qs.map(function (q) {
      return '<div class="bar-row"><span>' + esc(q) + '</span><div class="bar"><div style="width:' + (100 * parQ[q] / qmax) + '%;background:#c92a2a"></div></div><b>' + parQ[q] + '</b></div>';
    }).join('');
  }
  // jusqu'à 5 classes d'effectifs (1 ; 2 ; 3–4 ; …) selon le maximum
  function classes(max) {
    if (max <= 5) { var r = []; for (var k = 1; k <= Math.max(max, 1); k++) r.push([k, k]); return r; }
    var b = [1, Math.ceil(max * 0.15), Math.ceil(max * 0.35), Math.ceil(max * 0.6), max], out = [], prev = 0;
    b.forEach(function (x) { if (x > prev) { out.push([prev + 1, x]); prev = x; } });
    return out;
  }
  $('suivi-chaleur').addEventListener('change', function () {
    if (this.checked) pointsChauds(); else { map.removeLayer(chaleur); $('suivi-legende').innerHTML = ''; $('suivi-quartiers').innerHTML = ''; }
  });

  // ---------- Fiche d'un signalement (ou historique d'une saisie) ----------
  var courant = null;
  function ouvrir(id) {
    document.querySelector('.tab[data-tab="suivi"]').click();
    document.body.classList.remove('collapsed');   // sur téléphone, le panneau est replié par défaut
    $('suivi-liste-vue').classList.add('hidden');
    $('suivi-fiche-vue').classList.remove('hidden');
    courant = id;
    var f = tous.filter(function (x) { return x.properties.id === id; })[0];
    if (!f) { $('suivi-fiche').innerHTML = '<p class="hint">Saisie introuvable.</p>'; return; }
    LabeContrib.focus(id);
    var p = f.properties;
    var lignes = [['Catégorie', p.categorie], ['Quartier', p.quartier], ['Signalé par', p.auteur + (p.service ? ' (' + p.service + ')' : '')],
      ['Le', new Date(p.cree_le).toLocaleString('fr-FR') + ' (' + age(p.cree_le) + ')'], ['Description', p.description],
      ['Service chargé', p.service_affecte], ['Priorité', p.priorite],
      ['Échéance', p.echeance && new Date(p.echeance).toLocaleDateString('fr-FR') + (enRetard(p) ? ' — en retard' : '')],
      ['Traité le', p.traite_le && new Date(p.traite_le).toLocaleString('fr-FR') + ' (en ' + fmtJ(jours(p.cree_le, p.traite_le)) + ')'],
      ['Motif du rejet', p.motif_rejet]].filter(function (r) { return r[1]; });
    $('suivi-fiche').innerHTML = '<h3>' + esc(p.type || p.categorie) + (p.nom ? ' — ' + esc(p.nom) : '') + ' <small class="muted">n° ' + p.id + '</small></h3>' +
      '<span class="badge ' + cls(p.statut) + '">' + esc(p.statut) + '</span>' +
      (p.photo_url ? '<div id="suivi-photo" class="suivi-photo"></div>' : '') +
      '<table class="info-table">' + lignes.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>' +
      '<div id="suivi-actions" class="row"></div><div id="suivi-form"></div>' +
      '<h3>Historique</h3><ol id="suivi-histo" class="histo"><li class="hint">Chargement…</li></ol>' +
      '<h3>Ajouter un commentaire</h3><form id="suivi-com" class="stack"><textarea name="c" rows="2" maxlength="1000" placeholder="Information, rendez-vous, matériel nécessaire…"></textarea>' +
      '<label class="hint">Photo <input name="photo" type="file" accept="image/*" capture="environment"></label><button class="primary" type="submit">Envoyer</button></form>';
    if (p.photo_url) Auth.blobUrl(p.photo_url).then(function (u) { $('suivi-photo').innerHTML = '<a href="' + u + '" target="_blank"><img src="' + u + '" alt="Photo du signalement"></a>'; }).catch(function () {});
    boutons(p);
    historique(p.id);
    $('suivi-com').onsubmit = function (e) {
      e.preventDefault();
      var fm = e.target;
      photo(fm.elements.photo.files[0]).then(function (ph) {
        return envoyer({ action: 'commenter', commentaire: fm.elements.c.value.trim() || null, photo: ph });
      });
    };
  }
  function boutons(p) {
    var bar = $('suivi-actions'), v = Auth.isValidator(), chargeDe = v || monService(p);
    function btn(t, k, fn) { var b = document.createElement('button'); b.type = 'button'; b.textContent = t; if (k) b.className = k; b.onclick = fn; bar.appendChild(b); }
    if (v && (p.statut === 'À valider' || p.statut === 'Rejeté')) btn('✓ Valider', 'primary', function () { envoyer({ action: 'valider' }); });
    if (v && OUVERTS.indexOf(p.statut) >= 0 && p.categorie === 'Signalement') btn(p.service_affecte ? '↪ Réaffecter' : '↪ Affecter à un service', p.statut === 'Validé' ? 'primary' : '', formAffecter);
    if (chargeDe && p.statut === 'Affecté') btn('▶ Prendre en charge', 'primary', function () { envoyer({ action: 'prendre' }); });
    if (chargeDe && (p.statut === 'Affecté' || p.statut === 'En cours' || (v && p.statut === 'Validé')) && p.categorie === 'Signalement')
      btn('✓ Marquer traité', p.statut === 'En cours' ? 'primary' : '', formTraiter);
    if (v && p.statut === 'Traité' && p.categorie === 'Signalement') btn('↺ Rouvrir', '', function () { envoyer({ action: 'rouvrir' }); });
    if (v && OUVERTS.indexOf(p.statut) >= 0) btn('Rejeter', '', function () {
      var m = prompt('Motif du rejet (visible par l\'agent) :');
      if (m) envoyer({ action: 'rejeter', commentaire: m });
    });
  }
  function formAffecter() {
    var d = new Date(); d.setDate(d.getDate() + 7);
    $('suivi-form').innerHTML = '<form class="stack suivi-sousform"><label>Service chargé du traitement<select name="service" required>' +
      '<option value="">— choisir —</option>' + services.map(function (s) { return '<option>' + esc(s) + '</option>'; }).join('') + '</select></label>' +
      '<div class="grid2"><label>Priorité<select name="priorite"><option>Normale</option><option>Haute</option><option>Urgente</option><option>Basse</option></select></label>' +
      '<label>Échéance<input name="echeance" type="date" value="' + d.toISOString().slice(0, 10) + '"></label></div>' +
      '<label>Consigne<input name="c" maxlength="1000" placeholder="ex. Envoyer le camion de ramassage"></label>' +
      '<div class="row"><button type="button" data-x>Annuler</button><button class="primary" type="submit">Affecter</button></div></form>';
    var fm = $('suivi-form').querySelector('form');
    fm.querySelector('[data-x]').onclick = function () { $('suivi-form').innerHTML = ''; };
    fm.onsubmit = function (e) {
      e.preventDefault();
      envoyer({ action: 'affecter', service: fm.elements.service.value, priorite: fm.elements.priorite.value,
        echeance: fm.elements.echeance.value || null, commentaire: fm.elements.c.value.trim() || null });
    };
  }
  function formTraiter() {
    $('suivi-form').innerHTML = '<form class="stack suivi-sousform"><label>Compte rendu de l\'intervention *<textarea name="c" rows="2" required maxlength="1000" placeholder="ex. Dépôt enlevé, zone nettoyée"></textarea></label>' +
      '<label>Photo après intervention<input name="photo" type="file" accept="image/*" capture="environment"></label>' +
      '<div class="row"><button type="button" data-x>Annuler</button><button class="primary" type="submit">Marquer traité</button></div></form>';
    var fm = $('suivi-form').querySelector('form');
    fm.querySelector('[data-x]').onclick = function () { $('suivi-form').innerHTML = ''; };
    fm.onsubmit = function (e) {
      e.preventDefault();
      photo(fm.elements.photo.files[0]).then(function (ph) {
        envoyer({ action: 'traiter', commentaire: fm.elements.c.value.trim(), photo: ph });
      });
    };
  }
  function envoyer(body) {
    var id = courant;
    return Auth.api('POST', '/contributions/' + id + '/action', body)
      .then(function () { return LabeContrib.recharger(); })
      .then(function () { if (courant === id) ouvrir(id); })
      .catch(function (e) { alert(e.status ? 'Erreur : ' + e.message : 'Pas de réseau : action impossible hors connexion. Réessayez une fois connecté.'); });
  }
  var ACTION_ICONE = { 'création': '＋', 'validation': '✓', 'rejet': '✕', 'affectation': '↪', 'prise en charge': '▶', 'traitement': '✓',
    'réouverture': '↺', 'commentaire': '💬', 'modification': '✎', 'modification de la forme': '✎', 'application à la carte de référence': '🗺' };
  function historique(id) {
    Auth.api('GET', '/contributions/' + id + '/historique').then(function (h) {
      if (courant !== id) return;
      var ol = $('suivi-histo');
      ol.innerHTML = h.map(function (x) {
        return '<li><span class="histo-ico">' + (ACTION_ICONE[x.action] || '•') + '</span><div><b>' + esc(x.action.charAt(0).toUpperCase() + x.action.slice(1)) + '</b>' +
          (x.statut_apres && x.statut_apres !== x.statut_avant ? ' <span class="badge ' + cls(x.statut_apres) + '">' + esc(x.statut_apres) + '</span>' : '') +
          '<br><small>' + new Date(x.date).toLocaleString('fr-FR') + ' · ' + esc(x.utilisateur || '—') + (x.service ? ' (' + esc(x.service) + ')' : '') + '</small>' +
          (x.commentaire ? '<p>' + esc(x.commentaire) + '</p>' : '') +
          (x.photo_url ? '<div class="histo-photo" data-photo="' + esc(x.photo_url) + '"></div>' : '') +
          (x.a_forme && Auth.isValidator() ? '<button type="button" data-restaurer="' + x.id + '">Restaurer la forme d\'avant</button>' : '') +
          '</div></li>';
      }).join('') || '<li class="hint">Aucun historique.</li>';
      ol.querySelectorAll('[data-photo]').forEach(function (d) {
        Auth.blobUrl(d.dataset.photo).then(function (u) { d.innerHTML = '<a href="' + u + '" target="_blank"><img src="' + u + '" alt="Photo"></a>'; }).catch(function () {});
      });
      ol.querySelectorAll('[data-restaurer]').forEach(function (b) {
        b.onclick = function () {
          if (!confirm('Remettre la forme d\'avant cette modification ? (la forme actuelle restera dans l\'historique)')) return;
          Auth.api('POST', '/contributions/' + id + '/historique/' + b.dataset.restaurer + '/restaurer')
            .then(function () { return LabeContrib.recharger(); }).then(function () { ouvrir(id); }).catch(fail);
        };
      });
    }).catch(function () { $('suivi-histo').innerHTML = '<li class="hint">Historique indisponible hors connexion.</li>'; });
  }
  $('suivi-retour').addEventListener('click', function () {
    courant = null;
    $('suivi-fiche-vue').classList.add('hidden');
    $('suivi-liste-vue').classList.remove('hidden');
    map.closePopup();
  });

  // photo réduite (1280 px, JPEG) comme pour les saisies
  function photo(file) {
    if (!file) return Promise.resolve(null);
    return new Promise(function (ok) {
      var img = new Image();
      img.onload = function () {
        var k = Math.min(1, 1280 / Math.max(img.width, img.height)), cv = document.createElement('canvas');
        cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(img.src);
        ok(cv.toDataURL('image/jpeg', 0.75));
      };
      img.onerror = function () { alert('Image illisible.'); ok(null); };
      img.src = URL.createObjectURL(file);
    });
  }

  window.LabeSuivi = {
    ouvrir: ouvrir,
    start: function () {
      LabeContrib.onChange(function (features) {
        tous = features;
        rendre();
        if (courant && !$('suivi-fiche-vue').classList.contains('hidden')) { /* fiche rouverte par l'action en cours */ }
      });
    }
  };
})();
