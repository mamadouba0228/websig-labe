/* Foncier (suite, espace agents) : titulaires des droits, pièces jointes, litiges fonciers, fiche parcellaire,
 * tableau de bord (bilan) et fiscalité locale. S'appuie sur les outils de foncier.js (LabeFoncier.outils). */
(function () {
  'use strict';

  var A = window.LabeApp, map = A.map, esc = A.esc;
  var OUVERTS = ['Signalé', 'En médiation', 'Transmis au tribunal'];
  var MAX_PIECE = 5000000;
  var LG = null, litiges = [];
  var litLayer = A.markClicks(L.featureGroup());

  function $(id) { return document.getElementById(id); }
  function O() { return LabeFoncier.outils; }
  function api(m, p, b) { return O().api(m, p, b); }
  function moi() { return Auth.user(); }
  function gnf(v) { return A.fmt(Math.round(v || 0)) + ' GNF'; }
  function aujourdhui() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function enRetard(date) { return date && new Date(date) < aujourdhui(); }
  function opts(list, val) { return list.map(function (v) { return '<option' + (v === val ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join(''); }
  function bloc(titre, cls) {
    var d = document.createElement('div'); d.className = 'fon-bloc ' + (cls || '');
    d.innerHTML = '<h4>' + titre + '</h4><div class="fon-bloc-corps"><p class="hint">Chargement…</p></div><div class="fon-sous"></div>';
    return d;
  }
  function inserer(fiche, el) {
    var h = fiche.querySelector('.fon-bloc-histo');
    if (h) fiche.insertBefore(el, h); else fiche.appendChild(el);
  }

  // Sous-formulaire générique : champs HTML (attribut name), bouton de validation, envoi
  function formulaire(conteneur, titre, champs, texteOk, envoyer) {
    conteneur.innerHTML = '<h4>' + titre + '</h4>' + champs + '<p class="form-msg"></p>';
    var row = document.createElement('div'); row.className = 'row';
    O().btn(row, 'Annuler', '', function () { conteneur.innerHTML = ''; });
    var ok = O().btn(row, texteOk, 'primary', function () {
      var v = {};
      conteneur.querySelectorAll('[name]').forEach(function (i) {
        v[i.name] = i.type === 'checkbox' ? i.checked : i.type === 'file' ? i.files[0] || null : (i.value.trim() || null);
      });
      ok.disabled = true;
      Promise.resolve().then(function () { return envoyer(v); }).then(function () { conteneur.innerHTML = ''; })
        .catch(function (e) { conteneur.querySelector('.form-msg').textContent = e.message; }).then(function () { ok.disabled = false; });
    });
    conteneur.appendChild(row);
    conteneur.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Fichier → data URL ; photos lourdes réduites (2400 px, JPEG) pour rester sous 5 Mo
  function lireFichier(file) {
    if (!file) return Promise.reject(new Error('Choisissez un fichier.'));
    if (['application/pdf', 'image/jpeg', 'image/png'].indexOf(file.type) < 0) return Promise.reject(new Error('Format accepté : PDF, JPEG ou PNG.'));
    var lire = function (blob) {
      return new Promise(function (ok, ko) { var r = new FileReader(); r.onload = function () { ok(r.result); }; r.onerror = ko; r.readAsDataURL(blob); });
    };
    if (file.type === 'application/pdf' || file.size < 1500000) {
      if (file.size > MAX_PIECE) return Promise.reject(new Error('Fichier trop lourd (5 Mo maximum).'));
      return lire(file);
    }
    return createImageBitmap(file).then(function (img) {
      var k = Math.min(1, 2400 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.85);
    });
  }
  // ouverture d'une pièce protégée dans un nouvel onglet (fenêtre ouverte tout de suite : pas de blocage)
  function ouvrirPiece(id) {
    var w = window.open('', '_blank');
    Auth.blobUrl('/api/foncier/pieces/' + id).then(function (url) {
      if (w) w.location.href = url; else location.href = url;
    }).catch(function () { if (w) w.close(); alert('Pièce inaccessible.'); });
  }

  // ---------- Pièces (parcelle, dossier ou litige) ----------
  function sectionPieces(cle, id, fiche) {
    var b = bloc('Pièces', 'fon-pieces');
    inserer(fiche, b);
    var corps = b.querySelector('.fon-bloc-corps'), sous = b.querySelector('.fon-sous');
    function charger() {
      api('GET', '/pieces?' + cle + '=' + id).then(function (r) {
        corps.innerHTML = (r.pieces.length ? '<ul class="fon-ctl fon-pieces-liste">' + r.pieces.map(function (p) {
          return '<li data-o="' + p.id + '"><b>' + esc(p.type) + '</b> — ' + esc(p.nom_fichier) + ' <small>(' + A.fmt(p.taille / 1024) + ' Ko · ' +
            O().dateFr(p.ajoute_le) + (p.ajoute_par_nom ? ' · ' + esc(p.ajoute_par_nom) : '') + ')' + (p.description ? '<br>' + esc(p.description) : '') + '</small>' +
            (O().sup() || p.ajoute_par === moi().id ? ' <button type="button" class="petit danger" data-x="' + p.id + '">✕</button>' : '') + '</li>';
        }).join('') + '</ul>' : '<p class="hint">Aucune pièce.</p>') +
          (r.masquees ? '<p class="hint">' + r.masquees + ' pièce(s) réservée(s) au service Urbanisme et domaines et aux superviseurs.</p>' : '');
        var row = document.createElement('div'); row.className = 'row';
        if (cle !== 'parcelle' || LG.acces) O().btn(row, '📎 Joindre une pièce', 'petit', function () {
          formulaire(sous, 'Joindre une pièce', '<label>Type<select name="type">' + opts(LG.types_piece, cle === 'litige' ? 'Procès-verbal' : 'Acte de vente') + '</select></label>' +
            '<label>Fichier (PDF, JPEG ou PNG, 5 Mo au plus)<input type="file" name="fichier" accept="application/pdf,image/jpeg,image/png" capture="environment"></label>' +
            '<label>Description<input name="description" maxlength="300" placeholder="ex. acte du 12/03/2015, page 1"></label>', 'Joindre', function (v) {
            return lireFichier(v.fichier).then(function (data) {
              var body = { type: v.type, description: v.description, nom_fichier: v.fichier.name, contenu: data };
              body[cle] = id;
              return api('POST', '/pieces', body);
            }).then(function () { LabeTerrain.toast('Pièce jointe.'); charger(); });
          });
        });
        corps.appendChild(row);
        corps.querySelectorAll('[data-o]').forEach(function (li) { li.onclick = function (e) { if (!e.target.dataset.x) ouvrirPiece(+li.dataset.o); }; });
        corps.querySelectorAll('[data-x]').forEach(function (bt) {
          bt.onclick = function () { if (confirm('Supprimer cette pièce ?')) api('DELETE', '/pieces/' + bt.dataset.x).then(charger).catch(O().fail); };
        });
      }).catch(function (e) { corps.innerHTML = '<p class="form-msg">' + esc(e.message) + '</p>'; });
    }
    charger();
  }

  // ---------- Titulaires ----------
  function champsTitulaire(t) {
    t = t || {};
    return '<label>Nom et prénom, ou raison sociale *<input name="nom" maxlength="150" value="' + esc(t.nom || '') + '"></label>' +
      '<div class="grid2"><label>Personne<select name="type_personne">' + opts(LG.types_personne, t.type_personne || 'Personne physique') + '</select></label>' +
      '<label>Qualité<select name="qualite">' + opts(LG.qualites, t.qualite || 'Propriétaire') + '</select></label></div>' +
      '<div class="grid2"><label>Part<input name="part" maxlength="30" placeholder="ex. 1/2" value="' + esc(t.part || '') + '"></label>' +
      '<label>Depuis le<input type="date" name="debut" value="' + (t.debut || '') + '"></label></div>' +
      '<div class="grid2"><label>Téléphone<input name="telephone" maxlength="30" value="' + esc(t.telephone || '') + '"></label>' +
      '<label>Pièce d\'identité<input name="piece_identite" maxlength="60" value="' + esc(t.piece_identite || '') + '"></label></div>' +
      '<label>Adresse<input name="adresse" maxlength="200" value="' + esc(t.adresse || '') + '"></label>' +
      '<label>Observations<input name="observations" maxlength="1000" value="' + esc(t.observations || '') + '"></label>';
  }
  function sectionTitulaires(f, fiche) {
    var p = f.properties, b = bloc('Titulaires des droits', 'fon-titulaires');
    inserer(fiche, b);
    var corps = b.querySelector('.fon-bloc-corps'), sous = b.querySelector('.fon-sous');
    function rendre(r) {
      if (r.acces === false) {
        corps.innerHTML = '<p class="hint">' + r.nb_actifs + ' titulaire(s) actif(s). Identité réservée au service Urbanisme et domaines et aux superviseurs.</p>';
        return;
      }
      corps.innerHTML = r.titulaires.length ? '<ul class="fon-ctl fon-tit">' + r.titulaires.map(function (t) {
        return '<li class="' + (t.actif ? '' : 'inactif') + '"><b>' + esc(t.nom) + '</b> · ' + esc(t.qualite) + (t.part ? ' (' + esc(t.part) + ')' : '') +
          (t.actif ? '' : ' <span class="badge f-Archivée">droit clos</span>') + '<small><br>' + esc(t.type_personne) +
          (t.telephone ? ' · ' + esc(t.telephone) : '') + (t.piece_identite ? ' · ' + esc(t.piece_identite) : '') +
          (t.debut ? ' · depuis le ' + O().dateFr(t.debut) : '') + (t.fin ? ' · jusqu\'au ' + O().dateFr(t.fin) : '') +
          (t.dossier_numero ? ' · dossier ' + esc(t.dossier_numero) : '') + (t.observations ? '<br>' + esc(t.observations) : '') + '</small>' +
          (p.etat !== 'Archivée' ? '<br><button type="button" class="petit" data-m="' + t.id + '">Modifier</button>' +
            (t.actif ? ' <button type="button" class="petit" data-fin="' + t.id + '">Fin du droit</button>' : '') : '') + '</li>';
      }).join('') + '</ul>' : '<p class="hint">Aucun titulaire enregistré.</p>';
      if (p.etat !== 'Archivée') {
        var row = document.createElement('div'); row.className = 'row';
        O().btn(row, '+ Titulaire', 'petit', function () {
          formulaire(sous, 'Nouveau titulaire', champsTitulaire(), 'Ajouter', function (v) {
            if (!v.nom) throw new Error('Le nom est obligatoire.');
            return api('POST', '/parcelles/' + p.id + '/titulaires', v).then(rendre);
          });
        });
        corps.appendChild(row);
      }
      corps.querySelectorAll('[data-m]').forEach(function (bt) {
        var t = r.titulaires.filter(function (x) { return x.id === +bt.dataset.m; })[0];
        bt.onclick = function () {
          formulaire(sous, 'Modifier le titulaire', champsTitulaire(t), 'Enregistrer', function (v) {
            if (!v.nom) throw new Error('Le nom est obligatoire.');
            return api('PUT', '/titulaires/' + t.id, v).then(rendre);
          });
        };
      });
      corps.querySelectorAll('[data-fin]').forEach(function (bt) {
        bt.onclick = function () {
          formulaire(sous, 'Fin du droit', '<label>Date de fin<input type="date" name="fin" value="' + new Date().toISOString().slice(0, 10) + '"></label>' +
            '<label>Motif<input name="observations" maxlength="1000" placeholder="ex. décès, renonciation, fin de bail"></label>', 'Clore le droit', function (v) {
            return api('PUT', '/titulaires/' + bt.dataset.fin, { actif: false, fin: v.fin, observations: v.observations }).then(rendre);
          });
        };
      });
    }
    api('GET', '/parcelles/' + p.id + '/titulaires').then(rendre).catch(function (e) { corps.innerHTML = '<p class="form-msg">' + esc(e.message) + '</p>'; });
  }

  // ---------- Fiscalité d'une parcelle ----------
  function sectionFiscalite(f, fiche) {
    var p = f.properties, b = bloc('Fiscalité (estimation)', 'fon-fiscal');
    inserer(fiche, b);
    var corps = b.querySelector('.fon-bloc-corps'), sous = b.querySelector('.fon-sous');
    function charger() {
      api('GET', '/parcelles/' + p.id + '/fiscalite').then(function (r) {
        var a = r.assiette;
        corps.innerHTML = (r.a_valider ? '<p class="hint fon-avert">Barème d\'exemple, pas encore validé par le service des finances.</p>' : '') +
          (a ? O().table([['Montant estimé ' + r.annee, a.exonere ? 'exonérée (' + esc(a.usage.toLowerCase()) + ')' : gnf(a.montant)],
            ['Base', 'zone ' + a.zone + ' · terrain ' + A.fmt(a.superficie_m2) + ' m² · emprise bâtie ' + A.fmt(a.bati_m2) + ' m² · coefficient ' + A.fmt(a.coef, 2)],
            ['Payé ' + r.annee, gnf(a.paye)], ['Reste ' + r.annee, a.exonere ? '—' : gnf(a.reste)]]) : '<p class="hint">Parcelle archivée.</p>') +
          (r.paiements.length ? '<ul class="fon-ctl">' + r.paiements.map(function (x) {
            return '<li>' + x.annee + ' · <b>' + gnf(x.montant) + '</b> · ' + O().dateFr(x.paye_le) + ' · ' + esc(x.mode) +
              (x.quittance ? ' · quittance ' + esc(x.quittance) : '') + (x.saisi_par ? ' <small>(' + esc(x.saisi_par) + ')</small>' : '') +
              (O().sup() ? ' <button type="button" class="petit danger" data-x="' + x.id + '">✕</button>' : '') + '</li>';
          }).join('') + '</ul>' : '');
        if (r.peut_encaisser && a) {
          var row = document.createElement('div'); row.className = 'row';
          O().btn(row, '+ Paiement', 'petit', function () {
            formulaire(sous, 'Enregistrer un paiement', '<div class="grid2"><label>Année<input type="number" name="annee" min="2000" max="2100" value="' + r.annee + '"></label>' +
              '<label>Montant (GNF)<input type="number" name="montant" min="1" step="100" value="' + Math.round(a.reste || a.montant || 0) + '"></label></div>' +
              '<div class="grid2"><label>Payé le<input type="date" name="paye_le" value="' + new Date().toISOString().slice(0, 10) + '"></label>' +
              '<label>Mode<select name="mode">' + opts(r.modes, 'Espèces') + '</select></label></div>' +
              '<label>N° de quittance<input name="quittance" maxlength="60"></label><label>Observations<input name="observations" maxlength="500"></label>',
            'Enregistrer', function (v) {
              return api('POST', '/paiements', { parcelle: p.id, annee: +v.annee, montant: +v.montant, paye_le: v.paye_le, mode: v.mode,
                quittance: v.quittance, observations: v.observations }).then(function () { LabeTerrain.toast('Paiement enregistré.'); charger(); });
            });
          });
          corps.appendChild(row);
        }
        corps.querySelectorAll('[data-x]').forEach(function (bt) {
          bt.onclick = function () { if (confirm('Annuler ce paiement ?')) api('DELETE', '/paiements/' + bt.dataset.x).then(charger).catch(O().fail); };
        });
      }).catch(function (e) { corps.innerHTML = '<p class="form-msg">' + esc(e.message) + '</p>'; });
    }
    charger();
  }

  // ---------- Litiges d'une parcelle ----------
  function sectionLitigesParcelle(f, fiche) {
    var p = f.properties, b = bloc('Litiges', 'fon-litiges-parcelle');
    inserer(fiche, b);
    var corps = b.querySelector('.fon-bloc-corps');
    api('GET', '/litiges?parcelle=' + p.id).then(function (r) {
      corps.innerHTML = r.features.length ? '<ul class="fon-ctl">' + r.features.map(function (l) {
        var q = l.properties;
        return '<li data-l="' + q.id + '" class="' + (OUVERTS.indexOf(q.statut) >= 0 ? 'fon-lit-ouvert' : '') + '">⚖ <b>' + esc(q.numero) + '</b> — ' + esc(q.type) +
          ' · <span class="badge ' + O().cls(q.statut) + '">' + esc(q.statut) + '</span></li>';
      }).join('') + '</ul>' : '<p class="hint">Aucun litige signalé.</p>';
      corps.querySelectorAll('[data-l]').forEach(function (li) { li.onclick = function () { ouvrirLitige(+li.dataset.l); }; });
    }).catch(function (e) { corps.innerHTML = '<p class="form-msg">' + esc(e.message) + '</p>'; });
  }

  function completerParcelle(f, fiche) {
    if (!LG) return;
    var p = f.properties, bar = fiche.querySelector('.fon-actions');
    if (bar && p.etat !== 'Archivée') {
      O().btn(bar, '📄 Fiche parcellaire', '', function () { window.open('fiche-parcelle.html?parcelle=' + p.id, '_blank'); });
      O().btn(bar, '⚖ Signaler un litige', '', function () { formLitige({ parcelles: [p.id] }); });
    }
    sectionTitulaires(f, fiche);
    sectionLitigesParcelle(f, fiche);
    sectionPieces('parcelle', p.id, fiche);
    if (LG.acces_fiscal && p.etat !== 'Archivée') sectionFiscalite(f, fiche);
  }
  function completerDossier(f, fiche) {
    if (!LG) return;
    sectionPieces('dossier', f.id, fiche);
  }

  // ---------- Litiges : liste, carte, signalement, fiche ----------
  var FL = { statut: '', type: '' };
  function chargerLitiges() {
    return api('GET', '/litiges').then(function (fc) {
      litiges = fc.features;
      litLayer.clearLayers();
      litiges.filter(function (l) { return OUVERTS.indexOf(l.properties.statut) >= 0; }).forEach(function (l) {
        var c = l.geometry.coordinates, q = l.properties;
        var m = L.marker([c[1], c[0]], { icon: L.divIcon({ className: 'fon-lit-ico', html: '⚖', iconSize: [24, 24], iconAnchor: [12, 12] }),
          title: q.numero + ' — ' + q.type, keyboard: false });
        m.feature = { type: 'Feature', geometry: l.geometry, properties: { libelle: 'Litige ' + q.numero, Type: q.type, Statut: q.statut, Quartier: q.quartier,
          'Parcelle(s)': q.parcelles_numeros.join(', ') } };
        m.on('click', function () { ouvrirLitige(q.id); });
        litLayer.addLayer(m);
      });
      rendreLitiges();
    }).catch(O().fail);
  }
  function rendreLitiges() {
    var list = litiges.filter(function (l) {
      var q = l.properties;
      if (FL.statut === '' && OUVERTS.indexOf(q.statut) < 0) return false;
      if (FL.statut && FL.statut !== 'tous' && q.statut !== FL.statut) return false;
      return !FL.type || q.type === FL.type;
    });
    var ul = $('fon-litiges');
    ul.innerHTML = list.length ? '' : '<li class="empty"><small>Aucun litige pour ces critères.</small></li>';
    list.forEach(function (l) {
      var q = l.properties, li = document.createElement('li'), retard = OUVERTS.indexOf(q.statut) >= 0 && enRetard(q.prochaine_etape);
      li.className = 'fon-litige ' + O().cls(q.statut) + (retard ? ' retard' : '');
      li.innerHTML = '<b>⚖ ' + esc(q.numero) + ' — ' + esc(q.type) + '</b><small>' + esc(q.parcelles_numeros.join(', ') || 'hors registre') + ' · ' +
        esc(q.quartier || '—') + ' · <span class="badge ' + O().cls(q.statut) + '">' + esc(q.statut) + '</span>' +
        (q.mediateur_nom ? '<br>Médiation : ' + esc(q.mediateur_nom) : '') +
        (q.prochaine_etape && OUVERTS.indexOf(q.statut) >= 0 ? ' · prochaine étape ' + O().dateFr(q.prochaine_etape) + (retard ? ' <b class="retard-txt">dépassée</b>' : '') : '') + '</small>';
      li.onclick = function () { ouvrirLitige(q.id); };
      ul.appendChild(li);
    });
    var ouverts = litiges.filter(function (l) { return OUVERTS.indexOf(l.properties.statut) >= 0; });
    var aTraiter = LG.acces ? ouverts.filter(function (l) { return l.properties.statut === 'Signalé' || enRetard(l.properties.prochaine_etape); }).length : 0;
    $('fon-lit-badge').textContent = aTraiter; $('fon-lit-badge').classList.toggle('hidden', !aTraiter);
  }

  function formLitige(preset) {
    var nl = { parcelles: (preset && preset.parcelles) || [], point: null }, d = document.createElement('div');
    d.innerHTML = '<h3>Signaler un litige foncier</h3>' +
      '<label class="fon-lab">Type<select name="type">' + opts(LG.types_litige, 'Limites') + '</select></label>' +
      '<div class="fon-df-bloc fon-l-ou"></div>' +
      '<label class="fon-lab">Personnes en conflit<textarea name="parties" rows="2" maxlength="1000" placeholder="Noms, qualité (propriétaire, voisin, héritier…), téléphones"></textarea></label>' +
      '<p class="hint">Ces noms ne sont visibles que par le service Urbanisme et domaines, les superviseurs et vous-même.</p>' +
      '<label class="fon-lab">Description *<textarea name="description" rows="3" maxlength="3000" placeholder="Objet du conflit, depuis quand, démarches déjà faites…"></textarea></label>' +
      '<p class="form-msg"></p>';
    var ou = d.querySelector('.fon-l-ou');
    function majOu() {
      O().apercu.clearLayers();
      var noms = nl.parcelles.map(function (id) { var f = O().parcelle(id); return f ? f.properties.numero : '#' + id; });
      ou.innerHTML = '<b>Parcelle(s)</b> : ' + (noms.length ? esc(noms.join(', ')) : nl.point ? '<i>point choisi sur la carte (hors registre)</i>' : '<i>aucune</i>') + ' ';
      O().btn(ou, '⌖ Choisir les parcelles', 'petit', function () {
        O().choisirParcelles(99, nl.parcelles, function (ids) { if (ids) { nl.parcelles = ids; nl.point = null; } majOu(); });
      });
      O().btn(ou, '📍 Terrain hors registre', 'petit', function () {
        LabeTerrain.toast('Cliquez l\'emplacement du terrain sur la carte.');
        map.getContainer().classList.add('crosshair');
        function clic(e) {
          A.libererClic(clic); map.getContainer().classList.remove('crosshair');
          nl.point = [+e.latlng.lng.toFixed(7), +e.latlng.lat.toFixed(7)]; nl.parcelles = []; majOu();
        }
        A.capturerClic(clic);
      });
      nl.parcelles.forEach(function (id) {
        var f = O().parcelle(id);
        if (f) L.geoJSON(f.geometry, { style: { color: '#c92a2a', weight: 3, fillOpacity: 0.15 }, interactive: false }).addTo(O().apercu);
      });
      if (nl.point) L.circleMarker([nl.point[1], nl.point[0]], { radius: 8, color: '#c92a2a', fillOpacity: 0.6 }).addTo(O().apercu);
    }
    majOu();
    var row = document.createElement('div'); row.className = 'row';
    O().btn(row, 'Signaler', 'primary', function () {
      var body = { type: d.querySelector('[name=type]').value, parcelles: nl.parcelles, point: nl.point,
        parties: d.querySelector('[name=parties]').value.trim() || null, description: d.querySelector('[name=description]').value.trim() };
      api('POST', '/litiges', body).then(function (l) {
        LabeTerrain.toast('Litige ' + l.properties.numero + ' signalé.');
        chargerLitiges(); LabeFoncier.recharger(); ouvrirLitige(l.id);
      }).catch(function (e) { d.querySelector('.form-msg').textContent = e.message; });
    });
    d.appendChild(row);
    O().montrerFiche(d);
  }

  function ouvrirLitige(id) {
    api('GET', '/litiges/' + id).then(function (f) {
      var q = f.properties, d = document.createElement('div'), ouvert = OUVERTS.indexOf(q.statut) >= 0;
      O().apercu.clearLayers();
      var geoms = q.parcelles.map(function (pid) { return O().parcelle(pid); }).filter(Boolean);
      if (geoms.length) O().surligner({ type: 'GeometryCollection', geometries: geoms.map(function (g) { return g.geometry; }) }, '#c92a2a');
      else { O().surligner(null); map.setView([f.geometry.coordinates[1], f.geometry.coordinates[0]], 18); }
      L.circleMarker([f.geometry.coordinates[1], f.geometry.coordinates[0]], { radius: 9, color: '#c92a2a', fillOpacity: 0.5, interactive: false }).addTo(O().apercu);
      d.innerHTML = '<h3>Litige ' + esc(q.numero) + '</h3><p><b>' + esc(q.type) + '</b> · <span class="badge ' + O().cls(q.statut) + '">' + esc(q.statut) + '</span></p>' +
        O().table([['Parcelle(s)', q.parcelles.map(function (pid, i) { return '<a href="#" data-p="' + pid + '">' + esc(q.parcelles_numeros[i] || pid) + '</a>'; }).join(', ') || 'terrain hors registre', true],
          ['Quartier', q.quartier], ['Parties', q.parties_masquees ? '<i>réservé au service Urbanisme et domaines</i>' : esc(q.parties || ''), true],
          ['Description', q.description], ['Médiateur', q.mediateur_nom],
          ['Prochaine étape', q.prochaine_etape && ouvert ? O().dateFr(q.prochaine_etape) + (enRetard(q.prochaine_etape) ? ' (dépassée)' : '') : null],
          ['Issue', q.resolution], ['Signalé', O().dateFr(q.declare_le) + (q.declare_par_nom ? ' par ' + q.declare_par_nom : '')],
          ['Clos', q.clos_le ? O().dateFr(q.clos_le) : null]]);
      var bar = document.createElement('div'); bar.className = 'row fon-actions';
      var sous = document.createElement('div'); sous.className = 'fon-sous';
      function action(titre, champs, texte, nom, oblig) {
        formulaire(sous, titre, champs, texte, function (v) {
          if (oblig && !v.commentaire) throw new Error('Complétez le compte rendu.');
          v.action = nom;
          if (v.mediateur) v.mediateur = +v.mediateur;
          return api('POST', '/litiges/' + q.id + '/action', v).then(function () { chargerLitiges(); LabeFoncier.recharger(); ouvrirLitige(q.id); });
        });
      }
      var date = function (lib) { return '<label>' + lib + '<input type="date" name="prochaine_etape"></label>'; };
      if (f.peut_gerer && ouvert) {
        O().btn(bar, q.statut === 'Signalé' ? 'Engager la médiation' : 'Changer de médiateur', q.statut === 'Signalé' ? 'primary' : '', function () {
          action('Médiation', '<label>Médiateur<select name="mediateur">' + (f.mediateurs || []).map(function (u) {
            return '<option value="' + u.id + '"' + (u.id === (q.mediateur || moi().id) ? ' selected' : '') + '>' + esc(u.nom) + '</option>';
          }).join('') + '</select></label>' + date('Première réunion le') + '<label>Observations<input name="commentaire" maxlength="1000"></label>', 'Enregistrer', 'mediation');
        });
        O().btn(bar, 'Réunion / audience', '', function () {
          action('Compte rendu de réunion ou d\'audience', '<label>Compte rendu *<textarea name="commentaire" rows="3" maxlength="3000"></textarea></label>' + date('Prochaine étape le'),
            'Enregistrer', 'etape', true);
        });
        O().btn(bar, '✓ Résolu à l\'amiable', '', function () {
          action('Résolution à l\'amiable', '<label>Accord trouvé *<textarea name="commentaire" rows="3" maxlength="3000"></textarea></label>', 'Enregistrer', 'resoudre', true);
        });
        if (q.statut !== 'Transmis au tribunal') O().btn(bar, 'Transmettre au tribunal', '', function () {
          action('Transmission au tribunal', '<label>Juridiction, références<input name="commentaire" maxlength="1000"></label>' + date('Audience le'), 'Transmettre', 'tribunal');
        });
      }
      if (f.peut_gerer && q.statut !== 'Clos') O().btn(bar, 'Clore', '', function () {
        action('Clôture', '<label>Issue *<textarea name="commentaire" rows="2" maxlength="3000" placeholder="Décision de justice, retrait de la plainte, sans suite…"></textarea></label>', 'Clore', 'clore', true);
      });
      if (O().sup() && !ouvert) O().btn(bar, 'Rouvrir', '', function () {
        action('Réouverture', '<label>Motif<input name="commentaire" maxlength="1000"></label>', 'Rouvrir', 'rouvrir');
      });
      O().btn(bar, 'Commenter', '', function () {
        action('Commentaire', '<label>Commentaire<textarea name="commentaire" rows="2" maxlength="3000"></textarea></label>', 'Ajouter', 'commenter', true);
      });
      d.appendChild(bar); d.appendChild(sous);
      var hist = document.createElement('div');
      hist.className = 'fon-bloc-histo';
      hist.innerHTML = '<h4>Historique</h4><ul class="histo fon-histo">' + f.historique.map(function (x) {
        return '<li><b>' + esc(x.action) + '</b> <small>' + new Date(x.date).toLocaleString('fr-FR') + (x.utilisateur ? ' · ' + esc(x.utilisateur) : '') +
          (x.statut_apres && x.statut_apres !== x.statut_avant ? ' · → ' + esc(x.statut_apres) : '') + '</small>' + (x.commentaire ? '<br>' + esc(x.commentaire) : '') + '</li>';
      }).join('') + '</ul>';
      d.appendChild(hist);
      O().montrerFiche(d);
      sectionPieces('litige', q.id, d);
      d.querySelectorAll('[data-p]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); LabeFoncier.ouvrirParcelle(+a.dataset.p); }; });
    }).catch(O().fail);
  }

  // ---------- Recherche d'une personne ----------
  var tRecherche = 0;
  $('fon-t-q').addEventListener('input', function () {
    var q = this.value.trim(), n = ++tRecherche;
    if (q.length < 2) { $('fon-t-res').innerHTML = ''; return; }
    setTimeout(function () {
      if (n !== tRecherche) return;
      api('GET', '/titulaires?q=' + encodeURIComponent(q)).then(function (rows) {
        $('fon-t-res').innerHTML = rows.length ? rows.map(function (r) {
          return '<li data-p="' + r.parcelle + '"><b>' + esc(r.nom) + '</b> · ' + esc(r.qualite) + (r.part ? ' (' + esc(r.part) + ')' : '') + ' — ' + esc(r.numero) +
            ' · ' + esc(r.quartier || '') + (r.actif ? '' : ' <small>(droit clos)</small>') + (r.etat === 'Archivée' ? ' <small>(parcelle archivée)</small>' : '') + '</li>';
        }).join('') : '<li><small>Aucun titulaire trouvé.</small></li>';
        $('fon-t-res').querySelectorAll('[data-p]').forEach(function (li) { li.onclick = function () { LabeFoncier.ouvrirParcelle(+li.dataset.p); }; });
      }).catch(function (e) { $('fon-t-res').innerHTML = '<li class="form-msg">' + esc(e.message) + '</li>'; });
    }, 300);
  });

  // ---------- Bilan (tableau de bord) ----------
  // barres horizontales : une seule teinte, valeur écrite au bout de chaque barre
  function barres(items, val, lib, fmt) {
    var max = Math.max.apply(null, items.map(val).concat([1]));
    return '<div class="fon-barres">' + items.map(function (it) {
      var v = val(it);
      return '<div class="fon-barre" title="' + esc(lib(it)) + ' : ' + esc(fmt ? fmt(it) : A.fmt(v)) + '"><span>' + esc(lib(it)) + '</span>' +
        '<i><b style="width:' + (100 * v / max).toFixed(1) + '%"></b></i><em>' + esc(fmt ? fmt(it) : A.fmt(v)) + '</em></div>';
    }).join('') + '</div>';
  }
  // histogramme des 12 derniers mois (une série), info-bulle au survol
  function colonnes(mois, cle, titre) {
    var W = 300, H = 110, pad = 18, n = mois.length, max = Math.max.apply(null, mois.map(function (m) { return m[cle]; }).concat([1]));
    var bw = (W - 2) / n;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + (H + pad) + '" class="fon-col" role="img" aria-label="' + esc(titre) + '">' +
      '<line x1="0" y1="' + H + '" x2="' + W + '" y2="' + H + '" class="axe"/>';
    mois.forEach(function (m, i) {
      var h = (H - 14) * m[cle] / max, x = 1 + i * bw;
      var lib = new Date(m.mois + '-01').toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
      svg += '<g><title>' + esc(lib + ' : ' + m[cle]) + '</title><rect x="' + (x + 3) + '" y="' + (H - Math.max(h, m[cle] ? 2 : 0)) + '" width="' + (bw - 6) +
        '" height="' + Math.max(h, m[cle] ? 2 : 0) + '" rx="2"/><rect x="' + x + '" y="0" width="' + bw + '" height="' + H + '" class="cible"/>' +
        (m[cle] ? '<text x="' + (x + bw / 2) + '" y="' + (H - h - 3) + '" class="v">' + m[cle] + '</text>' : '') +
        (i % 2 === 0 || n <= 6 ? '<text x="' + (x + bw / 2) + '" y="' + (H + 12) + '" class="m">' + esc(lib) + '</text>' : '') + '</g>';
    });
    return svg + '</svg>';
  }
  function carte(v, lib, cls) { return '<div class="stat-card' + (cls ? ' ' + cls : '') + '"><b>' + v + '</b><span>' + lib + '</span></div>'; }
  function chargerBilan() {
    var div = $('fon-bilan');
    api('GET', '/bilan').then(function (b) {
      var nb = b.par_statut.reduce(function (s, x) { return s + x.n; }, 0), ha = b.par_statut.reduce(function (s, x) { return s + x.ha; }, 0);
      var ouvertsD = b.dossiers_type.reduce(function (s, x) { return s + x.ouverts; }, 0);
      var decides = b.dossiers_type.filter(function (x) { return x.delai_j != null; });
      var delai = decides.length ? decides.reduce(function (s, x) { return s + x.delai_j * (x.approuves + x.rejetes); }, 0) /
        Math.max(1, decides.reduce(function (s, x) { return s + x.approuves + x.rejetes; }, 0)) : null;
      var litOuv = b.litiges_statut.filter(function (x) { return OUVERTS.indexOf(x.k) >= 0; }).reduce(function (s, x) { return s + x.n; }, 0);
      var couv = b.couverture.batiments ? 100 * b.couverture.couverts / b.couverture.batiments : 0;
      var titrees = (b.par_statut.filter(function (x) { return x.k === 'Titre foncier'; })[0] || { n: 0 }).n;
      var html = '<div class="stat-cards suivi-cartes">' +
        carte(A.fmt(nb), 'parcelles (' + A.fmt(ha, 1) + ' ha)') +
        carte(nb ? A.fmt(100 * titrees / nb, 0) + ' %' : '—', 'titrées') +
        carte(A.fmt(couv, 1) + ' %', 'du bâti de la commune sur une parcelle recensée') +
        carte(ouvertsD, 'dossiers en cours') +
        carte(delai != null ? A.fmt(delai, 1) + ' j' : '—', 'délai moyen de décision') +
        carte(litOuv, 'litiges en cours', litOuv ? 'alerte' : '') +
        carte(b.fiches.n30, 'fiches parcellaires (30 j)') +
        (b.fiscal ? carte(b.fiscal.emis ? A.fmt(100 * b.fiscal.paye / b.fiscal.emis, 1) + ' %' : '—', 'recouvrement ' + b.fiscal.annee) : '') + '</div>';
      html += '<h3>Parcelles par statut juridique</h3>' + (b.par_statut.length ? barres(b.par_statut, function (x) { return x.n; }, function (x) { return x.k; },
        function (x) { return A.fmt(x.n) + ' · ' + A.fmt(x.ha, 2) + ' ha'; }) : '<p class="hint">Aucune parcelle.</p>');
      html += '<h3>Parcelles par usage</h3>' + (b.par_usage.length ? barres(b.par_usage, function (x) { return x.n; }, function (x) { return x.k; }) : '');
      html += '<h3>Dossiers déposés par mois</h3>' + colonnes(b.mois, 'deposes', 'Dossiers déposés par mois') +
        '<details class="adr-detail"><summary>Tableau des 12 derniers mois</summary><table class="info-table fon-table"><tr><th>Mois</th><th>Dossiers déposés</th><th>Décidés</th><th>Parcelles recensées</th><th>Fiches</th></tr>' +
        b.mois.map(function (m) { return '<tr><td>' + m.mois + '</td><td>' + m.deposes + '</td><td>' + m.decides + '</td><td>' + m.recensees + '</td><td>' + m.fiches + '</td></tr>'; }).join('') +
        '</table></details>';
      html += '<h3>Dossiers par type</h3>' + (b.dossiers_type.length ? '<table class="info-table fon-table"><tr><th>Type</th><th>Total</th><th>En cours</th><th>Approuvés</th><th>Rejetés</th><th>Délai</th></tr>' +
        b.dossiers_type.map(function (x) {
          return '<tr><td>' + esc(x.k) + '</td><td>' + x.n + '</td><td>' + x.ouverts + '</td><td>' + x.approuves + '</td><td>' + x.rejetes + '</td><td>' +
            (x.delai_j != null ? A.fmt(x.delai_j, 1) + ' j' : '—') + '</td></tr>';
        }).join('') + '</table>' : '<p class="hint">Aucun dossier.</p>');
      html += '<h3>Litiges</h3>' + (b.litiges_type.length ? barres(b.litiges_type, function (x) { return x.n; }, function (x) { return x.k; },
        function (x) { return x.n + (x.ouverts ? ' (' + x.ouverts + ' en cours)' : ''); }) +
        (b.litiges_quartier.length ? '<p class="hint">Litiges en cours par quartier : ' + b.litiges_quartier.map(function (x) { return esc(x.k) + ' ' + x.n; }).join(' · ') + '</p>' : '')
        : '<p class="hint">Aucun litige.</p>');
      div.innerHTML = html;
    }).catch(function (e) { div.innerHTML = '<p class="form-msg">' + esc(e.message) + '</p>'; });
  }

  // ---------- Fiscalité ----------
  var bareme = null;
  function chargerFiscalite() {
    var annee = +$('fon-fis-annee').value || new Date().getFullYear();
    Promise.all([api('GET', '/fiscalite/role?annee=' + annee), bareme ? Promise.resolve(bareme) : api('GET', '/fiscalite/bareme')]).then(function (r) {
      var R = r[0]; bareme = r[1];
      var t = R.total;
      $('fon-fis-avert').innerHTML = '<p class="hint fon-avert">Estimation indicative' + (R.a_valider ? ' avec un <b>barème d\'exemple, pas encore validé</b> par le service des finances' : '') +
        '. Elle ne vaut pas avis d\'imposition : taux et base légale sont fixés par la loi de finances.</p>';
      $('fon-fis-cartes').innerHTML = carte(gnf(t.emis), 'montant estimé ' + R.annee) + carte(gnf(t.paye), 'recouvré') +
        carte(t.taux != null ? A.fmt(t.taux, 1) + ' %' : '—', 'taux de recouvrement') + carte(t.imposables + ' / ' + t.parcelles, 'parcelles imposables');
      $('fon-fis-quartiers').innerHTML = R.quartiers.length ? '<table class="info-table fon-table"><tr><th>Quartier</th><th>Imposables</th><th>Estimé</th><th>Recouvré</th></tr>' +
        R.quartiers.map(function (q) {
          var tx = q.emis ? 100 * q.paye / q.emis : 0;
          return '<tr><td>' + esc(q.quartier) + '</td><td>' + q.imposables + '</td><td>' + gnf(q.emis) + '</td><td>' + A.fmt(tx, 0) + ' %<i class="fon-mini"><b style="width:' +
            tx.toFixed(0) + '%"></b></i></td></tr>';
        }).join('') + '</table>' : '<p class="hint">Aucune parcelle.</p>';
      var restes = R.parcelles.filter(function (p) { return p.reste > 0; }).sort(function (a, b) { return b.reste - a.reste; });
      $('fon-fis-restes').innerHTML = restes.length ? restes.slice(0, 50).map(function (p) {
        return '<li data-p="' + p.id + '"><b>' + esc(p.numero) + '</b> · ' + esc(p.quartier || '') + ' · reste <b>' + gnf(p.reste) + '</b> <small>sur ' + gnf(p.montant) + '</small></li>';
      }).join('') + (restes.length > 50 ? '<li><small>… ' + (restes.length - 50) + ' autres (voir l\'export)</small></li>' : '') : '<li><small>Rien à recouvrer.</small></li>';
      $('fon-fis-restes').querySelectorAll('[data-p]').forEach(function (li) { li.onclick = function () { LabeFoncier.ouvrirParcelle(+li.dataset.p); }; });
      rendreBareme();
    }).catch(function (e) { $('fon-fis-cartes').innerHTML = '<p class="form-msg">' + esc(e.message) + '</p>'; });
  }
  function rendreBareme() {
    var b = bareme, ad = b.peut_modifier, div = $('fon-fis-bareme');
    var num = function (cle, v, step) { return ad ? '<input type="number" min="0" step="' + (step || 1) + '" data-' + cle + ' value="' + v + '">' : A.fmt(v, 2); };
    div.innerHTML = '<table class="info-table fon-table"><tr><th>Zone</th><th>GNF/m² terrain</th><th>GNF/m² bâti</th><th>Minimum</th></tr>' +
      b.bareme.map(function (z) {
        return '<tr data-z="' + z.zone + '"><td><b>' + z.zone + '</b> <small>' + esc(z.libelle) + '</small></td><td>' + num('t', z.terrain_m2) + '</td><td>' + num('b', z.bati_m2) +
          '</td><td>' + num('m', z.minimum, 100) + '</td></tr>';
      }).join('') + '</table>' +
      '<table class="info-table fon-table"><tr><th>Usage</th><th>Coefficient</th><th>Exonéré</th></tr>' + b.coefs.map(function (c) {
        return '<tr data-u="' + esc(c.usage) + '"><td>' + esc(c.usage) + '</td><td>' + num('c', c.coef, 0.1) + '</td><td>' +
          (ad ? '<input type="checkbox" data-e' + (c.exonere ? ' checked' : '') + '>' : (c.exonere ? 'oui' : 'non')) + '</td></tr>';
      }).join('') + '</table>' +
      '<p class="hint">Montant = (superficie × tarif terrain + emprise bâtie × tarif bâti) × coefficient de l\'usage, avec un minimum par zone. ' +
      'Domaine public et réserves communales exonérés.</p>' +
      '<details class="adr-detail"><summary>Zone de chaque quartier</summary><table class="info-table fon-table">' + b.zones.map(function (z) {
        return '<tr><td>' + esc(z.quartier) + '</td><td>' + (ad ? '<select data-q="' + esc(z.quartier) + '">' + ['A', 'B', 'C'].map(function (x) {
          return '<option' + (x === z.zone ? ' selected' : '') + '>' + x + '</option>';
        }).join('') + '</select>' : z.zone) + '</td></tr>';
      }).join('') + '</table></details>' + (ad ? '<div class="row"><button type="button" id="fon-fis-valider">' + (b.a_valider ? 'Marquer le barème comme validé' : 'Barème validé ✓ (remettre « à valider »)') + '</button></div>' : '');
    if (!ad) return;
    function apres() { bareme = null; chargerFiscalite(); LabeTerrain.toast('Barème enregistré.'); }
    div.querySelectorAll('tr[data-z] input').forEach(function (i) {
      i.onchange = function () {
        var tr = i.closest('tr');
        api('PUT', '/fiscalite/bareme/' + tr.dataset.z, { terrain_m2: +tr.querySelector('[data-t]').value, bati_m2: +tr.querySelector('[data-b]').value,
          minimum: +tr.querySelector('[data-m]').value }).then(apres).catch(O().fail);
      };
    });
    div.querySelectorAll('tr[data-u] input').forEach(function (i) {
      i.onchange = function () {
        var tr = i.closest('tr');
        api('PUT', '/fiscalite/coefs/' + encodeURIComponent(tr.dataset.u), { coef: +tr.querySelector('[data-c]').value, exonere: tr.querySelector('[data-e]').checked })
          .then(apres).catch(O().fail);
      };
    });
    div.querySelectorAll('select[data-q]').forEach(function (s) {
      s.onchange = function () { api('PUT', '/fiscalite/zones/' + encodeURIComponent(s.dataset.q), { zone: s.value }).then(apres).catch(O().fail); };
    });
    $('fon-fis-valider').onclick = function () {
      if (b.a_valider) {
        var ref = prompt('Référence de la délibération ou de la note qui fixe ce barème :');
        if (!ref) return;
        api('POST', '/fiscalite/valider-bareme', { valide: true, reference: ref }).then(apres).catch(O().fail);
      } else api('POST', '/fiscalite/valider-bareme', { valide: false }).then(apres).catch(O().fail);
    };
  }
  $('fon-fis-annee').onchange = chargerFiscalite;
  $('fon-fis-export').onclick = function () {
    Auth.blobUrl('/api/foncier/fiscalite/role.csv?annee=' + $('fon-fis-annee').value).then(function (url) {
      var a = document.createElement('a'); a.href = url; a.download = 'role_foncier_' + $('fon-fis-annee').value + '.csv'; a.click();
    }).catch(function () { alert('Export impossible.'); });
  };

  // ---------- Démarrage (après foncier.js) ----------
  $('fon-l-statut').onchange = function () { FL.statut = this.value; rendreLitiges(); };
  $('fon-l-type').onchange = function () { FL.type = this.value; rendreLitiges(); };
  $('fon-l-nouveau').onclick = function () { formLitige(); };

  var demarrage = LabeFoncier.start;
  LabeFoncier.start = function () {
    demarrage();
    Auth.api('GET', '/foncier/listes-gestion').then(function (l) {
      LG = l;
      $('fon-l-type').innerHTML = '<option value="">Tous les types</option>' + opts(l.types_litige);
      $('fon-titulaires-recherche').classList.toggle('hidden', !l.acces);
      $('fon-fis-btn').classList.toggle('hidden', !l.acces_fiscal);
      var an = new Date().getFullYear();
      $('fon-fis-annee').innerHTML = [an, an - 1, an - 2].map(function (y) { return '<option>' + y + '</option>'; }).join('');
      A.addOverlay({ name: 'Litiges fonciers en cours', layer: litLayer, on: true, group: 'Foncier',
        swatch: '<span class="swatch dot" style="background:#c92a2a"></span>' });
      A.enregistrerIdentifiable(litLayer, 'Litiges fonciers');
      var attendre = setInterval(function () {   // les outils de foncier.js sont prêts après le chargement des listes
        if (!LabeFoncier.outils.listes()) return;
        clearInterval(attendre);
        O().surSousOnglet.lit = rendreLitiges;
        O().surSousOnglet.bil = chargerBilan;
        O().surSousOnglet.fis = chargerFiscalite;
        chargerLitiges();
      }, 200);
    }).catch(function () {});
  };

  window.LabeFoncierGestion = { completerParcelle: completerParcelle, completerDossier: completerDossier, ouvrirLitige: function (id) { ouvrirLitige(id); },
    signalerLitige: formLitige };
})();
