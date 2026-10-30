/* Travail sur le terrain (espace agents, téléphone) :
 * - application installable et utilisable hors connexion (service worker sw.js) ;
 * - file d'attente des saisies faites sans réseau, envoyées automatiquement au retour de la connexion ;
 * - saisie à la position GPS et tracé d'une ligne ou d'une surface en marchant. */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc;
  function $(id) { return document.getElementById(id); }

  // ---------- Application installable / hors connexion ----------
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  // ---------- Identifiant unique d'une saisie (évite les doublons quand un envoi est répété) ----------
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  // ---------- File d'attente (IndexedDB) ----------
  var dbp = null;
  function db() {
    return dbp || (dbp = new Promise(function (ok, ko) {
      var r = indexedDB.open('labe-terrain', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('file', { keyPath: 'uid' }); };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { ko(r.error); };
    }));
  }
  function store(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (ok, ko) {
        var tx = d.transaction('file', mode), res = fn(tx.objectStore('file'));
        tx.oncomplete = function () { ok(res && res.result); };
        tx.onerror = function () { ko(tx.error); };
      });
    });
  }
  function lister() { return store('readonly', function (s) { return s.getAll(); }).then(function (l) { return l || []; }); }
  function ajouter(item) { return store('readwrite', function (s) { s.put(item); }); }
  function retirer(uid) { return store('readwrite', function (s) { s.delete(uid); }); }

  function reseauIndisponible(e) { return !e.status; } // erreur réseau (pas de réponse du serveur)

  // Envoie une nouvelle saisie ; sans réseau, elle est gardée dans le téléphone. Résultat : { feature } ou { enAttente: true }
  function envoyer(body) {
    body.properties.uid = body.properties.uid || uuid();
    if (!navigator.onLine) return mettreEnAttente(body);
    return Auth.api('POST', '/contributions', body).then(function (f) { return { feature: f }; }, function (e) {
      if (reseauIndisponible(e)) return mettreEnAttente(body);
      throw e;
    });
  }
  function mettreEnAttente(body) {
    return ajouter({ uid: body.properties.uid, body: body, cree_le: new Date().toISOString(), erreur: null })
      .then(function () { majFile(); return { enAttente: true }; });
  }

  var enCours = false;
  function synchroniser(manuel) {
    if (enCours || !Auth.user()) return Promise.resolve();
    enCours = true;
    var envoyees = 0;
    return lister().then(function (items) {
      var chain = Promise.resolve(), stop = false;
      items.forEach(function (it) {
        chain = chain.then(function () {
          if (stop) return;
          return Auth.api('POST', '/contributions', it.body).then(function () { envoyees++; return retirer(it.uid); }, function (e) {
            if (reseauIndisponible(e) || e.status === 401) { stop = true; return; }
            it.erreur = e.message;                        // refusée par le serveur : l'agent décide (corriger ou supprimer)
            return ajouter(it);
          });
        });
      });
      return chain;
    }).then(function () {
      enCours = false;
      majFile();
      if (envoyees) {
        if (window.LabeContrib) LabeContrib.recharger();
        if (manuel !== false) toast(envoyees + ' saisie(s) envoyée(s) au serveur.');
      }
    }, function () { enCours = false; });
  }

  // ---------- Affichage : état du réseau, saisies en attente ----------
  var attenteLayer = L.featureGroup();
  function majFile() {
    return lister().then(function (items) {
      var box = $('terrain-file');
      if (!box) return;
      var hors = !navigator.onLine;
      $('terrain-reseau').className = 'terrain-reseau ' + (hors ? 'hors' : 'en');
      $('terrain-reseau').textContent = hors ? '● Hors connexion — les saisies sont gardées dans l\'appareil' : '● Connecté';
      attenteLayer.clearLayers();
      if (!items.length) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="terrain-attente"><b>' + items.length + ' saisie(s) en attente d\'envoi</b>' +
        (hors ? '' : ' <button type="button" id="terrain-sync" class="primary">Envoyer maintenant</button>') +
        '<ul>' + items.map(function (it) {
          var p = it.body.properties;
          return '<li><span>' + esc(p.nom || p.type || p.categorie) + ' <small>' + new Date(it.cree_le).toLocaleString('fr-FR') + '</small>' +
            (it.erreur ? '<br><small class="form-msg">Refusée : ' + esc(it.erreur) + '</small>' : '') + '</span>' +
            (it.erreur ? '<button type="button" data-suppr="' + it.uid + '" class="danger">Supprimer</button>' : '') + '</li>';
        }).join('') + '</ul></div>';
      items.forEach(function (it) {
        L.geoJSON(it.body.geometry, {
          style: { color: '#495057', weight: 3, dashArray: '2 5', fillOpacity: 0.1 },
          pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 8, color: '#495057', weight: 2, dashArray: '2 3', fillColor: '#fff', fillOpacity: 0.9 }); }
        }).bindTooltip('En attente d\'envoi : ' + esc(it.body.properties.type || it.body.properties.categorie)).addTo(attenteLayer);
      });
      if ($('terrain-sync')) $('terrain-sync').onclick = function () { synchroniser(true); };
      box.querySelectorAll('[data-suppr]').forEach(function (b) {
        b.onclick = function () { if (confirm('Supprimer cette saisie refusée ?')) retirer(b.dataset.suppr).then(majFile); };
      });
    }).catch(function () {});
  }
  window.addEventListener('online', function () { majFile(); synchroniser(true); });
  window.addEventListener('offline', majFile);
  setInterval(function () { if (navigator.onLine) synchroniser(false); }, 60000);

  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('out'); }, 3500);
    setTimeout(function () { t.remove(); }, 4200);
  }

  // ---------- GPS ----------
  var gpsLayer = L.layerGroup().addTo(map), gpsWatch = null, gpsDernier = null, gpsAbonnes = [];
  function gpsDemarrer() {
    if (gpsWatch !== null) return true;
    if (!navigator.geolocation) { alert('Ce navigateur ne donne pas accès au GPS.'); return false; }
    gpsWatch = navigator.geolocation.watchPosition(function (p) {
      gpsDernier = { ll: L.latLng(p.coords.latitude, p.coords.longitude), precision: p.coords.accuracy, t: Date.now() };
      gpsLayer.clearLayers();
      L.circle(gpsDernier.ll, { radius: gpsDernier.precision, color: '#1c7ed6', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(gpsLayer);
      L.circleMarker(gpsDernier.ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#1c7ed6', fillOpacity: 1, interactive: false }).addTo(gpsLayer);
      gpsAbonnes.slice().forEach(function (fn) { fn(gpsDernier); });
    }, function (e) {
      gpsAbonnes.slice().forEach(function (fn) { fn(null, e); });
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
    return true;
  }
  function gpsArreter() {
    if (gpsWatch !== null && !gpsAbonnes.length) { navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; gpsLayer.clearLayers(); }
  }
  function abonner(fn) { gpsAbonnes.push(fn); gpsDemarrer(); if (gpsDernier && Date.now() - gpsDernier.t < 5000) fn(gpsDernier); }
  function desabonner(fn) { var i = gpsAbonnes.indexOf(fn); if (i >= 0) gpsAbonnes.splice(i, 1); gpsArreter(); }

  var boite = null;
  function boiteGps(html) {
    if (!boite) {
      boite = document.createElement('div');
      boite.className = 'measure-box gps-box';
      document.body.appendChild(boite);
      L.DomEvent.disableClickPropagation(boite);
    }
    boite.innerHTML = html;
    boite.classList.remove('hidden');
    return boite;
  }
  function fermerBoite() { if (boite) boite.classList.add('hidden'); }
  function qualite(pr) { return pr <= 10 ? 'bonne' : pr <= 25 ? 'moyenne' : 'faible'; }

  // Point à la position actuelle : on attend une précision suffisante (ou l'agent valide lui-même)
  function pointGps(onFinish) {
    var fini = false;
    function suivre(pos, err) {
      if (fini) return;
      if (!pos) {
        boiteGps('<span>Position introuvable : ' + esc(err && err.message || 'GPS indisponible') + '. Activez la localisation.</span> <button data-a="x">✕</button>');
        return;
      }
      map.setView(pos.ll, Math.max(map.getZoom(), 18));
      boiteGps('<span><b>Position GPS</b> · précision ' + Math.round(pos.precision) + ' m <span class="gps-q ' + qualite(pos.precision) + '">' +
        qualite(pos.precision) + '</span>' + (pos.precision > 10 ? ' — patientez à découvert…' : '') + '</span> ' +
        '<button data-a="ok" class="primary">Utiliser cette position</button> <button data-a="x">✕</button>');
    }
    boiteGps('<span>Recherche de la position GPS…</span> <button data-a="x">✕</button>');
    boite.onclick = function (e) {
      var a = e.target.dataset.a;
      if (a === 'x') terminer();
      if (a === 'ok' && gpsDernier) { var ll = gpsDernier.ll; terminer(); onFinish(ll); }
    };
    function terminer() { fini = true; desabonner(suivre); fermerBoite(); }
    abonner(suivre);
  }

  // Tracé en marchant : un sommet tous les 5 m environ, si la précision est correcte
  function traceGps(mode, onFinish) {
    var pts = [], pause = false, trace = L.layerGroup().addTo(map);
    function dessiner() {
      trace.clearLayers();
      if (pts.length > 1) (mode === 'area' ? L.polygon(pts, { color: '#f2c230', weight: 3, fillOpacity: 0.15 }) : L.polyline(pts, { color: '#f2c230', weight: 4 })).addTo(trace);
      var long = pts.length > 1 ? A.fmtLen(A.lineLength(mode === 'area' ? pts.concat([pts[0]]) : pts)) : '—';
      boiteGps('<span><b>' + (mode === 'area' ? 'Surface' : 'Ligne') + ' en marchant</b> · ' + pts.length + ' point(s) · ' + long +
        (gpsDernier ? ' · précision ' + Math.round(gpsDernier.precision) + ' m' : '') + (pause ? ' · <b>en pause</b>' : '') + '</span> ' +
        '<button data-a="p">' + (pause ? '▶ Reprendre' : '⏸ Pause') + '</button> <button data-a="u">↶ Point</button> ' +
        '<button data-a="ok" class="primary">Terminer</button> <button data-a="x">✕</button>');
    }
    function suivre(pos) {
      if (!pos || pause || pos.precision > 25) { dessiner(); return; }
      var last = pts[pts.length - 1];
      if (!last || map.distance(last, pos.ll) >= 5) { pts.push(pos.ll); map.panTo(pos.ll); }
      dessiner();
    }
    dessiner();
    boite.onclick = function (e) {
      var a = e.target.dataset.a;
      if (a === 'p') { pause = !pause; dessiner(); }
      if (a === 'u') { pts.pop(); dessiner(); }
      if (a === 'x' && (pts.length < 2 || confirm('Abandonner ce tracé ?'))) terminer();
      if (a === 'ok') {
        if (pts.length < (mode === 'area' ? 3 : 2)) return alert('Marchez encore : pas assez de points enregistrés.');
        var res = pts.slice(); terminer(); onFinish(res);
      }
    };
    function terminer() { desabonner(suivre); map.removeLayer(trace); fermerBoite(); }
    abonner(suivre);
  }

  // ---------- Démarrage (après connexion) ----------
  window.LabeTerrain = {
    envoyer: envoyer, synchroniser: synchroniser, pointGps: pointGps, traceGps: traceGps, uuid: uuid, toast: toast,
    position: function (onPos) { // une position (pour la tournée de pose), sans attendre une grande précision
      var fn = function (pos, err) { desabonner(fn); onPos(pos, err); };
      abonner(fn);
    },
    start: function () {
      A.ready.then(function () {
        A.addOverlay({ name: 'Saisies en attente d\'envoi', layer: attenteLayer, on: true, group: 'Données de la mairie',
          swatch: '<span class="swatch dot" style="background:#fff;border:2px dashed #495057"></span>' });
      });
      majFile();
      synchroniser(true);
    }
  };
})();
