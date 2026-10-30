/* Saisies des agents : dessin (point, ligne, surface), fiche, photo, import GeoJSON,
 * validation par les superviseurs. Stockage PostGIS via l'API /api/contributions. */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc, CATEGORIES = A.CATEGORIES;
  var GEOM_LABEL = { Point: 'Point', LineString: 'Ligne', Polygon: 'Surface' };
  function cls(statut) { return 's-' + String(statut).replace(/\s/g, '-'); }

  // ---------- Couche carte ----------
  var layer = A.markClicks(L.featureGroup());
  var features = [];
  var filters = { categorie: '', statut: '', quartier: '', mine: false };

  function styleFor(p) {
    var c = (CATEGORIES[p.categorie] || CATEGORIES.Autre).color;
    if (p.statut === 'Traité') c = '#1f6f43';
    var pending = p.statut === 'À valider', rejected = p.statut === 'Rejeté';
    if (p.statut === 'Affecté' || p.statut === 'En cours') c = '#f08c00';
    return {
      color: rejected ? '#666' : c, weight: 3, opacity: pending ? 0.75 : 1,
      dashArray: pending || rejected ? '5 4' : null, fillColor: c, fillOpacity: pending ? 0.15 : 0.3
    };
  }
  function visible(p) {
    return (!filters.categorie || p.categorie === filters.categorie) &&
      (!filters.statut || p.statut === filters.statut) &&
      (!filters.quartier || p.quartier === filters.quartier) &&
      (!filters.mine || p.cree_par === Auth.user().id);
  }
  function canEdit(p) {
    return Auth.isValidator() || (p.cree_par === Auth.user().id && (p.statut === 'À valider' || p.statut === 'Rejeté'));
  }

  function popupContent(f, l) {
    var p = f.properties;
    var div = document.createElement('div');
    div.className = 'popup';
    var measure = '';
    if (f.geometry.type === 'LineString') measure = A.fmtLen(A.lineLength(l.getLatLngs()));
    if (f.geometry.type === 'Polygon') measure = A.fmtArea(A.polygonArea(l.getLatLngs()[0]));
    var rows = [
      ['Catégorie', p.categorie], ['Type', p.type], ['Description', p.description], ['Quartier', p.quartier],
      ['Mesure', measure], ['Saisi par', p.auteur && p.auteur + (p.service ? ' (' + p.service + ')' : '')],
      ['Date', new Date(p.cree_le).toLocaleString('fr-FR')],
      [p.statut === 'Rejeté' ? 'Rejeté par' : 'Validé par', p.valide_par_nom],
      ['Motif du rejet', p.motif_rejet],
      ['Service chargé', p.service_affecte && p.service_affecte + (p.priorite ? ' · priorité ' + p.priorite.toLowerCase() : '')],
      ['Échéance', p.echeance && new Date(p.echeance).toLocaleDateString('fr-FR')],
      ['Objet corrigé', p.ref_couche && (p.ref_couche === 'batiments' ? 'bâtiment' : 'tronçon de voie') + (p.ref_gid ? ' n° ' + p.ref_gid : ' (nouveau)')]
    ].filter(function (r) { return r[1]; });
    div.innerHTML = '<h4>' + esc(p.nom || p.type || p.categorie) + '</h4>' +
      '<span class="badge ' + cls(p.statut) + '">' + esc(p.statut) + '</span> <small class="muted">n° ' + p.id + '</small>' +
      (p.photo_url ? '<div class="popup-photo-wrap">Chargement de la photo…</div>' : '') +
      '<table>' + rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>';
    if (p.photo_url) {
      Auth.blobUrl(p.photo_url).then(function (u) {
        div.querySelector('.popup-photo-wrap').innerHTML = '<a href="' + u + '" target="_blank"><img class="popup-photo" src="' + u + '" alt="Photo"></a>';
      }).catch(function () { div.querySelector('.popup-photo-wrap').textContent = ''; });
    }
    var bar = document.createElement('div');
    bar.className = 'row';
    function btn(label, klass, fn) {
      var b = document.createElement('button');
      b.textContent = label; if (klass) b.className = klass;
      b.onclick = fn; bar.appendChild(b);
    }
    if (Auth.isValidator()) {
      if (p.statut === 'À valider' || p.statut === 'Rejeté') btn(p.ref_couche ? '✓ Valider et appliquer' : '✓ Valider', 'primary', function () {
        if (p.ref_couche && !confirm('La correction sera appliquée à la carte de référence (' + (p.ref_couche === 'batiments' ? 'bâti' : 'voirie') + ').')) return;
        action(p.id, { action: 'valider' });
      });
      if (p.statut !== 'Rejeté' && p.statut !== 'Traité') btn('Rejeter', '', function () {
        var motif = prompt('Motif du rejet (visible par l\'agent) :');
        if (motif) action(p.id, { action: 'rejeter', commentaire: motif });
      });
    }
    btn(p.categorie === 'Signalement' ? '🕘 Suivi' : '🕘 Historique', '', function () { map.closePopup(); LabeSuivi.ouvrir(p.id); });
    if (canEdit(p)) {
      btn('Modifier', '', function () { openForm(null, f); });
      btn('✎ Forme', '', function () {
        map.closePopup();
        LabeEdition.editer(f.geometry, { label: 'Saisie n° ' + p.id + ' : modifier la forme', onSave: function (g) {
          Auth.api('PUT', '/contributions/' + p.id, { geometry: g, properties: {} }).then(function () {
            LabeTerrain.toast('Forme enregistrée (l\'ancienne est gardée dans l\'historique).'); reload();
          }).catch(showError);
        } });
      });
      btn('Supprimer', 'danger', function () {
        if (!confirm('Supprimer définitivement cette saisie ?')) return;
        Auth.api('DELETE', '/contributions/' + p.id).then(function () { map.closePopup(); reload(); }).catch(showError);
      });
    }
    if (bar.children.length) div.appendChild(bar);
    return div;
  }

  var layerById = {}, abonnes = [];
  function render() {
    layer.clearLayers();
    layerById = {};
    var list = document.getElementById('contrib-list');
    list.innerHTML = '';
    var shown = features.filter(function (f) { return visible(f.properties); });
    shown.forEach(function (f) {
      var p = f.properties;
      var l = L.geoJSON(f, {
        style: function () { return styleFor(p); },
        pointToLayer: function (feat, latlng) {
          return L.circleMarker(latlng, { radius: 8, color: '#fff', weight: 2, fillColor: styleFor(p).color,
            fillOpacity: p.statut === 'À valider' ? 0.6 : 1 });
        }
      }).getLayers()[0];
      l.bindPopup(function () { return popupContent(f, l); }, { maxWidth: 320 });
      layer.addLayer(l);
      layerById[p.id] = l;

      var li = document.createElement('li');
      li.className = cls(p.statut);
      li.style.borderLeftColor = (CATEGORIES[p.categorie] || CATEGORIES.Autre).color;
      li.innerHTML = '<b>' + esc(p.nom || p.type || p.categorie) + '</b>' +
        '<small>' + esc(GEOM_LABEL[f.geometry.type]) + ' · ' + esc(p.type || p.categorie) + (p.quartier ? ' · ' + esc(p.quartier) : '') +
        '<br>' + esc(p.auteur || '') + ' · ' + new Date(p.cree_le).toLocaleDateString('fr-FR') +
        ' · <span class="badge ' + cls(p.statut) + '">' + esc(p.statut) + '</span></small>';
      li.onclick = function () { focus(p.id); };
      list.appendChild(li);
    });
    if (!shown.length) list.innerHTML = '<li class="empty"><small>Aucune saisie' + (features.length ? ' pour ces filtres' : '') + '.</small></li>';

    var pending = features.filter(function (f) { return f.properties.statut === 'À valider'; }).length;
    document.getElementById('contrib-count').textContent = features.length + ' saisie(s)' + (pending ? ' · ' + pending + ' à valider' : '');
    var tabBadge = document.getElementById('tab-badge');
    tabBadge.textContent = pending; tabBadge.classList.toggle('hidden', !(Auth.isValidator() && pending));
  }
  function focus(id) {
    var l = layerById[id];
    if (!l) return;
    if (!map.hasLayer(layer)) layer.addTo(map);
    if (l.getLatLng) map.flyTo(l.getLatLng(), 17); else map.flyToBounds(l.getBounds(), { maxZoom: 17, padding: [40, 40] });
    map.once('moveend', function () { l.openPopup(); });
  }

  function reload() {
    return Auth.api('GET', '/contributions').then(function (fc) {
      features = fc.features;
      abonnes.forEach(function (fn) { fn(features); });
      for (var i = A.searchIndex.length - 1; i >= 0; i--) if (A.searchIndex[i].contrib) A.searchIndex.splice(i, 1);
      render();
      features.forEach(function (f) {
        var l = layerById[f.properties.id];
        if (f.properties.nom && l) A.searchIndex.push({ name: f.properties.nom, type: 'Saisie · ' + (f.properties.type || f.properties.categorie),
          layer: l.getLatLng ? l : L.featureGroup([l]), parent: layer, contrib: true });
      });
    }).catch(function (e) {
      document.getElementById('contrib-count').textContent = 'Saisies indisponibles : ' + e.message;
    });
  }
  function action(id, body) {
    return Auth.api('POST', '/contributions/' + id + '/action', body)
      .then(function () { map.closePopup(); return reload(); }).catch(showError);
  }
  function showError(e) { alert('Erreur : ' + e.message); }

  // ---------- Fiche ----------
  var modal = document.getElementById('contrib-modal'), form = document.getElementById('contrib-form');
  var selCat = form.elements.categorie, selType = form.elements.type, selQuartier = form.elements.quartier;
  var pending = null, photoData = null, lastCategorie = null;

  Object.keys(CATEGORIES).forEach(function (c) { selCat.add(new Option(c, c)); });
  function fillTypes(selected) {
    selType.innerHTML = '';
    CATEGORIES[selCat.value].types.forEach(function (t) { selType.add(new Option(t, t, false, t === selected)); });
  }
  selCat.addEventListener('change', function () { fillTypes(); });
  function fillQuartiers(selected) {
    selQuartier.innerHTML = '<option value="">— automatique —</option>';
    A.quartierNames().forEach(function (q) { selQuartier.add(new Option(q, q, false, q === selected)); });
  }
  function toGeometry(mode, pts) {
    var c = pts.map(function (p) { return [+p.lng.toFixed(7), +p.lat.toFixed(7)]; });
    if (mode === 'point') return { type: 'Point', coordinates: c[0] };
    if (mode === 'line') return { type: 'LineString', coordinates: c };
    return { type: 'Polygon', coordinates: [c.concat([c[0]])] };
  }

  function openForm(geometry, feature, preset) {
    map.closePopup();
    form.reset();
    photoData = null;
    document.getElementById('photo-preview').innerHTML = '';
    var p = feature ? feature.properties : (preset || {});
    pending = feature ? { feature: feature } : { geometry: geometry, ref: preset && preset.ref };
    document.getElementById('contrib-title').textContent = feature ? 'Modifier la saisie n° ' + p.id
      : pending.ref ? 'Correction de la carte' : 'Nouvelle saisie';
    selCat.value = p.categorie || lastCategorie || Object.keys(CATEGORIES)[0];
    fillTypes(p.type);
    selCat.disabled = selType.disabled = !!pending.ref;
    var g = feature ? feature.geometry : geometry;
    var q = p.quartier;
    if (!q) {
      var first = g.type === 'Point' ? g.coordinates : g.type === 'LineString' ? g.coordinates[0] : g.coordinates[0][0];
      q = A.quartierAt(L.latLng(first[1], first[0]));
    }
    fillQuartiers(q);
    form.elements.nom.value = p.nom || '';
    form.elements.description.value = p.description || '';
    form.querySelector('.validator-only').classList.toggle('hidden', !Auth.isValidator());
    form.elements.statut.value = p.statut || (Auth.isValidator() ? 'Validé' : 'À valider');
    form.elements.motif_rejet.value = p.motif_rejet || '';
    document.getElementById('contrib-geom').textContent = GEOM_LABEL[g.type] + (g.type === 'Point'
      ? ' · ' + g.coordinates[1].toFixed(5) + ', ' + g.coordinates[0].toFixed(5)
      : ' · ' + (g.type === 'Polygon' ? g.coordinates[0].length - 1 : g.coordinates.length) + ' sommets') +
      (p.statut === 'Rejeté' && !Auth.isValidator() ? ' — après correction, la saisie repartira en validation.' : '');
    modal.classList.remove('hidden');
    form.elements.nom.focus();
  }

  // Photo réduite dans le navigateur (1280 px max, JPEG) avant envoi
  form.elements.photo.addEventListener('change', function () {
    var file = form.elements.photo.files[0];
    photoData = null;
    document.getElementById('photo-preview').innerHTML = '';
    if (!file) return;
    var img = new Image();
    img.onload = function () {
      var k = Math.min(1, 1280 / Math.max(img.width, img.height));
      var cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      photoData = cv.toDataURL('image/jpeg', 0.75);
      document.getElementById('photo-preview').innerHTML = '<img src="' + photoData + '" alt="">';
      URL.revokeObjectURL(img.src);
    };
    img.onerror = function () { alert('Image illisible.'); };
    img.src = URL.createObjectURL(file);
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var fd = new FormData(form);
    var props = {
      categorie: selCat.value, type: selType.value, nom: fd.get('nom').trim() || null,
      description: fd.get('description').trim() || null, quartier: fd.get('quartier') || null
    };
    if (Auth.isValidator()) {
      props.statut = fd.get('statut');
      props.motif_rejet = props.statut === 'Rejeté' ? (fd.get('motif_rejet').trim() || null) : null;
    }
    if (photoData) props.photo = photoData;
    var editing = !!pending.feature;
    if (!editing && props.categorie === 'Correction de la carte') {
      // objet visé (bâtiment ou tronçon existant) ; sinon ajout d'un objet manquant
      props.ref_couche = pending.ref ? pending.ref.couche : /^Bâtiment/.test(props.type) ? 'batiments' : 'routes';
      props.ref_gid = pending.ref ? pending.ref.gid : null;
      var attendu = props.ref_couche === 'batiments' ? 'Polygon' : 'LineString';
      if (!/démoli|disparue/.test(props.type) && pending.geometry.type !== attendu)
        return alert(props.ref_couche === 'batiments' ? 'Un bâtiment se dessine avec l\'outil « Surface ».' : 'Une voie se dessine avec l\'outil « Ligne ».');
      if (!props.ref_gid && !/à ajouter/.test(props.type))
        return alert('Pour modifier ou retirer un objet existant : outil ⓘ, cliquez l\'objet, puis « Proposer une correction ».');
    }
    lastCategorie = props.categorie;
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    var req = editing
      ? Auth.api('PUT', '/contributions/' + pending.feature.properties.id, { properties: props })
      : LabeTerrain.envoyer({ geometry: pending.geometry, properties: props });
    req.then(function (r) {
      modal.classList.add('hidden');
      if (r && r.enAttente) {
        LabeTerrain.toast('Pas de réseau : saisie gardée dans l\'appareil, envoyée automatiquement au retour de la connexion.');
        return;
      }
      var f = r.feature || r;
      return reload().then(function () {
        if (!editing && f.properties.statut === 'À valider') {
          LabeTerrain.toast('Saisie n° ' + f.id + ' enregistrée. Elle sera publiée après validation par un superviseur.');
        }
      });
    }).catch(showError).then(function () { btn.disabled = false; });
  });
  document.getElementById('contrib-cancel').addEventListener('click', function () { modal.classList.add('hidden'); });

  // ---------- Saisie ----------
  document.querySelectorAll('[data-draw]').forEach(function (b) {
    b.addEventListener('click', function () {
      var mode = b.getAttribute('data-draw');
      A.startSketch(mode, {
        label: { point: 'Nouveau point', line: 'Nouvelle ligne', area: 'Nouvelle surface' }[mode],
        onFinish: function (pts) { openForm(toGeometry(mode, pts)); }
      });
    });
  });

  // ---------- Saisie à la position GPS (terrain) ----------
  document.getElementById('gps-point').addEventListener('click', function () {
    LabeTerrain.pointGps(function (ll) { openForm(toGeometry('point', [ll])); });
  });
  document.querySelectorAll('[data-gps-trace]').forEach(function (b) {
    b.addEventListener('click', function () {
      var mode = b.getAttribute('data-gps-trace');
      LabeTerrain.traceGps(mode, function (pts) { openForm(toGeometry(mode, pts)); });
    });
  });
  // Corrections : objet manquant dans la carte de référence
  document.querySelectorAll('[data-manquant]').forEach(function (b) {
    b.addEventListener('click', function () {
      var bati = b.getAttribute('data-manquant') === 'batiment';
      A.startSketch(bati ? 'area' : 'line', { label: bati ? 'Bâtiment manquant' : 'Voie manquante', onFinish: function (pts) {
        openForm(toGeometry(bati ? 'area' : 'line', pts), null, { categorie: 'Correction de la carte', type: bati ? 'Bâtiment à ajouter' : 'Voie à ajouter',
          ref: { couche: bati ? 'batiments' : 'routes', gid: null } });
      } });
    });
  });

  // ---------- Filtres ----------
  var fCat = document.getElementById('filter-categorie'), fStat = document.getElementById('filter-statut'),
    fQ = document.getElementById('filter-quartier'), fMine = document.getElementById('filter-mine');
  Object.keys(CATEGORIES).forEach(function (c) { fCat.add(new Option(c, c)); });
  [['categorie', fCat], ['statut', fStat], ['quartier', fQ]].forEach(function (x) {
    x[1].addEventListener('change', function () { filters[x[0]] = x[1].value; render(); });
  });
  fMine.addEventListener('change', function () { filters.mine = fMine.checked; render(); });

  // ---------- Import GeoJSON ----------
  var importInput = document.getElementById('import-file');
  document.getElementById('btn-import').addEventListener('click', function () { importInput.click(); });
  importInput.addEventListener('change', function () {
    var file = importInput.files[0];
    importInput.value = '';
    if (!file) return;
    file.text().then(function (txt) {
      var gj = JSON.parse(txt), out = [];
      var feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [{ type: 'Feature', geometry: gj, properties: {} }];
      feats.forEach(function (f) {
        if (!f.geometry) return;
        var g = f.geometry, base = f.properties || {};
        var parts = g.type.indexOf('Multi') === 0
          ? g.coordinates.map(function (c) { return { type: g.type.slice(5), coordinates: c }; }) : [g];
        parts.forEach(function (pg) { if (GEOM_LABEL[pg.type]) out.push({ geometry: pg, src: base }); });
      });
      if (!out.length) throw new Error('aucun point, ligne ou surface trouvé');
      if (out.length > 500) throw new Error(out.length + ' objets : 500 maximum par import');
      var cat = prompt(out.length + ' objet(s) trouvé(s).\nCatégorie à leur attribuer :\n' +
        Object.keys(CATEGORIES).map(function (c, i) { return (i + 1) + '. ' + c; }).join('\n'), '1');
      var catName = Object.keys(CATEGORIES)[parseInt(cat, 10) - 1];
      if (!catName) return;
      var ok = 0, errors = [], chain = Promise.resolve();
      out.forEach(function (o, i) {
        chain = chain.then(function () {
          var s = o.src;
          return Auth.api('POST', '/contributions', { geometry: o.geometry, properties: {
            categorie: catName, type: s.type || s.TYPE || 'Autre',
            nom: s.nom || s.NOM || s.name || s.Name || null,
            description: s.description || s.DESCRIPTION || null
          } }).then(function () { ok++; }, function (e) { errors.push('#' + (i + 1) + ' : ' + e.message); });
        });
      });
      return chain.then(function () {
        reload();
        alert(ok + ' objet(s) importé(s), en attente de validation.' +
          (errors.length ? '\n' + errors.length + ' refusé(s) :\n' + errors.slice(0, 8).join('\n') : ''));
      });
    }).catch(function (e) { alert('Import impossible : ' + e.message); });
  });

  // ---------- Export ----------
  document.getElementById('btn-export').addEventListener('click', function () {
    var fc = { type: 'FeatureCollection', features: features.filter(function (f) { return visible(f.properties); }) };
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(fc, null, 1)], { type: 'application/geo+json' }));
    a.download = 'saisies_labe_' + new Date().toISOString().slice(0, 10) + '.geojson';
    a.click();
  });

  // ---------- Démarrage (appelé par espace.js une fois connecté) ----------
  window.LabeContrib = {
    nouvelle: function (geometry, preset) { openForm(geometry, null, preset); },
    recharger: function () { return reload(); },
    features: function () { return features; },
    onChange: function (fn) { abonnes.push(fn); if (features.length) fn(features); },
    focus: function (id) { focus(id); },
    layer: layer,
    start: function () {
      document.getElementById('contrib-hint').textContent = Auth.isValidator()
        ? 'Vos saisies sont publiées directement. Validez ou rejetez celles des agents depuis leur fiche.'
        : 'Dessinez l\'objet sur la carte puis remplissez la fiche. Un superviseur la validera avant publication.';
      A.ready.then(function () {
        A.quartierNames().forEach(function (q) { fQ.add(new Option(q, q)); });
        A.enregistrerIdentifiable(layer, 'Saisies des agents');
        A.addOverlay({ name: 'Saisies des agents', layer: layer, on: true, group: 'Données de la mairie',
          swatch: '<span class="swatch dot" style="background:#1c4e80;border:2px solid #fff"></span>',
          legend: Object.keys(CATEGORIES).map(function (c) { return [c, CATEGORIES[c].color]; })
            .concat([['À valider : contour pointillé', '#bbb']]) });
        return reload();
      }).then(function () {
        var m = /[?&]c=(\d+)/.exec(location.search);
        if (m) focus(+m[1]);
      });
    }
  };
})();
