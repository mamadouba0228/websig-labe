/* Session des agents : jeton stocké dans le navigateur, appels authentifiés à l'API. */
(function () {
  'use strict';

  var KEY = 'labe-session';
  var ROLE_LABEL = { agent: 'Agent', superviseur: 'Superviseur', admin: 'Administrateur' };

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; }
  }
  var session = load();

  function api(method, path, body) {
    var h = { 'Content-Type': 'application/json' };
    if (session) h.Authorization = 'Bearer ' + session.jeton;
    return fetch('/api' + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (r.status === 401 && session) { clear(); Auth.onExpired(); }
          if (!r.ok) {
            var msg = 'Erreur ' + r.status;
            if (typeof data.detail === 'string') msg = data.detail;
            else if (Array.isArray(data.detail)) msg = 'Champ invalide : ' + data.detail.map(function (d) { return d.loc.slice(-1)[0]; }).join(', ');
            else if (data.detail && data.detail.message) msg = data.detail.message;
            var err = new Error(msg); err.status = r.status; err.detail = data.detail; throw err;
          }
          return data;
        });
      });
  }
  // Image protégée (photo) : chargée avec le jeton puis affichée en URL locale
  function blobUrl(path) {
    return fetch(path, { headers: session ? { Authorization: 'Bearer ' + session.jeton } : {} })
      .then(function (r) { if (!r.ok) throw new Error(); return r.blob(); })
      .then(function (b) { return URL.createObjectURL(b); });
  }
  function clear() { session = null; localStorage.removeItem(KEY); }

  // Services communaux (onglets) : { modules: [{id, label}], suggestions: {service: [id…]} }
  var listeModules = null;
  function modules() {
    if (!listeModules) listeModules = api('GET', '/modules').catch(function (e) { listeModules = null; throw e; });
    return listeModules;
  }
  // Cases à cocher des services dans un conteneur ; renvoie une fonction qui lit les cases cochées
  function casesModules(el, liste, coches) {
    el.querySelectorAll('label.check').forEach(function (x) { x.remove(); });
    liste.forEach(function (m) {
      var l = document.createElement('label'), c = document.createElement('input');
      l.className = 'check'; c.type = 'checkbox'; c.value = m.id; c.checked = (coches || []).indexOf(m.id) >= 0;
      l.appendChild(c); l.appendChild(document.createTextNode(' ' + m.label)); el.appendChild(l);
    });
  }
  function modulesCoches(el) {
    return Array.prototype.filter.call(el.querySelectorAll('input[type=checkbox]'), function (c) { return c.checked; })
      .map(function (c) { return c.value; });
  }

  var Auth = {
    ROLE_LABEL: ROLE_LABEL,
    api: api,
    blobUrl: blobUrl,
    modules: modules, casesModules: casesModules, modulesCoches: modulesCoches,
    // Superviseurs et administrateurs voient tous les services ; un agent, ceux de son compte
    aAcces: function (m) { var u = Auth.user(); return !!u && (Auth.isValidator() || (u.modules || []).indexOf(m) >= 0); },
    user: function () { return session && session.utilisateur; },
    isValidator: function () { var u = Auth.user(); return !!u && (u.role === 'superviseur' || u.role === 'admin'); },
    isAdmin: function () { var u = Auth.user(); return !!u && u.role === 'admin'; },
    login: function (email, pwd) {
      return api('POST', '/auth/connexion', { email: email, mot_de_passe: pwd }).then(function (r) {
        session = { jeton: r.jeton, utilisateur: r.utilisateur };
        localStorage.setItem(KEY, JSON.stringify(session));
        return r.utilisateur;
      });
    },
    logout: function () {
      var p = session ? api('POST', '/auth/deconnexion') : Promise.resolve();
      return p.catch(function () {}).then(clear);
    },
    // Vérifie la session auprès du serveur (rôle à jour, compte toujours actif)
    refresh: function () {
      if (!session) return Promise.resolve(null);
      return api('GET', '/auth/moi').then(function (u) {
        session.utilisateur = u;
        localStorage.setItem(KEY, JSON.stringify(session));
        return u;
      }).catch(function (e) {
        // hors connexion (pas de réponse, ou réponse « hors connexion » du service worker) : on garde la session
        return session && (!e.status || e.status === 503) ? session.utilisateur : null;
      });
    },
    onExpired: function () { location.href = 'espace.html'; }
  };
  window.Auth = Auth;
})();
