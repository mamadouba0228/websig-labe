/* Fiche parcellaire imprimable (A4, « Enregistrer en PDF » depuis le navigateur).
 * fiche-parcelle.html?parcelle=12 : aperçu pour les agents connectés ; « Délivrer et imprimer » (service Urbanisme et domaines,
 *   superviseurs) enregistre la délivrance (numéro FP-AAAA-NNNNN et code de vérification) puis imprime.
 * fiche-parcelle.html?verif=FP-2026-00001&c=CODE : vérification publique (QR code), sans aucune donnée personnelle. */
(function () {
  'use strict';

  var q = new URLSearchParams(location.search), pid = +q.get('parcelle'), verif = q.get('verif'), code = q.get('c');
  var page = document.getElementById('page');
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(n, d) { return Number(n).toLocaleString('fr-FR', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function dateFr(d) { return new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); }
  function erreur(msg, lien) { page.innerHTML = '<p class="erreur">' + esc(msg) + '</p>' + (lien || ''); }
  var ENTETE = '<header class="entete"><div class="etat"><b>RÉPUBLIQUE DE GUINÉE</b><span>Travail — Justice — Solidarité</span></div>' +
    '<div class="commune"><span>Région administrative de Labé</span><b>COMMUNE URBAINE DE LABÉ</b><span>Service de l\'urbanisme et des domaines</span></div></header>';

  // ---------- Vérification publique ----------
  function verifier() {
    $('barre').querySelectorAll('.delivrance').forEach(function (e) { e.classList.add('hidden'); });
    $('barre').querySelector('a').href = 'index.html';
    $('barre').querySelector('a').textContent = '← Carte de la commune';
    fetch('/api/foncier/fiches/verifier?numero=' + encodeURIComponent(verif) + '&code=' + encodeURIComponent(code || '')).then(function (r) {
      return r.json().then(function (d) { if (!r.ok) throw new Error(d.detail || 'Vérification impossible.'); return d; });
    }).then(function (v) {
      var ok = v.limites_inchangees && v.etat === 'Enregistrée';
      page.innerHTML = ENTETE + '<div class="verification"><h1>Vérification d\'une fiche parcellaire</h1>' +
        '<p class="resultat ' + (ok ? 'ok' : 'attention') + '">' + (ok ? '✓ Fiche authentique, toujours conforme au registre'
          : '⚠ Fiche authentique, mais la parcelle a changé depuis sa délivrance') + '</p>' +
        '<table class="details">' + [['Fiche', v.numero], ['Délivrée le', dateFr(v.delivre_le)], ['Parcelle', v.resume.parcelle],
          ['Quartier', v.resume.quartier], ['Superficie à la délivrance', fmt(v.resume.superficie_m2) + ' m²'],
          ['Statut juridique à la délivrance', v.resume.statut_juridique],
          ['Situation actuelle', v.etat + ' · ' + v.statut_juridique + ' · ' + fmt(v.superficie_m2) + ' m²'],
          ['Limites', v.limites_inchangees ? 'inchangées depuis la délivrance' : 'modifiées depuis la délivrance (bornage, morcellement…)']]
          .map(function (r) { return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>' +
        '<p class="note">Pour toute information sur les droits, adressez-vous au service de l\'urbanisme et des domaines de la mairie.</p></div>';
    }).catch(function (e) { erreur(e.message); });
  }

  // ---------- Fiche ----------
  var donnees = null;
  function rendre(d, fiche) {
    var p = d.parcelle;
    var lignes = [['Quartier', p.quartier], ['Adresse(s)', d.adresses.join(' ; ')],
      ['Lotissement', p.lotissement ? p.lotissement + (p.lot ? ', lot n° ' + p.lot : '') : null], ['Usage', p.usage],
      ['Statut juridique', p.statut_juridique + (p.reference_acte ? ' — ' + p.reference_acte : '') + (p.date_acte ? ' du ' + dateFr(p.date_acte) : '')],
      ['Superficie', fmt(p.superficie_m2) + ' m² (' + fmt(p.superficie_m2 / 10000, 4) + ' ha)'], ['Périmètre', fmt(p.perimetre_m, 1) + ' m'],
      ['Origine des limites', p.source_geom + (p.precision_m != null ? ', précision ± ' + fmt(p.precision_m, 1) + ' m' : '')],
      ['Enregistrée au registre', p.valide_le ? dateFr(p.valide_le) : 'non (parcelle provisoire)'],
      ['Parcelles voisines', d.voisins.map(function (v) { return v.numero; }).join(', ')]].filter(function (r) { return r[1]; });
    var contraintes = d.litiges.map(function (l) { return '<li class="grave">Litige en cours : ' + esc(l.numero) + ' (' + esc(l.type.toLowerCase()) + ', ' + esc(l.statut.toLowerCase()) + ')</li>'; })
      .concat(d.alertes.map(function (a) { return '<li' + (a.niveau === 'bloquant' ? ' class="grave"' : '') + '>' + esc(a.message) + '</li>'; }));
    var verifUrl = fiche ? location.origin + location.pathname + '?verif=' + encodeURIComponent(fiche.numero) + '&c=' + fiche.code : null;
    page.className = 'page fiche';
    page.innerHTML = (fiche ? '' : '<div class="filigrane">APERÇU</div>') + ENTETE +
      '<p class="ref">' + (fiche ? 'Fiche n° <b>' + esc(fiche.numero) + '</b> · code de vérification <b>' + esc(fiche.code) + '</b>' : 'Aperçu — fiche non délivrée') + '</p>' +
      '<h1>Fiche parcellaire</h1>' +
      '<p class="adresse">Parcelle ' + esc(p.numero) + '<small>' + esc(p.quartier || '') + ' — Labé, République de Guinée</small></p>' +
      '<div class="corps"><table class="details">' + lignes.map(function (r) { return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>' +
      '<div class="carte"><div id="carte"></div><small>Plan de la parcelle et des parcelles voisines</small></div></div>' +
      (d.titulaires.length ? '<h2>Titulaires inscrits au registre</h2><table class="bornes"><tr><th>Nom</th><th>Qualité</th><th>Part</th></tr>' +
        d.titulaires.map(function (t) { return '<tr><td>' + esc(t.nom) + ' <small>(' + esc(t.type_personne.toLowerCase()) + ')</small></td><td>' + esc(t.qualite) + '</td><td>' + esc(t.part || '—') + '</td></tr>'; }).join('') +
        '</table>' : '') +
      '<h2>Bornes et côtés</h2><table class="bornes"><tr><th>Borne</th><th>X (m)</th><th>Y (m)</th><th>Latitude</th><th>Longitude</th><th>Côté</th><th>Longueur (m)</th></tr>' +
      d.bornes.map(function (b) {
        return '<tr><td>' + b.nom + '</td><td>' + fmt(b.x, 2) + '</td><td>' + fmt(b.y, 2) + '</td><td>' + b.lat.toFixed(6) + '</td><td>' + b.lon.toFixed(6) +
          '</td><td>' + b.nom + '–' + b.cote_vers + '</td><td>' + fmt(b.longueur, 2) + '</td></tr>';
      }).join('') + '</table><p class="note">X, Y : UTM zone 28 Nord, WGS 84 (EPSG:32628). Latitude et longitude : WGS 84. Bornes numérotées dans le sens des aiguilles d\'une montre depuis le nord-ouest.</p>' +
      '<h2>Contraintes et servitudes relevées</h2>' + (contraintes.length ? '<ul class="contraintes">' + contraintes.join('') + '</ul>'
        : '<p class="note">Aucune contrainte relevée par les contrôles du registre (chevauchement, emprise des voies, domaine public, zone inondable).</p>') +
      '<p class="mention">Document d\'information extrait du registre foncier communal de Labé' +
      (fiche ? ', délivré le ' + dateFr(fiche.delivre_le) + (fiche.demandeur ? ' à ' + esc(fiche.demandeur) : '') + (fiche.motif ? ' (motif : ' + esc(fiche.motif) + ')' : '') : '') +
      '. Il ne constitue ni un titre de propriété ni une autorisation de construire : seul le titre foncier délivré par la Conservation foncière fait foi. ' +
      'Les limites sont celles connues du registre à la date de délivrance.</p>' +
      '<div class="pied"><div class="qr">' + (fiche ? '<div id="qr"></div><small>Vérification en ligne :<br>' + esc(verifUrl) + '</small>' : '') + '</div>' +
      '<div class="signature"><p>Fait à Labé, le ' + dateFr(fiche ? fiche.delivre_le : new Date()) + '</p><p><b>Le Chef du service de l\'urbanisme et des domaines</b></p>' +
      '<div class="cachet">Cachet et signature</div></div></div>';

    // plan : parcelle, voisines, bornes
    var m = L.map('carte', { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
    var poly = L.geoJSON(p.geometry, { style: { color: '#c92a2a', weight: 2.5, fillColor: '#c92a2a', fillOpacity: 0.12 } });
    m.fitBounds(poly.getBounds(), { padding: [24, 24], maxZoom: 19 });   // cadrage avant les étiquettes permanentes
    d.voisins.forEach(function (v) {
      L.geoJSON(v.geometry, { style: { color: '#495057', weight: 1, dashArray: '3 3', fillOpacity: 0 } })
        .bindTooltip(esc(v.numero.replace(/^LAB-/, '')), { permanent: true, direction: 'center', className: 'etiquette-voisin' }).addTo(m);
    });
    poly.addTo(m);
    d.bornes.forEach(function (b) {
      L.circleMarker([b.lat, b.lon], { radius: 3, color: '#c92a2a', fillColor: '#fff', fillOpacity: 1, weight: 2 })
        .bindTooltip(b.nom, { permanent: true, direction: 'top', offset: [0, -4], className: 'etiquette-borne' }).addTo(m);
    });
    if (fiche && window.qrcode) {
      var qr = qrcode(0, 'M'); qr.addData(verifUrl); qr.make();
      $('qr').innerHTML = qr.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
    }
    document.title = 'Fiche parcellaire — ' + p.numero + (fiche ? ' — ' + fiche.numero : ' (aperçu)');
  }

  function charger() {
    if (!pid) return erreur('Parcelle non précisée : ouvrez la fiche depuis l\'onglet Foncier de l\'espace agents.');
    if (!Auth.user()) return erreur('Connectez-vous à l\'espace agents pour consulter cette fiche.', '<p style="text-align:center"><a href="espace.html">Espace agents</a></p>');
    Auth.api('GET', '/foncier/parcelles/' + pid + '/fiche').then(function (d) {
      donnees = d;
      if (!d.acces) {
        $('barre').querySelectorAll('.delivrance').forEach(function (e) { e.classList.add('hidden'); });
        $('imprimer').classList.remove('hidden');
      } else if (d.parcelle.etat !== 'Enregistrée') {
        $('delivrer').disabled = true;
        $('delivrer').title = 'Seule une parcelle enregistrée (validée) donne lieu à une fiche';
      }
      rendre(d, null);
    }).catch(function (e) { erreur(e.message); });
  }

  $('delivrer').addEventListener('click', function () {
    var b = this, dem = $('demandeur').value.trim(), motif = $('motif').value.trim();
    if (!dem && !confirm('Le demandeur n\'est pas renseigné. Délivrer quand même ?')) return;
    b.disabled = true;
    Auth.api('POST', '/foncier/parcelles/' + pid + '/fiche', { demandeur: dem || null, motif: motif || null }).then(function (d) {
      rendre(d, d.fiche);
      $('barre').querySelectorAll('.delivrance').forEach(function (e) { e.classList.add('hidden'); });
      $('imprimer').classList.remove('hidden');
      setTimeout(function () { window.print(); }, 1500);   // le temps de charger le fond de plan
    }).catch(function (e) { alert(e.message); b.disabled = false; });
  });
  $('imprimer').addEventListener('click', function () { window.print(); });

  if (verif) verifier(); else charger();
})();
