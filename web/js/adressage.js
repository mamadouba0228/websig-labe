/* Espace agents : gestion de l'adressage (voies, numérotation métrique, validation, plaques). */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc;
  var ADR_ZOOM = 16, LABEL_ZOOM = 18;
  var ADR_COLORS = { 'Proposée': '#f08c00', 'Validée': '#1f6f43', 'Plaque posée': '#1c4e80' };
  var TYPES = ['Rue', 'Avenue', 'Boulevard', 'Route', 'Impasse', 'Allée', 'Place', 'Corniche'];

  var voiesLayer = A.markClicks(L.featureGroup());
  var adrLayer = A.markClicks(L.featureGroup());
  var startLayer = L.layerGroup();
  var voieById = {};
  var adrWanted = true, voiesWanted = true;

  function $(id) { return document.getElementById(id); }
  function fail(e) { alert('Erreur : ' + e.message); }
  function voieLibelle(p) { return p.type_voie + ' ' + (p.nom ? p.nom + ' (' + p.code + ')' : p.code); }
  function voieStyle(p) {
    if (p.statut_nom === 'Officiel') return { color: '#1f6f43', weight: 3, opacity: 0.9 };
    if (p.statut_nom === 'Proposé') return { color: '#f08c00', weight: 2.5, opacity: 0.8 };
    return { color: '#7048e8', weight: 2, opacity: 0.6 };
  }

  // ---------- Voies ----------
  function voiePopup(f) {
    var p = f.properties, d = document.createElement('div');
    d.className = 'popup';
    d.innerHTML = '<h4>' + esc(voieLibelle(p)) + '</h4><table>' +
      [['Code', p.code], ['Dénomination', p.statut_nom], ['Délibération', p.deliberation], ['Quartier', p.quartier],
        ['Longueur', A.fmtLen(p.longueur_m)],
        ['Adresses', p.nb_proposees + ' proposée(s) · ' + p.nb_validees + ' validée(s) · ' + p.nb_posees + ' plaque(s)']]
        .filter(function (r) { return r[1]; })
        .map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') +
      '</table><small class="muted">Le numéro 1/2 est au début de la voie (pastille noire). Pair à droite, impair à gauche.</small>';
    if (Auth.isValidator()) {
      var bar = document.createElement('div'); bar.className = 'row';
      function btn(t, k, fn) { var b = document.createElement('button'); b.textContent = t; if (k) b.className = k; b.onclick = fn; bar.appendChild(b); }
      btn('Dénommer / modifier', 'primary', function () { openVoieForm(f); });
      if (p.nb_proposees) btn('Valider les ' + p.nb_proposees + ' adresses', '', function () {
        if (confirm('Valider les ' + p.nb_proposees + ' adresses proposées de ' + p.code + ' ?\nFaites-le après vérification sur le terrain.'))
          post('/adressage/valider', { voie_id: p.id }, 'adresses validées');
      });
      btn('Renuméroter', '', function () { post('/adressage/numeroter', { voie_id: p.id }, 'adresses proposées'); });
      if (!p.nb_validees && !p.nb_posees) {
        btn('Inverser le sens', '', function () {
          if (confirm('Le début de la voie passera à l\'autre extrémité et les numéros seront recalculés.'))
            post('/adressage/voies/' + p.id + '/inverser', null, 'adresses recalculées');
        });
        btn('Supprimer', 'danger', function () {
          if (confirm('Supprimer la voie ' + p.code + ' et ses adresses proposées ?'))
            Auth.api('DELETE', '/adressage/voies/' + p.id).then(reloadAll).catch(fail);
        });
      }
      d.appendChild(bar);
    }
    return d;
  }
  function post(path, body, what) {
    map.closePopup();
    return Auth.api('POST', path, body).then(function (r) {
      var n = r.adresses != null ? r.adresses : '';
      if (what) alert(n + ' ' + what + '.');
      reloadAll();
    }).catch(fail);
  }
  function loadVoies() {
    return Auth.api('GET', '/adressage/voies').then(function (fc) {
      voiesLayer.clearLayers(); startLayer.clearLayers(); voieById = {};
      for (var i = A.searchIndex.length - 1; i >= 0; i--) if (A.searchIndex[i].adr) A.searchIndex.splice(i, 1);
      L.geoJSON(fc, {
        style: function (f) { return voieStyle(f.properties); },
        onEachFeature: function (f, l) {
          voieById[f.id] = { f: f, l: l };
          l.bindPopup(function () { return voiePopup(f); }, { maxWidth: 340 });
          voiesLayer.addLayer(l);
          var c0 = f.geometry.coordinates[0];
          startLayer.addLayer(L.circleMarker([c0[1], c0[0]], { radius: 3, color: '#000', weight: 1, fillColor: '#000', fillOpacity: 1, interactive: false }));
          A.searchIndex.push({ name: voieLibelle(f.properties), type: 'Voie · ' + (f.properties.quartier || ''),
            layer: L.featureGroup([l]), parent: voiesLayer, adr: true });
        }
      });
      refresh();
    });
  }

  // ---------- Adresses (chargées par zone visible) ----------
  var adrReq = 0;
  function adrPopup(f) {
    var p = f.properties, d = document.createElement('div');
    d.className = 'popup';
    d.innerHTML = '<p class="adr-big">' + esc(p.libelle) + '</p>' +
      '<span class="badge adr-' + p.statut.replace(/\s/g, '-') + '">' + esc(p.statut) + '</span><table>' +
      [['Quartier', p.quartier], ['Côté', p.cote === 'pair' ? 'pair (droite)' : 'impair (gauche)'], ['Complément', p.complement],
        ['Bâtiment', p.batiment_gid ? 'n° ' + p.batiment_gid : 'aucun (point saisi)']]
        .filter(function (r) { return r[1]; })
        .map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>';
    var bar = document.createElement('div'); bar.className = 'row';
    function btn(t, k, fn) { var b = document.createElement('button'); b.textContent = t; if (k) b.className = k; b.onclick = fn; bar.appendChild(b); }
    function put(body) {
      Auth.api('PUT', '/adressage/adresses/' + p.id, body).then(function () { map.closePopup(); loadAdresses(); loadStats(); }).catch(fail);
    }
    if (Auth.isValidator() && p.statut === 'Proposée') btn('✓ Valider', 'primary', function () { put({ statut: 'Validée' }); });
    if (p.statut === 'Validée') btn('Plaque posée', 'primary', function () { put({ statut: 'Plaque posée' }); });
    if (p.statut !== 'Proposée') btn('📄 Certificat', '', function () { window.open(lienCertificat(p.code_voie, p.numero + p.suffixe), '_blank'); });
    btn('Complément', '', function () {
      var c = prompt('Complément d\'adresse (ex. « Concession Diallo », « 1er étage ») :', p.complement || '');
      if (c !== null) put({ complement: c.trim() || null });
    });
    if (Auth.isValidator()) {
      btn('Changer le numéro', '', function () {
        var v = prompt('Nouveau numéro (pair à droite, impair à gauche), avec éventuellement une lettre (ex. 42A) :', p.numero + p.suffixe);
        if (!v) return;
        var m = /^\s*(\d+)\s*([A-Za-z]?)\s*$/.exec(v);
        if (!m) return alert('Format attendu : 42 ou 42A');
        put({ numero: +m[1], suffixe: m[2].toUpperCase() });
      });
      btn('Supprimer', 'danger', function () {
        if (confirm('Supprimer l\'adresse ' + p.libelle + ' ?'))
          Auth.api('DELETE', '/adressage/adresses/' + p.id).then(function () { map.closePopup(); loadAdresses(); loadStats(); }).catch(fail);
      });
    }
    d.appendChild(bar);
    return d;
  }
  function lienCertificat(voie, num) { return 'certificat.html?voie=' + encodeURIComponent(voie) + '&num=' + encodeURIComponent(num); }
  function loadAdresses() {
    if (!adrWanted || map.getZoom() < ADR_ZOOM) { adrLayer.clearLayers(); return Promise.resolve(); }
    var b = map.getBounds(), id = ++adrReq;
    var bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(function (x) { return x.toFixed(5); }).join(',');
    return Auth.api('GET', '/adressage/adresses?bbox=' + bbox).then(function (fc) {
      if (id !== adrReq) return; // une requête plus récente est en cours
      adrLayer.clearLayers();
      var showLabels = map.getZoom() >= LABEL_ZOOM;
      L.geoJSON(fc, {
        pointToLayer: function (f, latlng) {
          return L.circleMarker(latlng, { radius: 4.5, color: '#fff', weight: 1, fillColor: ADR_COLORS[f.properties.statut], fillOpacity: 1 });
        },
        onEachFeature: function (f, l) {
          l.bindPopup(function () { return adrPopup(f); }, { maxWidth: 320 });
          if (showLabels) l.bindTooltip(esc(f.properties.numero + f.properties.suffixe), { permanent: true, direction: 'right', offset: [4, 0], className: 'label-num' });
          adrLayer.addLayer(l);
        }
      });
    }).catch(function () {});
  }
  function refresh() {
    var z = map.getZoom();
    if (voiesWanted) { voiesLayer.addTo(map); if (z >= 16) startLayer.addTo(map); else map.removeLayer(startLayer); }
    else { map.removeLayer(voiesLayer); map.removeLayer(startLayer); }
    if (adrWanted && z >= ADR_ZOOM) adrLayer.addTo(map); else map.removeLayer(adrLayer);
    $('adr-zoom-hint').classList.toggle('hidden', z >= ADR_ZOOM);
    loadAdresses();
  }
  map.on('moveend', function () { if (started) refresh(); });

  // ---------- Formulaire de voie ----------
  var voieModal = $('voie-modal'), voieForm = $('voie-form'), pendingVoie = null;
  TYPES.forEach(function (t) { voieForm.elements.type_voie.add(new Option(t, t)); });
  function openVoieForm(f, geometry) {
    map.closePopup();
    voieForm.reset();
    pendingVoie = { f: f, geometry: geometry };
    var p = f ? f.properties : {};
    $('voie-title').textContent = f ? 'Voie ' + p.code : 'Nouvelle voie';
    voieForm.elements.type_voie.value = p.type_voie || 'Rue';
    voieForm.elements.nom.value = p.nom || '';
    voieForm.elements.statut_nom.value = p.statut_nom || 'Sans nom';
    voieForm.elements.deliberation.value = p.deliberation || '';
    voieModal.classList.remove('hidden');
  }
  voieForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var el = voieForm.elements;
    var body = { type_voie: el.type_voie.value, nom: el.nom.value.trim() || null,
      statut_nom: el.statut_nom.value, deliberation: el.deliberation.value.trim() || null };
    if (body.nom && body.statut_nom === 'Sans nom') body.statut_nom = 'Proposé';
    var req = pendingVoie.f
      ? Auth.api('PUT', '/adressage/voies/' + pendingVoie.f.id, body)
      : Auth.api('POST', '/adressage/voies', Object.assign(body, { geometry: pendingVoie.geometry }));
    req.then(function (f) {
      voieModal.classList.add('hidden');
      if (!pendingVoie.f) alert('Voie ' + f.properties.code + ' créée : ' + f.properties.nb_proposees + ' adresse(s) proposée(s).');
      reloadAll();
    }).catch(fail);
  });
  $('voie-cancel').addEventListener('click', function () { voieModal.classList.add('hidden'); });

  // ---------- Outils ----------
  $('btn-adr-locate').addEventListener('click', function () {
    A.startSketch('point', { label: 'Adresse d\'un point', onFinish: function (pts) {
      var ll = pts[0];
      Auth.api('GET', '/adressage/localiser?lon=' + ll.lng.toFixed(6) + '&lat=' + ll.lat.toFixed(6)).then(function (r) {
        var h = '<div class="popup"><h4>Adresse de ce point</h4>';
        if (!r.trouve) h += '<p>Aucune voie à moins de 150 m.</p>';
        else {
          if (r.adresse_officielle) h += '<p class="adr-big">' + esc(r.adresse_officielle.libelle) + '</p><small>Adresse ' + esc(r.adresse_officielle.statut.toLowerCase()) + ' à ' + r.adresse_officielle.distance_m + ' m</small><hr>';
          h += '<p><b>' + r.numero_calcule + ', ' + esc(r.voie) + '</b><br><small>Numéro métrique calculé · côté ' + esc(r.cote) +
            ' · ' + r.distance_m + ' m depuis le début · ' + r.distance_voie_m + ' m de la voie · ' + esc(r.quartier || '') + '</small></p>';
        }
        L.popup({ outil: true }).setLatLng(ll).setContent(h + '</div>').openOn(map);
      }).catch(fail);
    } });
  });
  $('btn-adr-add').addEventListener('click', function () {
    A.startSketch('point', { label: 'Nouvelle adresse : cliquez sur l\'entrée du bâtiment', onFinish: function (pts) {
      var ll = pts[0];
      Auth.api('POST', '/adressage/adresses', { lon: +ll.lng.toFixed(7), lat: +ll.lat.toFixed(7) }).then(function (f) {
        alert('Adresse proposée : ' + f.properties.libelle);
        if (map.getZoom() < ADR_ZOOM) map.setView(ll, ADR_ZOOM); else { loadAdresses(); }
        loadStats();
      }).catch(fail);
    } });
  });
  $('btn-voie-add').addEventListener('click', function () {
    A.startSketch('line', { label: 'Nouvelle voie : tracez depuis son début', onFinish: function (pts) {
      openVoieForm(null, { type: 'LineString', coordinates: pts.map(function (p) { return [+p.lng.toFixed(7), +p.lat.toFixed(7)]; }) });
    } });
  });
  function quartierChoisi() {
    var q = $('adr-quartier').value;
    if (!q) alert('Choisissez un quartier.');
    return q;
  }
  $('btn-q-numeroter').addEventListener('click', function () {
    var q = quartierChoisi();
    if (q && confirm('Recalculer les adresses proposées du quartier ' + q + ' ?\nLes adresses validées et les plaques posées ne changent pas.'))
      post('/adressage/numeroter', { quartier: q }, 'adresses proposées');
  });
  $('btn-q-valider').addEventListener('click', function () {
    var q = quartierChoisi();
    if (q && confirm('Valider TOUTES les adresses proposées du quartier ' + q + ' ?\nÀ faire seulement après vérification sur le terrain.'))
      post('/adressage/valider', { quartier: q }, 'adresses validées');
  });
  function download(path, name) {
    var url = '/api' + path;
    fetch(url, { headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('labe-session')).jeton } })
      .then(function (r) { if (!r.ok) throw new Error('export refusé (' + r.status + ')'); return r.blob(); })
      .then(function (b) {
        var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click();
      }).catch(fail);
  }
  $('btn-exp-adr').addEventListener('click', function () {
    var q = $('adr-quartier').value, s = $('adr-export-statut').value;
    var qs = [q ? 'quartier=' + encodeURIComponent(q) : '', s ? 'statut=' + encodeURIComponent(s) : ''].filter(Boolean).join('&');
    download('/adressage/export/adresses.csv' + (qs ? '?' + qs : ''), 'adresses_' + (q || 'labe').replace(/\s/g, '_') + '.csv');
  });
  $('btn-exp-voies').addEventListener('click', function () { download('/adressage/export/voies.csv', 'registre_voies_labe.csv'); });
  $('btn-adr-init').addEventListener('click', function () {
    if (!confirm('Créer les voies à partir de la voirie OSM et proposer une adresse pour chaque bâtiment ?\nCette opération ne se fait qu\'une fois (environ une minute).')) return;
    var b = $('btn-adr-init'); b.disabled = true; b.textContent = 'Initialisation en cours…';
    Auth.api('POST', '/adressage/initialiser').then(function (r) {
      alert(r.voies + ' voies créées, ' + r.adresses + ' adresses proposées sur ' + r.batiments + ' bâtiments.');
      reloadAll();
    }).catch(fail).then(function () { b.disabled = false; b.textContent = 'Initialiser l\'adressage'; });
  });

  // ---------- Avancement ----------
  function loadStats() {
    return Auth.api('GET', '/adressage/stats').then(function (st) {
      $('adr-init').classList.toggle('hidden', st.initialise);
      $('adr-main').classList.toggle('hidden', !st.initialise);
      $('btn-adr-init').classList.toggle('hidden', !Auth.isAdmin());
      if (!st.initialise) return;
      var t = { batiments: 0, proposees: 0, validees: 0, posees: 0, voies: 0, off: 0 };
      st.quartiers.forEach(function (q) {
        t.batiments += q.batiments; t.proposees += q.proposees; t.validees += q.validees; t.posees += q.posees;
        t.voies += q.voies; t.off += q.voies_officielles;
      });
      var adresses = t.proposees + t.validees + t.posees;
      $('adr-progress').innerHTML =
        '<div class="stat-cards">' +
        '<div class="stat-card"><b>' + A.fmt(t.voies) + '</b><span>voies · ' + t.off + ' nommée(s) officiellement</span></div>' +
        '<div class="stat-card"><b>' + A.fmt(adresses) + '</b><span>adresses (' + Math.round(100 * adresses / Math.max(t.batiments, 1)) + ' % du bâti)</span></div>' +
        '<div class="stat-card"><b>' + A.fmt(t.validees + t.posees) + '</b><span>validées</span></div>' +
        '<div class="stat-card"><b>' + A.fmt(t.posees) + '</b><span>plaques posées</span></div></div>';
      var lignes = st.quartiers.filter(function (q) { return q.proposees + q.validees + q.posees; }).map(function (q) {
        var n = q.proposees + q.validees + q.posees;
        return { q: q, n: n, val: (q.validees + q.posees) / n, pose: q.posees / n };
      }).sort(function (a, b) { return b.val - a.val || b.pose - a.pose || a.q.quartier.localeCompare(b.q.quartier); });
      $('adr-quartiers').innerHTML = '<table class="ana-table adr-avancement"><thead><tr><th>Quartier</th><th>Adresses</th><th>Validées</th><th>Plaques posées</th></tr></thead><tbody>' +
        lignes.map(function (l) {
          function barre(x, c) { return '<div class="bar"><div style="width:' + Math.round(100 * x) + '%;background:' + c + '"></div></div><small>' + Math.round(100 * x) + ' %</small>'; }
          return '<tr><td>' + esc(l.q.quartier) + '</td><td>' + A.fmt(l.n) + '</td><td>' + barre(l.val, '#1f6f43') + '</td><td>' + barre(l.pose, '#1c4e80') + '</td></tr>';
        }).join('') + '</tbody></table>';
      var sel = $('adr-quartier'), cur = sel.value;
      sel.innerHTML = '<option value="">— quartier —</option>';
      st.quartiers.forEach(function (q) { sel.add(new Option(q.quartier + ' (' + q.code + ')', q.quartier, false, q.quartier === cur)); });
    }).catch(function () {});
  }
  function reloadAll() { return Promise.all([loadVoies(), loadStats(), loadPoses()]); }

  // ---------- Campagne de pose des plaques ----------
  var poseLayer = L.layerGroup().addTo(map);
  function tournee(ll) {
    $('adr-pose-liste').innerHTML = '<p class="hint">Recherche des adresses à équiper…</p>';
    Auth.api('GET', '/adressage/a-poser?lon=' + ll.lng.toFixed(6) + '&lat=' + ll.lat.toFixed(6) + '&limite=40').then(function (fc) {
      poseLayer.clearLayers();
      if (!fc.features.length) { $('adr-pose-liste').innerHTML = '<p class="hint">Aucune adresse validée en attente de plaque.</p>'; return; }
      var ul = document.createElement('ul'); ul.className = 'pose-liste';
      fc.features.forEach(function (f, i) {
        var p = f.properties, c = f.geometry.coordinates, pll = L.latLng(c[1], c[0]);
        var m = L.marker(pll, { icon: L.divIcon({ className: 'pose-num', html: String(i + 1), iconSize: [22, 22], iconAnchor: [11, 11] }) })
          .bindTooltip(esc(p.libelle)).addTo(poseLayer);
        var li = document.createElement('li');
        li.innerHTML = '<span><b>' + (i + 1) + '.</b> ' + esc(p.libelle) + '<br><small>' + A.fmtLen(p.distance_m) + ' · ' + esc(p.quartier || '') +
          (p.complement ? ' · ' + esc(p.complement) : '') + '</small></span>';
        var voir = document.createElement('button'); voir.type = 'button'; voir.textContent = 'Voir';
        voir.onclick = function () { map.setView(pll, 19); m.openTooltip(); };
        var ok = document.createElement('button'); ok.type = 'button'; ok.className = 'primary'; ok.textContent = '✓ Posée';
        ok.onclick = function () {
          ok.disabled = true;
          Auth.api('PUT', '/adressage/adresses/' + f.id, { statut: 'Plaque posée' }).then(function () {
            li.classList.add('pose-faite'); ok.textContent = 'Posée ✓'; poseLayer.removeLayer(m);
            loadStats(); loadPoses(); loadAdresses();
          }).catch(function (e) { ok.disabled = false; fail(e.status ? e : new Error('pas de réseau, réessayez une fois connecté')); });
        };
        li.appendChild(voir); li.appendChild(ok); ul.appendChild(li);
      });
      $('adr-pose-liste').innerHTML = '';
      $('adr-pose-liste').appendChild(ul);
      map.fitBounds(L.latLngBounds(fc.features.slice(0, 10).map(function (f) { return [f.geometry.coordinates[1], f.geometry.coordinates[0]]; }).concat([ll])), { padding: [40, 40], maxZoom: 18 });
    }).catch(fail);
  }
  $('btn-adr-tournee').addEventListener('click', function () {
    $('adr-pose-liste').innerHTML = '<p class="hint">Recherche de votre position…</p>';
    var fini = false;
    // sans GPS (ou s'il tarde), la tournée part du centre de la carte
    var t = setTimeout(function () { if (!fini) { fini = true; tournee(map.getCenter()); } }, 8000);
    LabeTerrain.position(function (pos) {
      if (fini) return;
      fini = true; clearTimeout(t);
      tournee(pos ? pos.ll : map.getCenter());
    });
  });
  $('btn-adr-tournee-centre').addEventListener('click', function () { tournee(map.getCenter()); });

  function loadPoses() {
    return Auth.api('GET', '/adressage/poses?jours=30').then(function (r) {
      var max = Math.max.apply(null, r.par_jour.map(function (d) { return d.n; }).concat([1])), total = 0;
      r.par_jour.forEach(function (d) { total += d.n; });
      var W = 300, H = 70, bw = W / r.par_jour.length;
      var svg = '<svg viewBox="0 0 ' + W + ' ' + (H + 14) + '" class="poses-svg" role="img" aria-label="Plaques posées par jour sur 30 jours">' +
        '<line x1="0" x2="' + W + '" y1="' + H + '" y2="' + H + '" class="g"/>' +
        r.par_jour.map(function (d, i) {
          var h = d.n / max * (H - 4);
          return '<rect x="' + (i * bw + 1).toFixed(1) + '" y="' + (H - h).toFixed(1) + '" width="' + Math.max(bw - 2, 1).toFixed(1) + '" height="' + h.toFixed(1) +
            '" rx="2"><title>' + new Date(d.jour).toLocaleDateString('fr-FR') + ' : ' + d.n + ' plaque(s)</title></rect>';
        }).join('') +
        '<text x="0" y="' + (H + 12) + '">' + new Date(r.par_jour[0].jour).toLocaleDateString('fr-FR') + '</text>' +
        '<text x="' + W + '" y="' + (H + 12) + '" text-anchor="end">aujourd\'hui</text></svg>';
      $('adr-poses').innerHTML = '<p class="hint"><b>' + A.fmt(total) + '</b> plaque(s) posée(s) ces 30 derniers jours (max. ' + max + ' par jour).</p>' + svg +
        (r.par_agent.length ? '<table class="ana-table"><thead><tr><th>Agent</th><th>Plaques</th><th>Dernière</th></tr></thead><tbody>' +
          r.par_agent.slice(0, 10).map(function (a) {
            return '<tr><td>' + esc(a.agent) + '</td><td>' + A.fmt(a.n) + '</td><td>' + (a.dernier ? new Date(a.dernier).toLocaleDateString('fr-FR') : '—') + '</td></tr>';
          }).join('') + '</tbody></table>' : '');
    }).catch(function () {});
  }

  // ---------- Démarrage (appelé par espace.js) ----------
  var started = false;
  window.LabeAdressage = {
    start: function () {
      started = true;
      document.querySelectorAll('.validator-only-adr').forEach(function (el) { el.classList.toggle('hidden', !Auth.isValidator()); });
      A.ready.then(function () {
        A.enregistrerIdentifiable(voiesLayer, 'Voies (adressage)');
        A.enregistrerIdentifiable(adrLayer, 'Adresses');
        A.addOverlay({ name: 'Voies (adressage)', on: true, group: 'Adressage',
          onToggle: function (on) { voiesWanted = on; if (started) refresh(); },
          swatch: '<span class="swatch line" style="background:#7048e8"></span>',
          legend: [['Nom officiel', '#1f6f43', 'line'], ['Nom proposé', '#f08c00', 'line'], ['Code seul / nom d\'usage', '#7048e8', 'line']] });
        A.addOverlay({ name: 'Adresses (zoom ≥ ' + ADR_ZOOM + ')', on: true,
          onToggle: function (on) { adrWanted = on; if (started) refresh(); },
          swatch: '<span class="swatch dot" style="background:#f08c00"></span>',
          legend: Object.keys(ADR_COLORS).map(function (k) { return [k, ADR_COLORS[k]]; }) });
        return reloadAll();
      });
    }
  };
})();
