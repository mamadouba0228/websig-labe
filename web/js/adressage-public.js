/* Carte publique : voies, adresses validées, recherche d'adresse et « Quelle est l'adresse ici ? ».
 * Fonctionne en mode serveur (WFS) comme en mode statique (GitHub Pages) : le calcul du numéro
 * métrique d'un point est fait dans le navigateur. */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc;
  var VOIE_LABEL_ZOOM = 16, ADR_ZOOM = 17, MAX_LABELS = 200;

  var voies = A.markClicks(L.featureGroup());
  var adresses = A.markClicks(L.featureGroup());
  var voieFeatures = [], adrFeatures = [];

  function voieStyle(p) {
    return p.statut_nom === 'Officiel'
      ? { color: '#1f6f43', weight: 2.5, opacity: 0.9 }
      : { color: '#7048e8', weight: 1.5, opacity: 0.55 };
  }

  // ---------- Étiquettes : seulement pour ce qui est visible, au-delà d'un certain zoom ----------
  function refreshLabels() {
    var z = map.getZoom(), b = map.getBounds().pad(0.1);
    var n = 0;
    voies.eachLayer(function (l) {
      var show = z >= VOIE_LABEL_ZOOM && map.hasLayer(voies) && n < MAX_LABELS && b.intersects(l.getBounds());
      if (show) {
        n++;
        if (!l.getTooltip()) l.bindTooltip(esc(l.feature.properties.libelle), { permanent: true, direction: 'center', className: 'label-voie' });
        l.openTooltip();
      } else if (l.getTooltip()) l.unbindTooltip();
    });
    var m = 0;
    adresses.eachLayer(function (l) {
      var show = z >= ADR_ZOOM + 1 && adrWanted && m < 2 * MAX_LABELS && b.contains(l.getLatLng());
      if (show) {
        m++;
        if (!l.getTooltip()) l.bindTooltip(esc(l.feature.properties.num), { permanent: true, direction: 'right', offset: [4, 0], className: 'label-num' });
        l.openTooltip();
      } else if (l.getTooltip()) l.unbindTooltip();
    });
    // points d'adresse affichés seulement aux grands zooms (rendu canvas : on retire la couche)
    if (adrWanted && z >= ADR_ZOOM) { if (!map.hasLayer(adresses)) adresses.addTo(map); }
    else if (map.hasLayer(adresses)) map.removeLayer(adresses);
  }
  var adrWanted = true;
  map.on('moveend', refreshLabels);

  // ---------- Calcul du numéro métrique dans le navigateur ----------
  // Projection locale en mètres (suffisante à l'échelle d'une commune)
  var LAT0 = 11.32, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110574;
  function xy(c) { return [c[0] * KX, c[1] * KY]; }

  function locate(latlng) {
    var p = [latlng.lng * KX, latlng.lat * KY], best = null;
    voieFeatures.forEach(function (f) {
      var c = f.geometry.coordinates, along = 0;
      for (var i = 1; i < c.length; i++) {
        var a = xy(c[i - 1]), b = xy(c[i]);
        var dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy, len = Math.sqrt(len2);
        var t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
        var qx = a[0] + t * dx, qy = a[1] + t * dy;
        var d = Math.hypot(p[0] - qx, p[1] - qy);
        if (!best || d < best.d) {
          var cross = dx * (p[1] - a[1]) - dy * (p[0] - a[0]);
          best = { f: f, d: d, dist: along + t * len, gauche: cross > 0 };
        }
        along += len;
      }
    });
    if (!best || best.d > 150) return null;
    var n = Math.max(1, Math.round(best.dist));
    if (best.gauche && n % 2 === 0) n++;
    if (!best.gauche && n % 2 === 1) n++;
    return { voie: best.f.properties, numero: n, distanceVoie: Math.round(best.d), cote: best.gauche ? 'impair (gauche)' : 'pair (droite)' };
  }
  function nearestAddress(latlng, maxM) {
    var best = null;
    adrFeatures.forEach(function (f) {
      var c = f.geometry.coordinates;
      var d = map.distance(latlng, [c[1], c[0]]);
      if (d <= maxM && (!best || d < best.d)) best = { f: f, d: d };
    });
    return best;
  }

  var picking = false, pickBtn = null;
  function stopPick() {
    picking = false;
    map.getContainer().classList.remove('crosshair');
    if (pickBtn) pickBtn.classList.remove('on');
  }
  map.on('click', function (e) {
    if (!picking) return;
    A.noteFeatureClick();
    stopPick();
    var r = locate(e.latlng);
    var off = nearestAddress(e.latlng, 30);
    var html = '<div class="popup"><h4>Adresse de ce point</h4>';
    if (off) {
      html += '<p class="adr-big">' + esc(off.f.properties.libelle) + '</p><p><small>' + esc(off.f.properties.quartier || '') +
        ', Labé · adresse officielle (' + esc(off.f.properties.statut.toLowerCase()) + ')</small></p>';
    } else if (r) {
      var v = r.voie;
      html += '<p class="adr-big">' + r.numero + ', ' + esc(v.libelle) + '</p>' +
        '<p><small>' + esc(v.quartier || '') + ', Labé · numéro <b>indicatif</b> (côté ' + r.cote + ', à ' + r.distanceVoie +
        ' m de la voie) : cette adresse n\'a pas encore été attribuée par la mairie.</small></p>';
    } else {
      html += '<p>Aucune voie à moins de 150 m.</p>';
    }
    html += '<small class="muted">' + e.latlng.lat.toFixed(6) + ', ' + e.latlng.lng.toFixed(6) + '</small></div>';
    L.popup().setLatLng(e.latlng).setContent(html).openOn(map);
  });

  var PickControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      var c = L.DomUtil.create('div', 'leaflet-bar tool-bar');
      var a = L.DomUtil.create('a', '', c);
      a.href = '#'; a.innerHTML = '⌖'; a.title = 'Quelle est l\'adresse de ce point ?';
      pickBtn = a;
      L.DomEvent.on(a, 'click', function (ev) {
        L.DomEvent.stop(ev);
        if (picking) return stopPick();
        picking = true; a.classList.add('on');
        map.getContainer().classList.add('crosshair');
      });
      L.DomEvent.disableClickPropagation(c);
      return c;
    }
  });

  // ---------- Chargement ----------
  A.ready.then(function () {
    return Promise.all([
      A.wfs(A.STATIC ? 'voies' : 'voies_publiques'),
      A.wfs(A.STATIC ? 'adresses' : 'adresses_publiques')
    ]);
  }).then(function (res) {
    voieFeatures = res[0].features.filter(function (f) { return f.geometry && f.geometry.type === 'LineString'; });
    adrFeatures = res[1].features;
    if (!voieFeatures.length) return;

    L.geoJSON({ type: 'FeatureCollection', features: voieFeatures }, {
      style: function (f) { return voieStyle(f.properties); },
      onEachFeature: function (f, l) {
        var p = f.properties;
        l.bindPopup(A.popupHtml(p.libelle, {
          code: p.code, statut: p.statut_nom === 'Officiel' ? 'Nom officiel' : p.nom ? 'Nom d\'usage (non officiel)' : 'Code provisoire',
          quartier: p.quartier
        }, { code: 'Code', statut: 'Dénomination', quartier: 'Quartier' }));
        voies.addLayer(l);
        A.searchIndex.push({ name: p.libelle + (p.nom ? ' · ' + p.code : ''), type: 'Voie · ' + (p.quartier || ''), layer: L.featureGroup([l]), parent: voies });
      }
    });
    L.geoJSON({ type: 'FeatureCollection', features: adrFeatures }, {
      pointToLayer: function (f, latlng) {
        return L.circleMarker(latlng, { radius: 4, color: '#fff', weight: 1, fillColor: '#1f6f43', fillOpacity: 1, });
      },
      onEachFeature: function (f, l) {
        var p = f.properties;
        l.bindPopup('<div class="popup"><p class="adr-big">' + esc(p.libelle) + '</p><small>' + esc(p.quartier || '') + ', Labé</small></div>');
        adresses.addLayer(l);
        A.searchIndex.push({ name: p.libelle, type: 'Adresse · ' + (p.quartier || ''), layer: l, parent: adresses });
      }
    });

    A.addOverlay({ name: 'Voies (' + voieFeatures.length + ')', layer: voies, on: true, group: 'Adressage',
      swatch: '<span class="swatch line" style="background:#7048e8"></span>',
      legend: [['Nom officiel', '#1f6f43', 'line'], ['Code provisoire / nom d\'usage', '#7048e8', 'line']] });
    A.addOverlay({ name: 'Adresses officielles (' + adrFeatures.length + ', zoom ≥ ' + ADR_ZOOM + ')', on: true,
      onToggle: function (on) { adrWanted = on; refreshLabels(); },
      swatch: '<span class="swatch dot" style="background:#1f6f43"></span>' });
    map.addControl(new PickControl());
    refreshLabels();
  }).catch(function () { /* adressage pas encore initialisé */ });
})();
