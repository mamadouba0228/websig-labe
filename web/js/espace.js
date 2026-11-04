/* Espace agents : connexion, inscription, compte. Démarre le module de saisie une fois connecté. */
(function () {
  'use strict';

  var esc = LabeApp.esc;
  var screen = document.getElementById('auth-screen');
  var loginForm = document.getElementById('login-form'), registerForm = document.getElementById('register-form');

  function msg(id, text, ok) {
    var el = document.getElementById(id);
    el.textContent = text || '';
    el.className = 'form-msg' + (ok ? ' ok' : '');
  }

  // Onglets Connexion / Créer un compte
  document.querySelectorAll('.auth-tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.auth-tab').forEach(function (x) { x.classList.toggle('active', x === t); });
      var reg = t.getAttribute('data-auth') === 'register';
      loginForm.classList.toggle('hidden', reg);
      registerForm.classList.toggle('hidden', !reg);
    });
  });

  // Services communaux (liste fournie par l'API)
  Auth.api('GET', '/services').then(function (list) {
    var sel = registerForm.elements.service;
    sel.add(new Option('— choisir —', ''));
    list.forEach(function (s) { sel.add(new Option(s, s)); });
  }).catch(function () { msg('register-msg', 'Serveur injoignable.'); });

  // Services communaux demandés : proposés d'office selon le service choisi
  var regModules = document.getElementById('register-modules'), MODULES = [], SUGG = {};
  Auth.modules().then(function (r) {
    MODULES = r.modules; SUGG = r.suggestions;
    Auth.casesModules(regModules, MODULES, []);
    if (Auth.user()) renderAccount(Auth.user());
  }).catch(function () {});
  registerForm.elements.service.addEventListener('change', function () {
    Auth.casesModules(regModules, MODULES, SUGG[registerForm.elements.service.value] || []);
  });

  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    msg('login-msg', '');
    var btn = loginForm.querySelector('button'); btn.disabled = true;
    Auth.login(loginForm.elements.email.value.trim(), loginForm.elements.mot_de_passe.value)
      .then(function () { loginForm.reset(); enter(); })
      .catch(function (err) { msg('login-msg', err.message); })
      .then(function () { btn.disabled = false; });
  });

  registerForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = registerForm.elements;
    if (f.mot_de_passe.value !== f.confirmation.value) return msg('register-msg', 'Les mots de passe ne correspondent pas.');
    var btn = registerForm.querySelector('button'); btn.disabled = true;
    Auth.api('POST', '/auth/inscription', {
      nom: f.nom.value.trim(), email: f.email.value.trim(), service: f.service.value,
      fonction: f.fonction.value.trim() || null, telephone: f.telephone.value.trim() || null,
      mot_de_passe: f.mot_de_passe.value, modules: Auth.modulesCoches(regModules)
    }).then(function (r) {
      registerForm.reset();
      Auth.casesModules(regModules, MODULES, []);
      msg('register-msg', r.message, true);
    }).catch(function (err) { msg('register-msg', err.message); })
      .then(function () { btn.disabled = false; });
  });

  document.getElementById('btn-logout').addEventListener('click', function () {
    Auth.logout().then(function () { location.reload(); });
  });

  // Mon compte
  function renderAccount(u) {
    var rows = [['Nom', u.nom], ['E-mail', u.email], ['Service', u.service], ['Fonction', u.fonction],
      ['Téléphone', u.telephone], ['Rôle', Auth.ROLE_LABEL[u.role]],
      ['Services communaux', Auth.isValidator() ? 'Tous (' + Auth.ROLE_LABEL[u.role].toLowerCase() + ')' :
        MODULES.filter(function (m) { return (u.modules || []).indexOf(m.id) >= 0; }).map(function (m) { return m.label; }).join(', ') ||
        'Aucun (demandez l\'accès à l\'administrateur)'],
      ['Compte créé le', new Date(u.cree_le).toLocaleDateString('fr-FR')]];
    document.getElementById('account-info').innerHTML = rows.filter(function (r) { return r[1]; })
      .map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('');
  }
  document.getElementById('pwd-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target.elements;
    if (f.nouveau.value !== f.confirmation.value) return alert('Les mots de passe ne correspondent pas.');
    Auth.api('PUT', '/auth/mot-de-passe', { ancien: f.ancien.value, nouveau: f.nouveau.value })
      .then(function () { e.target.reset(); alert('Mot de passe modifié.'); })
      .catch(function (err) { alert(err.message); });
  });

  var started = false;
  var SERVICES_JS = { adr: 'LabeAdressage', fon: 'LabeFoncier', dech: 'LabeDechets', env: 'LabeEnvironnement',
    res: 'LabeReseaux', mar: 'LabeMarches' };
  function enter() {
    var u = Auth.user();
    screen.classList.add('hidden');
    document.getElementById('user-menu').classList.remove('hidden');
    document.getElementById('user-name').innerHTML = esc(u.nom) + ' <span class="role-badge role-' + u.role + '">' +
      Auth.ROLE_LABEL[u.role] + '</span>';
    document.getElementById('link-admin').classList.toggle('hidden', !Auth.isValidator());
    renderAccount(u);
    if (!started) {
      started = true;
      // Outils : ouverts à tous les agents
      LabeTerrain.start(); LabeContrib.start(); LabeSuivi.start();
      // Services communaux : seulement ceux du compte ; pour les autres, la couche publique reste sur la carte
      var nb = 0;
      Object.keys(SERVICES_JS).forEach(function (m) {
        var ok = Auth.aAcces(m), tab = document.querySelector('.tab[data-tab="' + m + '"]');
        if (tab) tab.classList.toggle('hidden', !ok);
        if (ok) { nb++; window[SERVICES_JS[m]].start(); }
        else if (window.LabeCartesPubliques && LabeCartesPubliques[m]) LabeCartesPubliques[m]();
      });
      document.getElementById('tg-services-vide').classList.toggle('hidden', nb > 0);
    }
  }

  Auth.refresh().then(function (u) { if (u) enter(); });
})();
