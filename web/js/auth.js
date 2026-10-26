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
            var err = new Error(msg); err.status = r.status; throw err;
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

  var Auth = {
    ROLE_LABEL: ROLE_LABEL,
    api: api,
    blobUrl: blobUrl,
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
      }).catch(function () { return null; });
    },
    onExpired: function () { location.href = 'espace.html'; }
  };
  window.Auth = Auth;
})();
