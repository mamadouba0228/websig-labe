/* WebSIG — Commune urbaine de Labé
 * Couches de référence servies par GeoServer (WFS pour les couches interactives,
 * WMS pour le bâti), contributions des utilisateurs via l'API (contributions.js). */
(function () {
  'use strict';

  var CONFIG = window.LABE_CONFIG || { mode: 'server' };
  var STATIC = CONFIG.mode === 'static';
  var PAGE = document.body.getAttribute('data-page') || 'public';
  var GEOSERVER = '/geoserver/labe';
  var BATI_MIN_ZOOM = 15;

  // Catégories des contributions (partagées avec contributions.js)
  var CATEGORIES = {
    'Équipement public': { color: '#1c4e80', types: ['École', 'Centre / poste de santé', 'Pharmacie', 'Forage / puits',
      'Borne-fontaine', 'Marché', 'Lieu de culte', 'Bâtiment administratif', 'Terrain de sport', 'Gare routière', 'Autre'] },
    'Voirie & réseaux': { color: '#e8590c', types: ['Route / rue', 'Piste', 'Pont / ouvrage', 'Caniveau',
      'Éclairage public', 'Réseau électrique', 'Réseau d\'eau', 'Autre'] },
    'Foncier & occupation du sol': { color: '#2b8a3e', types: ['Parcelle', 'Lotissement', 'Espace vert', 'Zone agricole',
      'Zone à risque (inondation, érosion)', 'Réserve foncière', 'Autre'] },
    'Signalement': { color: '#c8102e', types: ['Voirie dégradée', 'Éclairage en panne', 'Dépôt d\'ordures',
      'Inondation / érosion', 'Fuite d\'eau', 'Construction illégale', 'Autre'] },
    'Autre': { color: '#6c757d', types: ['Autre'] }
  };

  // ---------- Carte & fonds ----------
  var map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 10 });
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  map.setView([11.318, -12.30], 12);

  var basemaps = {
    'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© contributeurs OpenStreetMap'
    }),
    'Satellite (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Imagerie © Esri, Maxar, Earthstar Geographics'
    }),
    'Topographique': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, attribution: '© OpenTopoMap (CC-BY-SA), © OSM'
    }),
    'Clair (Carto)': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19, attribution: '© OSM, © CARTO'
    })
  };
  var currentBase = basemaps['OpenStreetMap'].addTo(map);

  // ---------- Utilitaires ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function popupHtml(title, props, labels) {
    var rows = Object.keys(labels).filter(function (k) {
      return props[k] != null && props[k] !== '' && props[k] !== 'NC';
    }).map(function (k) {
      return '<tr><td>' + labels[k] + '</td><td>' + esc(props[k]) + '</td></tr>';
    }).join('');
    return '<div class="popup"><h4>' + esc(title) + '</h4><table>' + rows + '</table></div>';
  }
  function fmt(n, d) { return Number(n).toLocaleString('fr-FR', { maximumFractionDigits: d || 0 }); }

  // Longueur géodésique d'une ligne (m)
  function lineLength(latlngs) {
    var l = 0;
    for (var i = 1; i < latlngs.length; i++) l += map.distance(latlngs[i - 1], latlngs[i]);
    return l;
  }
  // Longueur d'une couche LineString ou MultiLineString (m)
  function featureLength(l) {
    var ll = l.getLatLngs();
    var segs = Array.isArray(ll[0]) ? ll : [ll];
    return segs.reduce(function (s, seg) { return s + lineLength(seg); }, 0);
  }
  // Surface sphérique d'un polygone (m²)
  function polygonArea(latlngs) {
    var R = 6378137, a = 0, n = latlngs.length;
    if (n < 3) return 0;
    for (var i = 0; i < n; i++) {
      var p1 = latlngs[i], p2 = latlngs[(i + 1) % n];
      a += (p2.lng - p1.lng) * Math.PI / 180 *
        (2 + Math.sin(p1.lat * Math.PI / 180) + Math.sin(p2.lat * Math.PI / 180));
    }
    return Math.abs(a * R * R / 2);
  }
  function outerRing(l) {
    var r = l.getLatLngs();
    while (Array.isArray(r[0])) r = r[0];
    return r;
  }
  function fmtLen(m) { return m >= 1000 ? fmt(m / 1000, 2) + ' km' : fmt(m, 0) + ' m'; }
  function fmtArea(m2) { return m2 >= 1e6 ? fmt(m2 / 1e6, 2) + ' km²' : m2 >= 1e4 ? fmt(m2 / 1e4, 2) + ' ha' : fmt(m2, 0) + ' m²'; }

  // Couche de données : fichier statique (GitHub Pages) ou WFS 1.0.0 (lon/lat, sans ambiguïté d'axe)
  function getJSON(url, what) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(what + ' indisponible (' + r.status + ')');
      return r.json();
    });
  }
  // Chargement unique d'une couche partagée entre modules (ex. voies : adressage + itinéraires)
  var loaded = {};
  function loadOnce(layer) { return loaded[layer] || (loaded[layer] = wfs(layer)); }
  function wfs(layer) {
    if (STATIC) return getJSON('data/' + layer + '.geojson', 'couche ' + layer);
    return getJSON(GEOSERVER + '/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=labe:' + layer +
      '&outputFormat=application/json&srsName=EPSG:4326', 'couche ' + layer);
  }

  // Un clic sur un objet vectoriel ne doit pas déclencher aussi l'interrogation du bâti (WMS)
  var lastFeatureClick = 0;
  function markClicks(layer) { layer.on('click', function () { lastFeatureClick = Date.now(); }); return layer; }
  function noteFeatureClick() { lastFeatureClick = Date.now(); }

  // ---------- Styles ----------
  var ROUTE_STYLE = {
    'Voie rapide':            { color: '#c8102e', weight: 5, label: 'Voie rapide / nationale' },
    'Route primaire':         { color: '#e8590c', weight: 4.5, label: 'Route primaire' },
    'Route secondaire':       { color: '#f08c00', weight: 4, label: 'Route secondaire' },
    'Route tertiaire':        { color: '#f2c230', weight: 3.5, label: 'Route tertiaire' },
    'Route non classifiée':   { color: '#8d8d8d', weight: 2.5, label: 'Route non classée' },
    'Route résidentielle':    { color: '#adb5bd', weight: 2, label: 'Rue résidentielle' },
    "Route d accès":          { color: '#ced4da', weight: 1.5, label: "Voie d'accès" },
    'Chemin carrossable':     { color: '#a0785a', weight: 1.5, dashArray: '4 3', label: 'Chemin carrossable' },
    'Chemin non carrossable': { color: '#a0785a', weight: 1, dashArray: '2 3', label: 'Sentier' }
  };
  var EQ_STYLE = {
    'Administration': { color: '#1c4e80', sym: 'A' },
    'Santé':          { color: '#c8102e', sym: '+' },
    'Enseignement':   { color: '#6f42c1', sym: 'E' },
    'Religion':       { color: '#1f6f43', sym: '☪' },
    'Commerce':       { color: '#e8590c', sym: '€' },
    'Culture':        { color: '#d63384', sym: 'M' },
    'Sport':          { color: '#0ca678', sym: 'S' }
  };

  // ---------- Panneau des couches ----------
  var ovDiv = document.getElementById('overlays');
  var lastGroup = null;
  // o : { name, layer, on, swatch, legend, group, onToggle }
  function addOverlay(o) {
    if (o.group && o.group !== lastGroup) {
      var h = document.createElement('h3'); h.textContent = o.group; ovDiv.appendChild(h);
      lastGroup = o.group;
    }
    var lab = document.createElement('label');
    lab.className = 'layer-item';
    lab.innerHTML = '<input type="checkbox"' + (o.on ? ' checked' : '') + '>' + o.swatch + '<span>' + esc(o.name) + '</span>';
    ovDiv.appendChild(lab);
    if (o.legend) {
      var ul = document.createElement('ul'); ul.className = 'legend-sub';
      ul.innerHTML = o.legend.map(function (it) {
        return '<li><span class="swatch' + (it[2] ? ' ' + it[2] : '') + '" style="background:' + it[1] + '"></span>' + esc(it[0]) + '</li>';
      }).join('');
      ovDiv.appendChild(ul);
    }
    var cb = lab.querySelector('input');
    function apply() {
      if (o.onToggle) return o.onToggle(cb.checked);
      if (cb.checked) o.layer.addTo(map); else map.removeLayer(o.layer);
    }
    cb.addEventListener('change', apply);
    apply();
    return lab;
  }

  var bmDiv = document.getElementById('basemaps');
  Object.keys(basemaps).forEach(function (name, i) {
    var lab = document.createElement('label');
    lab.className = 'layer-item';
    lab.innerHTML = '<input type="radio" name="basemap"' + (i === 0 ? ' checked' : '') + '><span>' + esc(name) + '</span>';
    lab.querySelector('input').addEventListener('change', function () {
      map.removeLayer(currentBase);
      currentBase = basemaps[name].addTo(map);
      currentBase.bringToBack();
    });
    bmDiv.appendChild(lab);
  });

  // ---------- Bâti : WMS GeoServer (44 000 objets, rendu côté serveur) ----------
  map.createPane('batiPane').style.zIndex = 350; // sous les couches vectorielles (400)
  var BATI_COLORS = { 'Bâtiment en construction': '#f2c230', 'Hute': '#a0785a', 'Bâtiment scolaire': '#6f42c1' };
  var bati, batiLoading = null;
  if (!STATIC) {
    bati = L.tileLayer.wms(GEOSERVER + '/wms', {
      layers: 'labe:batiments', format: 'image/png', transparent: true, version: '1.1.1',
      tiled: true, pane: 'batiPane', maxZoom: 20, attribution: 'Bâti © OSM'
    });
  }
  // Mode statique : 44 000 polygones dessinés en canvas, chargés au premier passage au zoom 15
  function loadStaticBati() {
    if (!batiLoading) {
      var hint = document.getElementById('load-status');
      hint.textContent = 'Chargement du bâti…'; hint.classList.remove('hidden');
      batiLoading = loadOnce('batiments').then(function (gj) {
        hint.classList.add('hidden');
        bati = L.geoJSON(gj, {
          renderer: L.canvas({ padding: 0.3, pane: 'batiPane' }),
          style: function (f) {
            var c = BATI_COLORS[f.properties.nature] || '#868e96';
            return { color: c, weight: 0.5, fillColor: c, fillOpacity: 0.55 };
          },
          onEachFeature: function (f, l) {
            l.on('click', function (e) {
              L.popup().setLatLng(e.latlng).setContent(
                popupHtml(f.properties.nature === 'NC' ? 'Bâtiment' : f.properties.nature, {}, {}) +
                '<small>Emprise au sol : ' + fmtArea(polygonArea(outerRing(l))) + '</small>').openOn(map);
            });
          }
        });
      });
    }
    return batiLoading;
  }
  var batiWanted = true;
  function updateBati() {
    var show = batiWanted && map.getZoom() >= BATI_MIN_ZOOM;
    if (STATIC && show && !bati) return loadStaticBati().then(updateBati);
    if (!bati) return;
    if (show) bati.addTo(map); else map.removeLayer(bati);
  }
  map.on('zoomend', updateBati);

  // Interrogation du bâti au clic (GetFeatureInfo)
  var sketch = null; // déclaré plus bas, utilisé ici pour ignorer les clics de dessin
  map.on('click', function (e) {
    if (STATIC || sketch || !bati || !map.hasLayer(bati)) return;
    setTimeout(function () {
      if (Date.now() - lastFeatureClick < 300) return;
      var size = map.getSize(), b = map.getBounds(), p = map.latLngToContainerPoint(e.latlng);
      var url = GEOSERVER + '/wms?service=WMS&version=1.1.1&request=GetFeatureInfo&layers=labe:batiments' +
        '&query_layers=labe:batiments&info_format=application/json&feature_count=1&srs=EPSG:4326' +
        '&bbox=' + [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(',') +
        '&width=' + size.x + '&height=' + size.y + '&x=' + Math.round(p.x) + '&y=' + Math.round(p.y);
      fetch(url).then(function (r) { return r.json(); }).then(function (gj) {
        var f = gj.features && gj.features[0];
        if (!f) return;
        var area = polygonArea(outerRing(L.geoJSON(f).getLayers()[0]));
        L.popup().setLatLng(e.latlng).setContent(
          popupHtml(f.properties.nature === 'NC' ? 'Bâtiment' : f.properties.nature, {}, {}) +
          '<small>Emprise au sol : ' + fmtArea(area) + '</small>').openOn(map);
      }).catch(function () {});
    }, 0);
  });

  // ---------- Recherche ----------
  var searchIndex = [];
  var sInput = document.getElementById('search'), sList = document.getElementById('search-results');
  function norm(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  sInput.addEventListener('input', function () {
    var q = norm(sInput.value.trim());
    sList.innerHTML = '';
    if (q.length < 2) return;
    searchIndex.filter(function (it) { return norm(it.name).indexOf(q) >= 0; }).slice(0, 15).forEach(function (it) {
      var li = document.createElement('li');
      li.innerHTML = esc(it.name) + '<small>' + esc(it.type) + '</small>';
      li.addEventListener('click', function () { goTo(it); });
      sList.appendChild(li);
    });
    if (!sList.children.length) sList.innerHTML = '<li><small>Aucun résultat</small></li>';
  });
  sInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && sList.firstChild) sList.firstChild.click();
    if (e.key === 'Escape') { sList.innerHTML = ''; sInput.blur(); }
  });
  function goTo(it) {
    sList.innerHTML = ''; sInput.value = it.name;
    if (it.parent && !map.hasLayer(it.parent)) it.parent.addTo(map);
    if (it.layer.getLatLng) {
      map.flyTo(it.layer.getLatLng(), 17);
      map.once('moveend', function () { it.layer.openPopup(); });
      return;
    }
    var b = it.layer.getBounds();
    map.flyToBounds(b, { maxZoom: 17, padding: [40, 40] });
    var hl = L.geoJSON(it.layer.toGeoJSON(), { style: { color: '#00e5ff', weight: 8, opacity: 0.6, fill: false }, interactive: false }).addTo(map);
    setTimeout(function () { map.removeLayer(hl); }, 4000);
    map.once('moveend', function () { it.layer.getLayers()[0].openPopup(b.getCenter()); });
  }
  function indexNamed(group, typeLabel, parent) {
    var byName = {};
    group.eachLayer(function (l) {
      var n = l.feature && l.feature.properties.nom;
      if (!n || n === 'NC') return;
      (byName[n] = byName[n] || L.featureGroup()).addLayer(l);
    });
    Object.keys(byName).forEach(function (n) {
      searchIndex.push({ name: n, type: typeLabel, layer: byName[n], parent: parent || group });
    });
  }

  // ---------- Quartiers : recherche du quartier d'un point ----------
  var quartierFeatures = [];
  function inRing(x, y, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function quartierAt(latlng) {
    var hit = null;
    quartierFeatures.some(function (f) {
      var polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
      var ok = polys.some(function (poly) {
        return inRing(latlng.lng, latlng.lat, poly[0]) &&
          !poly.slice(1).some(function (hole) { return inRing(latlng.lng, latlng.lat, hole); });
      });
      if (ok) hit = f.properties.nom;
      return ok;
    });
    return hit;
  }

  // ---------- Chargement des couches de référence ----------
  var status = document.getElementById('load-status');
  var ready = Promise.all([
    loadOnce('limite_commune'), loadOnce('quartiers'), loadOnce('routes'), loadOnce('cours_eau'), loadOnce('surface_eau'),
    loadOnce('vegetation'), loadOnce('cimetieres'), loadOnce('terrains_sport'), loadOnce('aerodrome'), loadOnce('equipements')
  ]).then(function (res) {
    var D = {
      limite_commune: res[0], quartiers: res[1], routes: res[2], cours_eau: res[3], surface_eau: res[4],
      vegetation: res[5], cimetieres: res[6], terrains_sport: res[7], aerodrome: res[8], equipements: res[9]
    };
    status.classList.add('hidden');
    buildLayers(D);
    return D;
  }).catch(function (err) {
    status.textContent = 'Impossible de charger les couches : ' + err.message +
      '. Vérifiez que les services Docker sont démarrés (docker compose ps).';
    status.classList.add('error');
    throw err;
  });

  var communeBounds = null;

  function buildLayers(D) {
    // Limite et masque
    var commune = L.geoJSON(D.limite_commune, {
      style: { color: '#c8102e', weight: 3, dashArray: '8 4', fill: false }, interactive: false
    });
    communeBounds = commune.getBounds();
    map.fitBounds(communeBounds, { padding: [20, 20] });
    map.setMaxBounds(communeBounds.pad(1.5));
    var communeLatLngs = outerRing(commune.getLayers()[0]);
    var world = [[-90, -180], [-90, 180], [90, 180], [90, -180]];
    var mask = L.polygon([world, communeLatLngs], { stroke: false, fillColor: '#000', fillOpacity: 0.25, interactive: false });

    // Quartiers
    quartierFeatures = D.quartiers.features;
    var quartiers = markClicks(L.geoJSON(D.quartiers, {
      style: { color: '#7048e8', weight: 1.5, fillColor: '#7048e8', fillOpacity: 0 },
      onEachFeature: function (f, l) {
        var p = f.properties;
        l.bindTooltip(esc(p.nom), { permanent: true, direction: 'center', className: 'label-quartier' });
        l.bindPopup(popupHtml('Quartier ' + p.nom, {
          SUP: fmt(p.superficie_km2, 2) + ' km²', BAT: fmt(p.nb_batiments),
          DENS: fmt(p.nb_batiments / p.superficie_km2) + ' bât./km²'
        }, { SUP: 'Superficie', BAT: 'Bâtiments (OSM)', DENS: 'Densité' }));
        l.on('mouseover', function () { l.setStyle({ fillOpacity: 0.12 }); });
        l.on('mouseout', function () { l.setStyle({ fillOpacity: 0 }); });
      }
    }));
    function toggleQuartierLabels() {
      map.getContainer().classList.toggle('hide-quartier-labels', map.getZoom() < 13);
    }
    map.on('zoomend', toggleQuartierLabels);
    toggleQuartierLabels();

    // Voirie
    var routes = markClicks(L.geoJSON(D.routes, {
      style: function (f) {
        var s = ROUTE_STYLE[f.properties.nature] || { color: '#999', weight: 1.5 };
        return { color: s.color, weight: s.weight, dashArray: s.dashArray, opacity: 0.95 };
      },
      onEachFeature: function (f, l) {
        var p = f.properties;
        l.bindPopup(popupHtml(p.nom && p.nom !== 'NC' ? p.nom : (ROUTE_STYLE[p.nature] || {}).label || 'Voie', p,
          { nature: 'Type', numero: 'Numéro', cl_admin: 'Classe' }) +
          '<small>Longueur : ' + fmtLen(featureLength(l)) + '</small>');
      }
    }));

    // Hydrographie
    var coursEau = L.geoJSON(D.cours_eau, {
      style: function (f) { return { color: '#1c7ed6', weight: 2, dashArray: f.properties.regime === 'Intermittent' ? '5 4' : null }; },
      onEachFeature: function (f, l) { l.bindPopup(popupHtml(f.properties.nom || 'Cours d\'eau', f.properties, { regime: 'Régime' })); }
    });
    var hydro = markClicks(L.featureGroup([
      L.geoJSON(D.surface_eau, { style: { color: '#1971c2', weight: 1, fillColor: '#74c0fc', fillOpacity: 0.7 } }),
      coursEau
    ]));

    // Espaces verts & occupation
    var espaces = markClicks(L.featureGroup([
      L.geoJSON(D.vegetation, {
        style: { color: '#2b8a3e', weight: 1, fillColor: '#69db7c', fillOpacity: 0.45 },
        onEachFeature: function (f, l) { l.bindPopup(popupHtml(f.properties.nom || 'Zone boisée', f.properties, { nature: 'Type' })); }
      }),
      L.geoJSON(D.cimetieres, {
        style: { color: '#495057', weight: 1, fillColor: '#adb5bd', fillOpacity: 0.6 },
        onEachFeature: function (f, l) { l.bindPopup(popupHtml(f.properties.nom || 'Cimetière', f.properties, { nature: 'Type' })); }
      }),
      L.geoJSON(D.terrains_sport, {
        style: { color: '#0ca678', weight: 1, fillColor: '#96f2d7', fillOpacity: 0.6 },
        onEachFeature: function (f, l) { l.bindPopup('<b>Terrain de sport</b>'); }
      }),
      L.geoJSON(D.aerodrome, {
        style: { color: '#343a40', weight: 6, opacity: 0.7 },
        onEachFeature: function (f, l) { l.bindPopup('<b>Aéroport de Labé (Tata)</b><br><small>Piste</small>'); }
      })
    ]));

    // Équipements OSM
    var eqLayers = {};
    L.geoJSON(D.equipements, {
      pointToLayer: function (f, latlng) {
        var s = EQ_STYLE[f.properties.categorie] || { color: '#555', sym: '•' };
        return L.marker(latlng, {
          icon: L.divIcon({
            className: '', iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -10],
            html: '<div class="eq-icon" style="width:24px;height:24px;background:' + s.color + '">' + s.sym + '</div>'
          }),
          title: f.properties.nom || ''
        });
      },
      onEachFeature: function (f, l) {
        var p = f.properties;
        l.bindPopup(popupHtml(p.nom || p.nature, p, { categorie: 'Catégorie', nature: 'Nature' }));
        (eqLayers[p.categorie] = eqLayers[p.categorie] || L.layerGroup()).addLayer(l);
        if (p.nom) searchIndex.push({ name: p.nom, type: p.nature, layer: l });
      }
    });

    // Index de recherche
    quartiers.eachLayer(function (l) {
      searchIndex.push({ name: l.feature.properties.nom, type: 'Quartier', layer: L.featureGroup([l]), parent: quartiers });
    });
    indexNamed(routes, 'Voie');
    indexNamed(coursEau, 'Cours d\'eau', hydro);

    // Liste des couches
    addOverlay({ name: 'Limite communale', layer: commune, on: true,
      swatch: '<span class="swatch line" style="background:repeating-linear-gradient(90deg,#c8102e 0 6px,transparent 6px 9px)"></span>' });
    addOverlay({ name: 'Quartiers (' + D.quartiers.features.length + ')', layer: quartiers, on: true,
      swatch: '<span class="swatch" style="background:transparent;border:2px solid #7048e8"></span>' });
    addOverlay({ name: 'Masque hors commune', layer: mask, on: true,
      swatch: '<span class="swatch" style="background:rgba(0,0,0,.25)"></span>' });
    addOverlay({ name: 'Bâti (zoom ≥ ' + BATI_MIN_ZOOM + ')', on: true,
      onToggle: function (on) { batiWanted = on; updateBati(); },
      swatch: '<span class="swatch" style="background:#868e96"></span>',
      legend: [['Bâtiment', '#868e96'], ['En construction', '#f2c230'], ['Case / hutte', '#a0785a'], ['Scolaire', '#6f42c1']] });
    addOverlay({ name: 'Espaces verts & occupation', layer: espaces, on: true,
      swatch: '<span class="swatch" style="background:#69db7c"></span>',
      legend: [['Zone boisée', '#69db7c'], ['Cimetière', '#adb5bd'], ['Terrain de sport', '#96f2d7'], ['Piste aéroport', '#343a40']] });
    addOverlay({ name: 'Hydrographie', layer: hydro, on: true,
      swatch: '<span class="swatch line" style="background:#1c7ed6"></span>' });
    addOverlay({ name: 'Voirie', layer: routes, on: true,
      swatch: '<span class="swatch line" style="background:#e8590c"></span>',
      legend: Object.keys(ROUTE_STYLE).map(function (k) { return [ROUTE_STYLE[k].label, ROUTE_STYLE[k].color, 'line']; }) });
    Object.keys(EQ_STYLE).forEach(function (cat) {
      if (!eqLayers[cat]) return;
      addOverlay({ name: cat + ' (' + eqLayers[cat].getLayers().length + ')', layer: eqLayers[cat], on: true, group: 'Équipements (OSM)',
        swatch: '<span class="swatch dot" style="background:' + EQ_STYLE[cat].color + '"></span>' });
    });
    commune.bringToFront();
    updateBati();
    applyHash();

    L.marker(communeBounds.getCenter(), {
      icon: L.divIcon({ className: 'label-commune', html: 'LABÉ', iconSize: [60, 20], iconAnchor: [30, 10] }),
      interactive: false
    }).addTo(map);

    if (PAGE === 'public') loadPublicContributions();
    buildStats(D, eqLayers);
  }

  // ---------- Carte publique : contributions validées (lecture seule) ----------
  function loadPublicContributions() {
    var req = STATIC ? wfs('contributions') : Promise.all(
      ['contributions_points', 'contributions_lignes', 'contributions_surfaces'].map(wfs)
    ).then(function (fcs) {
      return { type: 'FeatureCollection', features: [].concat.apply([], fcs.map(function (fc) { return fc.features; })) };
    });
    req.then(function (fc) {
      var groups = {};
      L.geoJSON(fc, {
        style: function (f) {
          var c = (CATEGORIES[f.properties.categorie] || CATEGORIES.Autre).color;
          return { color: c, weight: 3, fillColor: c, fillOpacity: 0.3 };
        },
        pointToLayer: function (f, latlng) {
          var c = f.properties.statut === 'Traité' ? '#1f6f43' : (CATEGORIES[f.properties.categorie] || CATEGORIES.Autre).color;
          return L.circleMarker(latlng, { radius: 7, color: '#fff', weight: 2, fillColor: c, fillOpacity: 1 });
        },
        onEachFeature: function (f, l) {
          var p = f.properties;
          var date = p.date || (p.cree_le ? String(p.cree_le).slice(0, 10) : '');
          l.bindPopup(popupHtml(p.nom || p.type || p.categorie, {
            categorie: p.categorie, type: p.type, description: p.description, quartier: p.quartier,
            statut: p.statut === 'Traité' ? 'Traité' : null, date: date ? new Date(date).toLocaleDateString('fr-FR') : null
          }, { categorie: 'Catégorie', type: 'Type', description: 'Description', quartier: 'Quartier', statut: 'Suivi', date: 'Publié le' }));
          var cat = CATEGORIES[p.categorie] ? p.categorie : 'Autre';
          (groups[cat] = groups[cat] || markClicks(L.featureGroup())).addLayer(l);
          if (p.nom) searchIndex.push({ name: p.nom, type: p.type || p.categorie, layer: l.getLatLng ? l : L.featureGroup([l]) });
        }
      });
      Object.keys(CATEGORIES).forEach(function (cat) {
        if (!groups[cat]) return;
        addOverlay({ name: cat + ' (' + groups[cat].getLayers().length + ')', layer: groups[cat], on: true,
          group: 'Données de la mairie',
          swatch: '<span class="swatch dot" style="background:' + CATEGORIES[cat].color + '"></span>' });
      });
    }).catch(function () { /* aucune contribution publiée ou service indisponible */ });
  }

  // ---------- Statistiques (chiffres PostGIS via l'API) ----------
  function bars(entries, colorOf, unit, digits) {
    var max = Math.max.apply(null, entries.map(function (e) { return e[1]; }).concat([1]));
    return entries.map(function (e) {
      return '<div class="bar-row"><div class="lbl"><span>' + esc(e[0]) + '</span><span>' + fmt(e[1], digits) + unit + '</span></div>' +
        '<div class="bar"><div style="width:' + (100 * e[1] / max).toFixed(1) + '%;background:' + colorOf(e[0]) + '"></div></div></div>';
    }).join('');
  }
  function buildStats(D, eqLayers) {
    getJSON(STATIC ? 'data/stats.json' : '/api/stats', 'statistiques').then(function (st) {
      var nbBati = Object.keys(st.batiments).reduce(function (s, k) { return s + st.batiments[k]; }, 0);
      var kmTotal = Object.keys(st.routes_km).reduce(function (s, k) { return s + st.routes_km[k]; }, 0);
      var pub = st.contributions_publiees || {};
      var nbPub = Object.keys(pub).reduce(function (s, k) { return s + pub[k]; }, 0);

      var h = '<h3>Chiffres clés</h3><div class="stat-cards">' +
        '<div class="stat-card"><b>' + fmt(st.superficie_km2, 1) + ' km²</b><span>Superficie communale</span></div>' +
        '<div class="stat-card"><b>' + D.quartiers.features.length + '</b><span>Quartiers</span></div>' +
        '<div class="stat-card"><b>' + fmt(nbBati) + '</b><span>Bâtiments recensés (OSM)</span></div>' +
        '<div class="stat-card"><b>' + fmt(nbBati / st.superficie_km2) + '</b><span>Bâtiments / km²</span></div>' +
        '<div class="stat-card"><b>' + fmt(kmTotal) + ' km</b><span>Linéaire de voirie</span></div>' +
        '<div class="stat-card"><b>' + fmt(st.batiments['Bâtiment en construction'] || 0) + '</b><span>Bâtiments en construction</span></div>' +
        '<div class="stat-card"><b>' + nbPub + '</b><span>Données publiées par la mairie</span></div>' +
        '</div>';

      h += '<h3>Voirie par type</h3>' + bars(
        Object.keys(ROUTE_STYLE).filter(function (k) { return st.routes_km[k]; })
          .map(function (k) { return [ROUTE_STYLE[k].label, st.routes_km[k], k]; }),
        function (label) {
          var k = Object.keys(ROUTE_STYLE).filter(function (k) { return ROUTE_STYLE[k].label === label; })[0];
          return ROUTE_STYLE[k].color;
        }, ' km', 1);

      h += '<h3>Équipements OSM par catégorie</h3>' + bars(
        Object.keys(EQ_STYLE).filter(function (k) { return eqLayers[k]; })
          .map(function (k) { return [k, eqLayers[k].getLayers().length]; }),
        function (k) { return EQ_STYLE[k].color; }, '', 0);

      if (nbPub) {
        h += '<h3>Données publiées par catégorie</h3>' + bars(
          Object.keys(pub).map(function (k) { return [k, pub[k]]; }),
          function (k) { return (CATEGORIES[k] || CATEGORIES.Autre).color; }, '', 0);
      }
      h += '<h3>Quartiers</h3><table class="stat-table"><thead><tr><th>Quartier</th><th>km²</th><th>Bâtiments</th><th>Bât./km²</th></tr></thead><tbody>' +
        D.quartiers.features.slice().sort(function (a, b) { return b.properties.nb_batiments - a.properties.nb_batiments; })
          .map(function (f) {
            var p = f.properties;
            return '<tr><td>' + esc(p.nom) + '</td><td>' + fmt(p.superficie_km2, 1) + '</td><td>' + fmt(p.nb_batiments) +
              '</td><td>' + fmt(p.nb_batiments / p.superficie_km2) + '</td></tr>';
          }).join('') + '</tbody></table>';
      h += '<p class="hint">Sources : OSM2IGEO (mars 2023), limites OSM. Calculs PostGIS.</p>';
      document.getElementById('stats').innerHTML = h;
    }).catch(function () {
      document.getElementById('stats').innerHTML = '<p class="hint">Statistiques indisponibles.</p>';
    });
  }

  // ---------- Lien vers l'espace agents ----------
  var espaceLink = document.getElementById('link-espace');
  if (espaceLink) {
    if (CONFIG.espaceUrl) espaceLink.href = CONFIG.espaceUrl; else espaceLink.classList.add('hidden');
  }
  var espaceLink2 = document.getElementById('link-espace-2');
  if (espaceLink2) {
    if (CONFIG.espaceUrl) espaceLink2.href = CONFIG.espaceUrl; else espaceLink2.parentNode.classList.add('hidden');
  }

  // ---------- Onglets & panneau latéral ----------
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.tab, .panel').forEach(function (e) { e.classList.remove('active'); });
      t.classList.add('active');
      document.getElementById('tab-' + t.dataset.tab).classList.add('active');
    });
  });
  // Onglet demandé dans l'adresse de la page : ?onglet=adr
  var ongletDemande = new URLSearchParams(location.search).get('onglet');
  var tabBtn = ongletDemande && document.querySelector('.tab[data-tab="' + ongletDemande.replace(/[^a-z]/g, '') + '"]');
  if (tabBtn) tabBtn.click();
  if (window.innerWidth < 700) document.body.classList.add('collapsed');
  document.getElementById('btn-menu').addEventListener('click', function () {
    document.body.classList.toggle('collapsed');
    setTimeout(function () { map.invalidateSize(); }, 300);
  });

  // ---------- Lien partageable : #zoom/lat/lon ----------
  function applyHash() {
    var h = location.hash.slice(1).split('/').map(Number);
    if (h.length === 3 && h.every(isFinite)) map.setView([h[1], h[2]], h[0]);
    map.on('moveend', function () {
      var c = map.getCenter();
      history.replaceState(null, '', '#' + map.getZoom() + '/' + c.lat.toFixed(5) + '/' + c.lng.toFixed(5));
    });
  }

  // ---------- Coordonnées ----------
  var coordsDiv = document.getElementById('coords');
  map.on('mousemove', function (e) {
    coordsDiv.textContent = 'Lat ' + e.latlng.lat.toFixed(5) + ' · Lon ' + e.latlng.lng.toFixed(5) + ' · Zoom ' + map.getZoom();
  });

  // ---------- Dessin sur la carte (mesure et saisie de données) ----------
  var sketchBox = document.getElementById('measure-box');
  var SKETCH_COLOR = '#f2c230';

  function stopSketch() {
    if (!sketch) return;
    map.removeLayer(sketch.layer);
    if (sketch.btn) sketch.btn.classList.remove('on');
    sketch = null;
    sketchBox.classList.add('hidden');
    map.getContainer().classList.remove('crosshair');
    map.doubleClickZoom.enable();
  }
  // mode : 'point' | 'line' | 'area' ; opts : { measure, btn, label, onFinish(latlngs) }
  function startSketch(mode, opts) {
    opts = opts || {};
    var same = sketch && sketch.mode === mode && sketch.measure && opts.measure;
    stopSketch();
    if (same) return; // re-clic sur l'outil de mesure = arrêt
    sketch = { mode: mode, pts: [], layer: L.layerGroup().addTo(map), measure: !!opts.measure,
      onFinish: opts.onFinish, btn: opts.btn, label: opts.label };
    if (opts.btn) opts.btn.classList.add('on');
    map.getContainer().classList.add('crosshair');
    map.doubleClickZoom.disable();
    if (window.innerWidth < 700) document.body.classList.add('collapsed');
    drawSketch();
  }
  function sketchMeasureText() {
    var pts = sketch.pts;
    if (sketch.mode === 'line') return pts.length > 1 ? 'Distance : ' + fmtLen(lineLength(pts)) : '';
    if (sketch.mode === 'area') return pts.length > 2 ? 'Surface : ' + fmtArea(polygonArea(pts)) +
      ' · Périmètre : ' + fmtLen(lineLength(pts.concat([pts[0]]))) : '';
    return '';
  }
  function drawSketch() {
    var pts = sketch.pts;
    sketch.layer.clearLayers();
    if (sketch.mode === 'line') L.polyline(pts, { color: SKETCH_COLOR, weight: 3, dashArray: '6 4' }).addTo(sketch.layer);
    if (sketch.mode === 'area') L.polygon(pts, { color: SKETCH_COLOR, weight: 3, fillOpacity: 0.2 }).addTo(sketch.layer);
    pts.forEach(function (p) { L.circleMarker(p, { radius: 4, color: SKETCH_COLOR, fillOpacity: 1 }).addTo(sketch.layer); });

    var help = {
      point: 'Cliquez sur la carte pour placer le point.',
      line: 'Cliquez pour ajouter des sommets, double-cliquez ou « Terminer » pour finir.',
      area: 'Cliquez les sommets de la surface, double-cliquez ou « Terminer » pour finir.'
    }[sketch.mode];
    var txt = sketchMeasureText();
    var html = '<span>' + (sketch.label ? '<b>' + esc(sketch.label) + '</b> · ' : '') +
      (sketch.done ? esc(txt) + ' ✓' : esc(txt || help)) + '</span>';
    if (!sketch.measure && sketch.mode !== 'point') {
      html += ' <button data-a="undo">↶ Point</button> <button data-a="finish" class="primary">Terminer</button>';
    }
    html += ' <button data-a="cancel" title="Annuler (Échap)">✕</button>';
    sketchBox.innerHTML = html;
    sketchBox.classList.remove('hidden');
  }
  sketchBox.addEventListener('click', function (e) {
    var a = e.target.getAttribute('data-a');
    if (!a || !sketch) return;
    if (a === 'cancel') stopSketch();
    if (a === 'undo') { sketch.pts.pop(); drawSketch(); }
    if (a === 'finish') finishSketch();
  });
  L.DomEvent.disableClickPropagation(sketchBox);

  function finishSketch() {
    var min = { point: 1, line: 2, area: 3 }[sketch.mode];
    if (sketch.pts.length < min) {
      alert(sketch.mode === 'line' ? 'Une ligne doit avoir au moins 2 points.' : 'Une surface doit avoir au moins 3 points.');
      return;
    }
    if (sketch.measure) {
      sketch.done = true;
      map.getContainer().classList.remove('crosshair');
      return drawSketch();
    }
    var pts = sketch.pts.slice(), cb = sketch.onFinish;
    stopSketch();
    if (cb) cb(pts);
  }
  // Capture des clics pour les outils (dessin, choix d'un point).
  // On écoute « preclick » et non « click » : un clic sur un objet qui ouvre une fiche (ex. un quartier,
  // qui couvre toute la commune) est stoppé par Leaflet et n'arrive jamais à la carte en « click ».
  var captureClic = null, derniereCapture = 0;
  map.on('preclick', function (e) {
    if (!sketch && !captureClic) return;
    derniereCapture = Date.now();
    lastFeatureClick = derniereCapture; // pas d'interrogation du bâti pour ce clic
    if (sketch) onSketchClick(e); else captureClic(e);
  });
  // la fiche de l'objet cliqué ne doit pas s'ouvrir pendant qu'un outil attend un clic
  // (les fiches ouvertes par l'outil lui-même portent l'option « outil »)
  map.on('popupopen', function (e) {
    if (!e.popup.options.outil && Date.now() - derniereCapture < 400) map.closePopup(e.popup);
  });
  function capturerClic(fn) { captureClic = fn; }
  function libererClic() { captureClic = null; }

  function onSketchClick(e) {
    if (sketch.done) { // nouvelle mesure après une mesure terminée
      sketch.done = false; sketch.pts = [];
      map.getContainer().classList.add('crosshair');
    }
    sketch.pts.push(e.latlng);
    if (sketch.mode === 'point') return finishSketch();
    drawSketch();
  }
  map.on('dblclick', function () {
    if (!sketch || sketch.done || sketch.mode === 'point') return;
    sketch.pts.pop(); // le double-clic a déclenché un clic en trop
    finishSketch();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') stopSketch();
  });

  // ---------- Outils ----------
  var Tools = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      var c = L.DomUtil.create('div', 'leaflet-bar tool-bar');
      function btn(html, title, fn) {
        var a = L.DomUtil.create('a', '', c);
        a.href = '#'; a.innerHTML = html; a.title = title;
        L.DomEvent.on(a, 'click', function (ev) { L.DomEvent.stop(ev); fn(a); });
      }
      btn('⌂', 'Vue de la commune', function () { if (communeBounds) map.fitBounds(communeBounds, { padding: [20, 20] }); });
      btn('📏', 'Mesurer une distance', function (a) { startSketch('line', { measure: true, btn: a }); });
      btn('⬠', 'Mesurer une surface', function (a) { startSketch('area', { measure: true, btn: a }); });
      btn('◎', 'Me localiser', function () { map.locate({ setView: true, maxZoom: 17 }); });
      btn('🖨', 'Imprimer la carte', function () { window.print(); });
      L.DomEvent.disableClickPropagation(c);
      return c;
    }
  });
  map.addControl(new Tools());

  var locLayer = L.layerGroup().addTo(map);
  map.on('locationfound', function (e) {
    locLayer.clearLayers();
    L.circle(e.latlng, { radius: e.accuracy, weight: 1, fillOpacity: 0.1 }).addTo(locLayer);
    L.circleMarker(e.latlng, { radius: 7, color: '#fff', weight: 2, fillColor: '#1c7ed6', fillOpacity: 1 })
      .bindPopup('Vous êtes ici (± ' + Math.round(e.accuracy) + ' m)').addTo(locLayer).openPopup();
  });
  map.on('locationerror', function () { alert('Géolocalisation impossible. Vérifiez les autorisations du navigateur.'); });

  // ---------- API interne pour contributions.js ----------
  window.LabeApp = {
    map: map, ready: ready, esc: esc, CATEGORIES: CATEGORIES, STATIC: STATIC, wfs: wfs, loadOnce: loadOnce, outerRing: outerRing, noteFeatureClick: noteFeatureClick, capturerClic: capturerClic, libererClic: libererClic, fmt: fmt, popupHtml: popupHtml,
    fmtLen: fmtLen, fmtArea: fmtArea, lineLength: lineLength, polygonArea: polygonArea,
    startSketch: startSketch, stopSketch: stopSketch, addOverlay: addOverlay, markClicks: markClicks,
    quartierAt: quartierAt, searchIndex: searchIndex,
    quartierNames: function () { return quartierFeatures.map(function (f) { return f.properties.nom; }).sort(); }
  };
})();
