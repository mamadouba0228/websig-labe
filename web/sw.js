/* Service worker : l'espace agents reste utilisable sans réseau (sur le terrain).
 * - pages, scripts et styles : réseau d'abord (mises à jour immédiates), copie locale si hors connexion ;
 * - données (API, WFS de GeoServer, relief) : réseau d'abord, dernière copie si hors connexion ;
 * - fonds de carte et images du bâti (WMS) : copie locale d'abord, pour les zones déjà consultées ;
 * - bibliothèques (CDN) : copie locale d'abord.
 * Les envois (POST, PUT…) ne passent jamais par le cache : sans réseau, la saisie est mise en file d'attente
 * par js/terrain.js et envoyée au retour de la connexion. */
var VERSION = 'labe-v1';
var COQUILLE = ['espace.html', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icons/icone-192.png',
  'js/config.js', 'js/auth.js', 'js/app.js', 'js/terrain.js', 'js/edition.js', 'js/contributions.js', 'js/suivi.js',
  'js/adressage.js', 'js/adressage-public.js', 'js/itineraire.js', 'js/selection.js', 'js/analyses.js', 'js/relief.js',
  'js/identify.js', 'js/espace.js'];
var MAX_TUILES = 4000;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION + '-app').then(function (c) {
    // chaque fichier séparément : un fichier absent (ex. version publique) n'empêche pas l'installation
    return Promise.all(COQUILLE.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(VERSION) !== 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function reseauDabord(req, cache) {
  return fetch(req).then(function (r) {
    if (r.ok) { var copie = r.clone(); caches.open(cache).then(function (c) { c.put(req, copie); }); }
    return r;
  }).catch(function () {
    return caches.match(req, { ignoreVary: true }).then(function (r) {
      return r || new Response(JSON.stringify({ detail: 'Hors connexion' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    });
  });
}
function cacheDabord(req, cache, limite) {
  return caches.match(req).then(function (r) {
    return r || fetch(req).then(function (rep) {
      if (rep.ok || rep.type === 'opaque') {
        var copie = rep.clone();
        caches.open(cache).then(function (c) {
          c.put(req, copie);
          if (limite) c.keys().then(function (k) { if (k.length > limite) k.slice(0, k.length - limite).forEach(function (x) { c.delete(x); }); });
        });
      }
      return rep;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  var memeSite = url.origin === self.location.origin;

  if (memeSite && /\/geoserver\/.*(GetMap|wms\?)/i.test(url.pathname + url.search) && !/GetFeatureInfo/i.test(url.search)) {
    return e.respondWith(cacheDabord(req, VERSION + '-tuiles', MAX_TUILES));
  }
  if (memeSite && (url.pathname.indexOf('/api/') >= 0 || url.pathname.indexOf('/geoserver/') >= 0 || url.pathname.indexOf('/data/') >= 0)) {
    return e.respondWith(reseauDabord(req, VERSION + '-donnees'));
  }
  if (memeSite) return e.respondWith(reseauDabord(req, VERSION + '-app'));
  if (/tile\.openstreetmap\.org|arcgisonline\.com|opentopomap\.org|basemaps\.cartocdn\.com/.test(url.hostname)) {
    return e.respondWith(cacheDabord(req, VERSION + '-tuiles', MAX_TUILES));
  }
  if (/unpkg\.com|cdn\.jsdelivr\.net/.test(url.hostname)) return e.respondWith(cacheDabord(req, VERSION + '-cdn'));
});
