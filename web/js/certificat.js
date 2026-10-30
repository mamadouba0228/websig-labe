/* Certificat d'adresse imprimable (A4, « Enregistrer en PDF » depuis le navigateur).
 * Adresse désignée par le code de sa voie et son numéro : certificat.html?voie=DK1-012&num=42A
 * Mode serveur : adresse validée lue dans la base (API publique). Démo GitHub : fichiers publics, document « spécimen ». */
(function () {
  'use strict';

  var CONFIG = window.LABE_CONFIG || {};
  var STATIC = CONFIG.mode === 'static';
  var q = new URLSearchParams(location.search), voie = (q.get('voie') || '').trim(), num = (q.get('num') || '').trim();
  var page = document.getElementById('page');

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function erreur(msg) { page.innerHTML = '<p class="erreur">' + esc(msg) + '</p>'; }
  function dateFr(d) { return new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); }

  function charger() {
    if (!voie || !/^\d+[A-Za-z]?$/.test(num)) return Promise.reject(new Error('Adresse non précisée : ouvrez le certificat depuis la fiche d\'une adresse.'));
    if (!STATIC) {
      return fetch('/api/adressage/certificat?voie=' + encodeURIComponent(voie) + '&num=' + encodeURIComponent(num)).then(function (r) {
        return r.json().then(function (d) { if (!r.ok) throw new Error(d.detail || 'Certificat indisponible.'); return d; });
      });
    }
    // démo : adresses et voies publiées sur GitHub Pages
    return Promise.all([fetch('data/adresses.geojson').then(function (r) { return r.json(); }),
      fetch('data/voies.geojson').then(function (r) { return r.json(); })]).then(function (res) {
      var a = res[0].features.filter(function (f) {
        return String(f.properties.code_voie).toUpperCase() === voie.toUpperCase() && String(f.properties.num).toUpperCase() === num.toUpperCase();
      })[0];
      if (!a) throw new Error('Adresse inconnue.');
      var v = res[1].features.filter(function (f) { return f.properties.code === a.properties.code_voie; })[0];
      var vp = v ? v.properties : {}, p = a.properties, m = /^(\d+)([A-Z]?)$/i.exec(p.num);
      return {
        numero: +m[1], suffixe: m[2].toUpperCase(), cote: p.cote, quartier: p.quartier, statut: p.statut, libelle: p.libelle,
        code_voie: p.code_voie, type_voie: vp.type_voie, nom_voie: vp.nom, statut_nom: vp.statut_nom,
        lat: a.geometry.coordinates[1], lon: a.geometry.coordinates[0], reference: 'DEMO-' + p.code_voie + '-' + p.num, specimen: true
      };
    });
  }

  function rendre(d) {
    var voieLib = d.type_voie + ' ' + (d.nom_voie ? d.nom_voie : d.code_voie);
    var lignes = [
      ['Numéro', d.numero + (d.suffixe || '') + ' (côté ' + (d.cote === 'pair' ? 'pair, à droite' : 'impair, à gauche') + ' dans le sens de la voie)'],
      ['Voie', voieLib + (d.statut_nom && d.statut_nom !== 'Officiel' ? ' — ' + d.statut_nom.toLowerCase() : '')],
      ['Code de la voie', d.code_voie],
      ['Quartier', d.quartier],
      ['Complément', d.complement],
      ['Coordonnées GPS', d.lat.toFixed(6) + ' N, ' + Math.abs(d.lon).toFixed(6) + ' O (WGS 84)'],
      ['Adresse validée le', d.valide_le && dateFr(d.valide_le)],
      ['Plaque posée le', d.pose_le && dateFr(d.pose_le)],
      ['Dénomination de la voie', d.deliberation]
    ].filter(function (r) { return r[1]; });
    page.innerHTML =
      (d.specimen ? '<div class="filigrane">SPÉCIMEN</div>' : '') +
      '<header class="entete"><div class="etat"><b>RÉPUBLIQUE DE GUINÉE</b><span>Travail — Justice — Solidarité</span></div>' +
      '<div class="commune"><span>Région administrative de Labé</span><b>COMMUNE URBAINE DE LABÉ</b><span>Service de l\'adressage</span></div></header>' +
      '<p class="ref">Référence : <b>' + esc(d.reference) + '</b></p>' +
      '<h1>Certificat d\'adresse</h1>' +
      '<p class="texte">Le Maire de la Commune urbaine de Labé certifie que <span class="champ" id="c-benef">' +
      '…………………………………………</span> réside ou exerce à l\'adresse suivante, attribuée dans le cadre de l\'adressage de la commune :</p>' +
      '<p class="adresse">' + esc(d.numero + (d.suffixe || '') + ', ' + voieLib) + '<br><small>' + esc(d.quartier || '') + ' — Labé, République de Guinée</small></p>' +
      '<div class="corps"><table class="details">' + lignes.map(function (r) { return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>' +
      '<div class="carte"><div id="carte"></div><small>Emplacement de l\'adresse</small></div></div>' +
      '<p class="texte">Le présent certificat est délivré à l\'intéressé(e) pour servir et valoir ce que de droit<span id="c-motif"></span>.</p>' +
      '<div class="pied"><div class="qr"><div id="qr"></div><small>Vérification en ligne :<br>' + esc(location.href.split('#')[0]) + '</small></div>' +
      '<div class="signature"><p>Fait à Labé, le ' + dateFr(new Date()) + '</p><p><b>Le Maire</b><br><small>(ou par délégation)</small></p><div class="cachet">Cachet et signature</div></div></div>' +
      (d.specimen ? '<p class="avertissement">Document de démonstration, sans valeur officielle : seules les adresses validées par la mairie donnent lieu à un certificat.</p>' : '');

    // carte de situation
    var m = L.map('carte', { zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false })
      .setView([d.lat, d.lon], 17);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
    L.circleMarker([d.lat, d.lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#c8102e', fillOpacity: 1 }).addTo(m);
    // QR code : lien de vérification (la page relit l'adresse dans la base de la mairie)
    if (window.qrcode) {
      var qr = qrcode(0, 'M'); qr.addData(location.href.split('#')[0]); qr.make();
      document.getElementById('qr').innerHTML = qr.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
    }
    document.title = 'Certificat d\'adresse — ' + d.numero + (d.suffixe || '') + ', ' + voieLib;
  }

  function majChamps() {
    var b = document.getElementById('beneficiaire').value.trim(), m = document.getElementById('motif').value.trim();
    var cb = document.getElementById('c-benef'), cm = document.getElementById('c-motif');
    if (cb) cb.textContent = b || '…………………………………………';
    if (cm) cm.textContent = m ? ', notamment pour : ' + m : '';
  }
  document.getElementById('beneficiaire').addEventListener('input', majChamps);
  document.getElementById('motif').addEventListener('input', majChamps);
  document.getElementById('imprimer').addEventListener('click', function () {
    if (!document.getElementById('beneficiaire').value.trim() && !confirm('Le nom du bénéficiaire n\'est pas renseigné. Imprimer quand même ?')) return;
    window.print();
  });

  charger().then(rendre).catch(function (e) { erreur(e.message); });
})();
