/* Administration : tableau de bord, validation des saisies, comptes, journal. */
(function () {
  'use strict';

  var ROLE = Auth.ROLE_LABEL;
  var STATUT_COMPTE = { en_attente: 'En attente', actif: 'Actif', desactive: 'Désactivé' };
  Auth.onExpired = function () { location.href = 'espace.html'; };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(s, time) {
    if (!s) return '—';
    var d = new Date(s);
    return time ? d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : d.toLocaleDateString('fr-FR');
  }
  function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function fail(e) { alert('Erreur : ' + e.message); }
  function cls(statut) { return 's-' + String(statut).replace(/\s/g, '-'); }

  // ---------- Navigation ----------
  var loaders = {};
  function show(view) {
    document.querySelectorAll('.admin-tab').forEach(function (t) { t.classList.toggle('active', t.dataset.view === view); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('hidden', v.id !== 'view-' + view); });
    if (loaders[view]) loaders[view]();
    history.replaceState(null, '', '#' + view);
  }
  document.querySelectorAll('.admin-tab').forEach(function (t) {
    t.addEventListener('click', function () { show(t.dataset.view); });
  });
  document.getElementById('btn-logout').addEventListener('click', function () {
    Auth.logout().then(function () { location.href = 'espace.html'; });
  });

  // ---------- Tableau de bord ----------
  // Une seule série par graphique → une seule couleur ; valeurs écrites en texte, infobulle au survol.
  function barList(el, rows, total) {
    var max = Math.max.apply(null, rows.map(function (r) { return r.n; }).concat([1]));
    el.innerHTML = rows.length ? rows.map(function (r) {
      var pct = total ? Math.round(100 * r.n / total) : 0;
      return '<div class="bar-row" title="' + esc(r.label) + ' : ' + r.n + ' saisie(s), ' + pct + ' %">' +
        '<div class="lbl"><span>' + esc(r.label) + '</span><span>' + r.n + '</span></div>' +
        '<div class="bar"><div style="width:' + (100 * r.n / max).toFixed(1) + '%"></div></div></div>';
    }).join('') : '<p class="hint">Aucune saisie pour le moment.</p>';
  }
  function dayChart(el, days) {
    var max = Math.max.apply(null, days.map(function (d) { return d.n; }).concat([1]));
    el.innerHTML = '<div class="cols">' + days.map(function (d) {
      var h = d.n ? Math.max(4, Math.round(100 * d.n / max)) : 0;
      var label = new Date(d.jour).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
      return '<div class="col" tabindex="0" data-tip="' + esc(label) + ' : ' + d.n + ' saisie(s)">' +
        '<div class="col-bar" style="height:' + h + '%"></div></div>';
    }).join('') + '</div><div class="cols-axis"><span>' +
      new Date(days[0].jour).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + '</span><span>max ' + max +
      ' / jour</span><span>aujourd\'hui</span></div><div class="col-tip hidden"></div>';
    var tip = el.querySelector('.col-tip');
    el.querySelectorAll('.col').forEach(function (c) {
      function on() {
        tip.textContent = c.dataset.tip; tip.classList.remove('hidden');
        tip.style.left = (c.offsetLeft + c.offsetWidth / 2) + 'px';
      }
      c.addEventListener('mouseenter', on); c.addEventListener('focus', on);
      c.addEventListener('mouseleave', function () { tip.classList.add('hidden'); });
    });
  }
  loaders.dashboard = function () {
    Auth.api('GET', '/admin/tableau-de-bord').then(function (d) {
      var c = d.contributions, total = 0;
      Object.keys(c).forEach(function (k) { total += c[k]; });
      var tiles = [
        [c['À valider'] || 0, 'Saisies à valider', 'moderation'],
        [(c['Validé'] || 0) + (c['Traité'] || 0), 'Saisies publiées'],
        [total, 'Saisies au total'],
        [d.comptes.actif || 0, 'Agents actifs']
      ];
      if (Auth.isAdmin()) tiles.splice(1, 0, [d.comptes.en_attente || 0, 'Comptes à activer', 'users']);
      document.getElementById('tiles').innerHTML = tiles.map(function (t) {
        return '<div class="tile' + (t[2] && t[0] ? ' tile-action' : '') + '"' + (t[2] ? ' data-go="' + t[2] + '"' : '') +
          '><b>' + t[0] + '</b><span>' + t[1] + '</span></div>';
      }).join('');
      document.querySelectorAll('[data-go]').forEach(function (el) {
        el.addEventListener('click', function () { show(el.dataset.go); });
      });
      dayChart(document.getElementById('chart-days'), d.par_jour);
      barList(document.getElementById('chart-services'), d.par_service.map(function (r) { return { label: r.service, n: r.n }; }), total);
      barList(document.getElementById('chart-categories'), d.par_categorie.map(function (r) { return { label: r.categorie, n: r.n }; }), total);
      setBadge('badge-moderation', c['À valider']);
      if (Auth.isAdmin()) setBadge('badge-users', d.comptes.en_attente);
    }).catch(fail);
  };
  function setBadge(id, n) {
    var b = document.getElementById(id);
    b.textContent = n || ''; b.classList.toggle('hidden', !n);
  }

  // ---------- Validation des saisies ----------
  var contribs = [];
  var modStatut = document.getElementById('mod-statut'), modSearch = document.getElementById('mod-search');
  function renderModeration() {
    var q = norm(modSearch.value);
    var rows = contribs.filter(function (f) {
      var p = f.properties;
      return (!modStatut.value || p.statut === modStatut.value) &&
        (!q || norm([p.nom, p.type, p.categorie, p.quartier, p.auteur, p.service, p.id].join(' ')).indexOf(q) >= 0);
    });
    document.getElementById('mod-count').textContent = rows.length + ' saisie(s)';
    document.getElementById('mod-body').innerHTML = rows.length ? rows.map(function (f) {
      var p = f.properties;
      return '<tr><td>' + p.id + '</td><td>' + fmtDate(p.cree_le) + '</td>' +
        '<td>' + esc(p.categorie) + '<br><small>' + esc(p.type || '') + '</small></td>' +
        '<td>' + esc(p.nom || '—') + (p.description ? '<br><small>' + esc(p.description.slice(0, 80)) + '</small>' : '') + '</td>' +
        '<td>' + esc(p.quartier || '—') + '</td>' +
        '<td>' + esc(p.auteur || '—') + '<br><small>' + esc(p.service || '') + '</small></td>' +
        '<td><span class="badge ' + cls(p.statut) + '">' + esc(p.statut) + '</span>' +
        (p.motif_rejet ? '<br><small>' + esc(p.motif_rejet) + '</small>' : '') + '</td>' +
        '<td class="actions"><a class="btn" href="espace.html?c=' + p.id + '">Voir</a>' +
        (p.statut !== 'Validé' ? '<button class="primary" data-act="Validé" data-id="' + p.id + '">Valider</button>' : '') +
        (p.statut !== 'Rejeté' ? '<button data-act="Rejeté" data-id="' + p.id + '">Rejeter</button>' : '') + '</td></tr>';
    }).join('') : '<tr><td colspan="8" class="empty">Aucune saisie.</td></tr>';
  }
  document.getElementById('mod-body').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]');
    if (!b) return;
    var statut = b.dataset.act, motif = null;
    if (statut === 'Rejeté') {
      motif = prompt('Motif du rejet (visible par l\'agent) :');
      if (motif === null) return;
    }
    b.disabled = true;
    Auth.api('PUT', '/contributions/' + b.dataset.id, { properties: { statut: statut, motif_rejet: motif } })
      .then(loaders.moderation).catch(fail);
  });
  modStatut.addEventListener('change', renderModeration);
  modSearch.addEventListener('input', renderModeration);
  loaders.moderation = function () {
    Auth.api('GET', '/contributions').then(function (fc) {
      contribs = fc.features;
      setBadge('badge-moderation', contribs.filter(function (f) { return f.properties.statut === 'À valider'; }).length);
      renderModeration();
    }).catch(fail);
  };

  // ---------- Comptes ----------
  var users = [];
  var userStatut = document.getElementById('user-statut'), userSearch = document.getElementById('user-search');
  function renderUsers() {
    var me = Auth.user().id, q = norm(userSearch.value);
    var rows = users.filter(function (u) {
      return (!userStatut.value || u.statut === userStatut.value) &&
        (!q || norm([u.nom, u.email, u.service, u.fonction, u.telephone].join(' ')).indexOf(q) >= 0);
    });
    document.getElementById('users-body').innerHTML = rows.map(function (u) {
      var self = u.id === me;
      var roleSel = self ? ROLE[u.role] + ' <small>(vous)</small>'
        : '<select data-role="' + u.id + '">' + ['agent', 'superviseur', 'admin'].map(function (r) {
          return '<option value="' + r + '"' + (r === u.role ? ' selected' : '') + '>' + ROLE[r] + '</option>';
        }).join('') + '</select>';
      var actions = '';
      if (!self) {
        if (u.statut !== 'actif') actions += '<button class="primary" data-statut="actif" data-id="' + u.id + '">Activer</button>';
        if (u.statut === 'actif') actions += '<button data-statut="desactive" data-id="' + u.id + '">Désactiver</button>';
        if (u.statut === 'en_attente') actions += '<button class="danger" data-statut="desactive" data-id="' + u.id + '">Refuser</button>';
      }
      actions += '<button data-reset="' + u.id + '" title="Générer un mot de passe temporaire">Mot de passe</button>';
      return '<tr class="' + (u.statut === 'en_attente' ? 'row-pending' : u.statut === 'desactive' ? 'row-off' : '') + '">' +
        '<td><b>' + esc(u.nom) + '</b><br><small>inscrit le ' + fmtDate(u.cree_le) + '</small></td>' +
        '<td>' + esc(u.service) + '<br><small>' + esc(u.fonction || '') + '</small></td>' +
        '<td>' + esc(u.email) + '<br><small>' + esc(u.telephone || '') + '</small></td>' +
        '<td>' + roleSel + '</td>' +
        '<td><span class="badge u-' + u.statut + '">' + STATUT_COMPTE[u.statut] + '</span></td>' +
        '<td>' + u.nb_contributions + '</td>' +
        '<td>' + fmtDate(u.derniere_connexion, true) + '</td>' +
        '<td class="actions">' + actions + '</td></tr>';
    }).join('') || '<tr><td colspan="8" class="empty">Aucun compte.</td></tr>';
  }
  var usersBody = document.getElementById('users-body');
  usersBody.addEventListener('change', function (e) {
    var sel = e.target.closest('select[data-role]');
    if (!sel) return;
    Auth.api('PUT', '/admin/utilisateurs/' + sel.dataset.role, { role: sel.value }).then(loaders.users).catch(function (err) {
      fail(err); loaders.users();
    });
  });
  usersBody.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.statut) {
      if (b.dataset.statut === 'desactive' && !confirm('Désactiver ce compte ? L\'agent ne pourra plus se connecter.')) return;
      Auth.api('PUT', '/admin/utilisateurs/' + b.dataset.id, { statut: b.dataset.statut }).then(loaders.users).catch(fail);
    }
    if (b.dataset.reset) {
      if (!confirm('Générer un nouveau mot de passe temporaire pour ce compte ?')) return;
      Auth.api('POST', '/admin/utilisateurs/' + b.dataset.reset + '/reinitialiser').then(function (r) {
        prompt('Mot de passe temporaire à transmettre à l\'agent (il pourra le changer dans « Mon compte ») :', r.mot_de_passe_temporaire);
      }).catch(fail);
    }
  });
  userStatut.addEventListener('change', renderUsers);
  userSearch.addEventListener('input', renderUsers);
  loaders.users = function () {
    Auth.api('GET', '/admin/utilisateurs').then(function (list) {
      users = list;
      setBadge('badge-users', users.filter(function (u) { return u.statut === 'en_attente'; }).length);
      renderUsers();
    }).catch(fail);
  };

  // ---------- Adressage ----------
  loaders.adressage = function () {
    Auth.api('GET', '/adressage/stats').then(function (st) {
      if (!st.initialise) {
        document.getElementById('adr-tiles').innerHTML = '';
        document.getElementById('adr-body').innerHTML = '<tr><td colspan="9" class="empty">Adressage non initialisé : un administrateur peut le lancer depuis l’espace agents, onglet « Adressage ».</td></tr>';
        return;
      }
      var t = { b: 0, p: 0, v: 0, pp: 0, voies: 0, off: 0 };
      st.quartiers.forEach(function (q) { t.b += q.batiments; t.p += q.proposees; t.v += q.validees; t.pp += q.posees; t.voies += q.voies; t.off += q.voies_officielles; });
      function pct(n, d) { return d ? Math.round(100 * n / d) : 0; }
      document.getElementById('adr-tiles').innerHTML = [
        [t.voies.toLocaleString('fr-FR'), 'Voies'], [t.off, 'Voies nommées officiellement'],
        [(t.p + t.v + t.pp).toLocaleString('fr-FR'), 'Adresses (' + pct(t.p + t.v + t.pp, t.b) + ' % du bâti)'],
        [(t.v + t.pp).toLocaleString('fr-FR'), 'Adresses validées'], [t.pp.toLocaleString('fr-FR'), 'Plaques posées']
      ].map(function (x) { return '<div class="tile"><b>' + x[0] + '</b><span>' + x[1] + '</span></div>'; }).join('');
      // Une seule mesure par barre (part du bâti ayant une adresse validée) : une seule couleur
      document.getElementById('adr-body').innerHTML = st.quartiers.map(function (q) {
        var ok = q.validees + q.posees, p = pct(ok, q.batiments);
        return '<tr><td><b>' + esc(q.quartier) + '</b></td><td>' + esc(q.code || '') + '</td><td>' + q.voies + '</td><td>' + q.voies_officielles +
          '</td><td>' + q.batiments.toLocaleString('fr-FR') + '</td><td>' + q.proposees + '</td><td>' + q.validees + '</td><td>' + q.posees +
          '</td><td title="' + ok + ' / ' + q.batiments + ' bâtiments"><div class="bar inline"><div style="width:' + Math.min(p, 100) + '%"></div></div> ' + p + ' %</td></tr>';
      }).join('');
    }).catch(fail);
  };

  // ---------- Journal ----------
  loaders.journal = function () {
    Auth.api('GET', '/admin/journal?limite=300').then(function (rows) {
      document.getElementById('journal-body').innerHTML = rows.map(function (r) {
        return '<tr><td>' + fmtDate(r.date, true) + '</td><td>' + esc(r.utilisateur || '—') + '</td><td>' + esc(r.action) +
          '</td><td>' + esc(r.objet || '') + '</td><td>' + esc(r.detail || '') + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="empty">Journal vide.</td></tr>';
    }).catch(fail);
  };

  // ---------- Démarrage ----------
  Auth.refresh().then(function (u) {
    if (!u || !Auth.isValidator()) {
      document.getElementById('denied').classList.remove('hidden');
      document.querySelectorAll('.view, .admin-nav').forEach(function (v) { v.classList.add('hidden'); });
      return;
    }
    document.getElementById('user-name').innerHTML = esc(u.nom) + ' <span class="role-badge role-' + u.role + '">' + ROLE[u.role] + '</span>';
    if (!Auth.isAdmin()) document.querySelectorAll('.admin-only').forEach(function (el) { el.classList.add('hidden'); });
    var start = location.hash.slice(1);
    var allowed = ['dashboard', 'moderation', 'adressage'].concat(Auth.isAdmin() ? ['users', 'journal', 'publication'] : []);
    show(allowed.indexOf(start) >= 0 ? start : 'dashboard');
    if (Auth.isAdmin()) Auth.api('GET', '/admin/utilisateurs').then(function (l) {
      setBadge('badge-users', l.filter(function (x) { return x.statut === 'en_attente'; }).length);
    });
  });
})();
