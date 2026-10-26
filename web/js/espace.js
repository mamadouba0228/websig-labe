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
      mot_de_passe: f.mot_de_passe.value
    }).then(function (r) {
      registerForm.reset();
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
  function enter() {
    var u = Auth.user();
    screen.classList.add('hidden');
    document.getElementById('user-menu').classList.remove('hidden');
    document.getElementById('user-name').innerHTML = esc(u.nom) + ' <span class="role-badge role-' + u.role + '">' +
      Auth.ROLE_LABEL[u.role] + '</span>';
    document.getElementById('link-admin').classList.toggle('hidden', !Auth.isValidator());
    renderAccount(u);
    if (!started) { started = true; LabeContrib.start(); }
  }

  Auth.refresh().then(function (u) { if (u) enter(); });
})();
