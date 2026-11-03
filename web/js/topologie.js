/* Relations spatiales entre deux géométries, comme l'outil « Sélection par localisation » de QGIS :
 * intersecte, touche, contient, chevauche, est disjoint, est à l'intérieur, égal, croise.
 * Calcul dans le navigateur, en coordonnées planes locales (mètres), avec une tolérance de contact de 5 cm
 * (les coordonnées servies au navigateur sont arrondies à environ 10 cm).
 * Méthode : intersections des segments des deux géométries, et position (intérieur, bord, extérieur) de points
 * témoins de chacune (sommets, milieux des segments, un point intérieur par polygone) par rapport à l'autre.
 * Index : grille de cases de 25 m pour les segments et les témoins ; pour un grand polygone, la position du centre
 * de chaque case est connue (une horizontale par rangée de cases), et celle d'un point se déduit du centre de sa case
 * en comptant les seuls segments de la case traversés entre les deux. */
(function () {
  'use strict';

  var LAT0 = 11.32, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110574;
  var EPS = 0.05;      // m : deux objets à moins de 5 cm se touchent
  var CASE = 25;       // m : côté des cases de l'index

  function ajout(index, k, v) { (index[k] || (index[k] = [])).push(v); }
  // cases couvertes par une emprise [x0, y0, x1, y1]
  function cases(x0, y0, x1, y1, f) {
    for (var i = Math.floor(x0 / CASE), i1 = Math.floor(x1 / CASE); i <= i1; i++)
      for (var j = Math.floor(y0 / CASE), j1 = Math.floor(y1 / CASE); j <= j1; j++) f(i + ':' + j, i, j);
  }
  function segDist(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    var t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  function proches(p, q) { return Math.abs(p[0] - q[0]) <= EPS && Math.abs(p[1] - q[1]) <= EPS; }

  // point intérieur d'un polygone (avec ses trous) : milieu du plus long intervalle intérieur sur une horizontale
  function pointInterieur(anneaux) {
    var y0 = Infinity, y1 = -Infinity;
    anneaux[0].forEach(function (p) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); });
    var y = (y0 + y1) / 2 + 1e-4, xs = [];
    anneaux.forEach(function (r) {
      for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
        var a = r[j], b = r[i];
        if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
    });
    xs.sort(function (u, v) { return u - v; });
    var best = null, w = -1;
    for (var k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1] - xs[k] > w) { w = xs[k + 1] - xs[k]; best = [(xs[k] + xs[k + 1]) / 2, y]; }
    return best;
  }

  /* Géométrie préparée (GeoJSON lon/lat → mètres) : dim (0 point, 1 ligne, 2 surface), segments et points témoins
   * indexés par case, extrémités des lignes. Un témoin est de genre 'i' (intérieur de l'objet) ou 'b' (bord). */
  function preparer(geometry) {
    var t = geometry.type, c = geometry.coordinates;
    var g = { dim: 0, segs: [], cs: {}, bouts: [], tem: [], ct: {}, bb: [Infinity, Infinity, -Infinity, -Infinity], rangees: null };
    function m(p) {
      var q = [p[0] * KX, p[1] * KY];
      if (q[0] < g.bb[0]) g.bb[0] = q[0]; if (q[1] < g.bb[1]) g.bb[1] = q[1];
      if (q[0] > g.bb[2]) g.bb[2] = q[0]; if (q[1] > g.bb[3]) g.bb[3] = q[1];
      return q;
    }
    function temoin(p, genre) {
      g.tem.push({ p: p, k: genre });
      ajout(g.ct, Math.floor(p[0] / CASE) + ':' + Math.floor(p[1] / CASE), g.tem.length - 1);
    }
    function segment(a, b, poly, anneau) {
      if (proches(a, b)) return;
      g.segs.push({ a: a, b: b, poly: poly, anneau: anneau });
      var n = g.segs.length - 1;
      cases(Math.min(a[0], b[0]) - EPS, Math.min(a[1], b[1]) - EPS, Math.max(a[0], b[0]) + EPS, Math.max(a[1], b[1]) + EPS,
        function (k) { ajout(g.cs, k, n); });
    }
    if (t === 'Point' || t === 'MultiPoint') {
      (t === 'Point' ? [c] : c).forEach(function (p) { temoin(m(p), 'i'); });
    } else if (t === 'LineString' || t === 'MultiLineString') {
      g.dim = 1;
      (t === 'LineString' ? [c] : c).forEach(function (l) {
        var pts = l.map(m), ferme = pts.length > 2 && proches(pts[0], pts[pts.length - 1]);
        if (!ferme && pts.length) g.bouts.push(pts[0], pts[pts.length - 1]);
        pts.forEach(function (p, i) {
          temoin(p, !ferme && (i === 0 || i === pts.length - 1) ? 'b' : 'i');
          if (i) { segment(pts[i - 1], p, -1, -1); temoin([(pts[i - 1][0] + p[0]) / 2, (pts[i - 1][1] + p[1]) / 2], 'i'); }
        });
      });
    } else if (t === 'Polygon' || t === 'MultiPolygon') {
      g.dim = 2;
      (t === 'Polygon' ? [c] : c).forEach(function (poly, pi) {
        var anneaux = poly.filter(function (r) { return r && r.length > 3; }).map(function (r) { return r.map(m); });
        if (!anneaux.length) return;
        anneaux.forEach(function (r, ri) {
          for (var i = 1; i < r.length; i++) {
            segment(r[i - 1], r[i], pi, ri);
            temoin(r[i], 'b'); temoin([(r[i - 1][0] + r[i][0]) / 2, (r[i - 1][1] + r[i][1]) / 2], 'b');
          }
        });
        var pi2 = pointInterieur(anneaux);
        if (pi2) temoin(pi2, 'i');
      });
    }
    return g;
  }

  function horsEmprise(p, bb) { return p[0] < bb[0] - EPS || p[0] > bb[2] + EPS || p[1] < bb[1] - EPS || p[1] > bb[3] + EPS; }
  function emprisesDisjointes(a, b) { return a[0] > b[2] + EPS || b[0] > a[2] + EPS || a[1] > b[3] + EPS || b[1] > a[3] + EPS; }
  function emprisesIncluse(a, b) { return a[0] >= b[0] - EPS && a[1] >= b[1] - EPS && a[2] <= b[2] + EPS && a[3] <= b[3] + EPS; }

  // le segment [p, q] coupe-t-il le segment [a, b] ?
  function coupe(p, q, a, b) {
    function o(u, v, w) { return (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]); }
    return (o(p, q, a) > 0) !== (o(p, q, b) > 0) && (o(a, b, p) > 0) !== (o(a, b, q) > 0);
  }

  // surface : centre de la case (i, j) à l'intérieur ? (règle pair-impair sur l'horizontale de la rangée, calculée une fois)
  function centreDedans(G, i, j) {
    if (!G.rangees) G.rangees = {};
    var xs = G.rangees[j];
    if (!xs) {
      var y = (j + 0.5) * CASE;
      xs = [];
      G.segs.forEach(function (s) {
        if ((s.a[1] > y) !== (s.b[1] > y)) xs.push(s.a[0] + (y - s.a[1]) * (s.b[0] - s.a[0]) / (s.b[1] - s.a[1]));
      });
      xs.sort(function (u, v) { return u - v; });
      G.rangees[j] = xs;
    }
    var x = (i + 0.5) * CASE, lo = 0, hi = xs.length;
    while (lo < hi) { var mi = (lo + hi) >> 1; if (xs[mi] < x) lo = mi + 1; else hi = mi; }
    return lo % 2 === 1;
  }

  // position d'un point par rapport à une géométrie : 1 intérieur, 0 bord, -1 extérieur
  function classer(p, G) {
    if (horsEmprise(p, G.bb)) return -1;
    if (G.dim === 0) {
      var tp = G.ct[Math.floor(p[0] / CASE) + ':' + Math.floor(p[1] / CASE)] || [];
      // un point proche d'une limite de case : on regarde aussi les cases voisines
      var trouve = false;
      cases(p[0] - EPS, p[1] - EPS, p[0] + EPS, p[1] + EPS, function (k) {
        (G.ct[k] || []).forEach(function (n) { if (proches(G.tem[n].p, p)) trouve = true; });
      });
      return trouve || tp.some(function (n) { return proches(G.tem[n].p, p); }) ? 1 : -1;
    }
    var i = Math.floor(p[0] / CASE), j = Math.floor(p[1] / CASE), ici = G.cs[i + ':' + j] || [];
    // bord : un segment à moins de EPS (les segments sont rangés dans toutes les cases qu'ils frôlent à EPS près)
    var bord = false, interieur = false;
    for (var k = 0; k < ici.length; k++) {
      var s = G.segs[ici[k]];
      if (segDist(p, s.a, s.b) <= EPS) {
        if (G.dim === 2 || G.bouts.some(function (q) { return proches(q, p); })) bord = true; else interieur = true;
      }
    }
    if (G.dim === 1) return interieur ? 1 : bord ? 0 : -1;
    if (bord) return 0;
    // intérieur : position du centre de la case, inversée à chaque segment traversé entre le point et ce centre
    var centre = [(i + 0.5) * CASE, (j + 0.5) * CASE], dedans = centreDedans(G, i, j);
    for (k = 0; k < ici.length; k++) { s = G.segs[ici[k]]; if (coupe(p, centre, s.a, s.b)) dedans = !dedans; }
    return dedans ? 1 : -1;
  }

  // intersections des segments de A et de B : croisement franc, contact, recouvrement colinéaire
  function cote(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    var d = (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / l;
    return Math.abs(d) <= EPS ? 0 : d > 0 ? 1 : -1;
  }
  function segments(A, B) {
    var r = { croise: false, colin: false, contacts: [] };
    if (!A.segs.length || !B.segs.length) return r;
    var petit = A.segs.length <= B.segs.length ? A : B, grand = petit === A ? B : A;
    petit.segs.forEach(function (s) {
      var x0 = Math.min(s.a[0], s.b[0]) - EPS, x1 = Math.max(s.a[0], s.b[0]) + EPS, y0 = Math.min(s.a[1], s.b[1]) - EPS, y1 = Math.max(s.a[1], s.b[1]) + EPS;
      if (x1 < grand.bb[0] || x0 > grand.bb[2] || y1 < grand.bb[1] || y0 > grand.bb[3]) return;
      var vus = {};
      cases(x0, y0, x1, y1, function (k) {
        (grand.cs[k] || []).forEach(function (n) {
          if (vus[n]) return;
          vus[n] = 1;
          var t = grand.segs[n];
          if (Math.max(t.a[0], t.b[0]) < x0 || Math.min(t.a[0], t.b[0]) > x1 || Math.max(t.a[1], t.b[1]) < y0 || Math.min(t.a[1], t.b[1]) > y1) return;
          var d1 = cote(s.a, t.a, t.b), d2 = cote(s.b, t.a, t.b), d3 = cote(t.a, s.a, s.b), d4 = cote(t.b, s.a, s.b);
          if (d1 === 0 && d2 === 0) {
            // colinéaires : recouvrement de longueur non nulle, ou simple contact à une extrémité
            var ux = s.b[0] - s.a[0], uy = s.b[1] - s.a[1], l = Math.hypot(ux, uy) || 1;
            var pa = ((t.a[0] - s.a[0]) * ux + (t.a[1] - s.a[1]) * uy) / l, pb = ((t.b[0] - s.a[0]) * ux + (t.b[1] - s.a[1]) * uy) / l;
            var lo = Math.max(0, Math.min(pa, pb)), hi = Math.min(l, Math.max(pa, pb));
            if (hi - lo > EPS) r.colin = true;
            else if (hi - lo >= -EPS) r.contacts.push([s.a[0] + ux * lo / l, s.a[1] + uy * lo / l]);
            return;
          }
          if (d1 * d2 < 0 && d3 * d4 < 0) { r.croise = true; return; }
          [[s.a, t.a, t.b], [s.b, t.a, t.b], [t.a, s.a, s.b], [t.b, s.a, s.b]].forEach(function (x) {
            if (segDist(x[0], x[1], x[2]) <= EPS) r.contacts.push(x[0]);
          });
        });
      });
    });
    return r;
  }

  // positions des points témoins de X par rapport à Y (seuls ceux dans l'emprise de Y sont examinés)
  function temoins(X, Y) {
    var r = { ii: 0, ib: 0, io: 0, bi: 0, bb: 0, bo: 0, dehors: !emprisesIncluse(X.bb, Y.bb) };
    function examiner(n) {
      var t = X.tem[n];
      if (horsEmprise(t.p, Y.bb)) return;
      var c = classer(t.p, Y);
      r[t.k + (c > 0 ? 'i' : c === 0 ? 'b' : 'o')]++;
    }
    // peu de témoins : on les parcourt tous ; sinon les cases de X qui couvrent l'emprise de Y
    if (X.tem.length <= 64) { for (var n = 0; n < X.tem.length; n++) examiner(n); return r; }
    var x0 = Math.max(X.bb[0], Y.bb[0]) - EPS, x1 = Math.min(X.bb[2], Y.bb[2]) + EPS, y0 = Math.max(X.bb[1], Y.bb[1]) - EPS, y1 = Math.min(X.bb[3], Y.bb[3]) + EPS;
    if (x0 > x1 || y0 > y1) return r;
    cases(x0, y0, x1, y1, function (k) { (X.ct[k] || []).forEach(examiner); });
    return r;
  }

  /* Relations de A avec B (A et B préparées). Renvoie un objet de prédicats, au sens de QGIS. */
  function relations(A, B) {
    var faux = { intersecte: false, touche: false, contient: false, chevauche: false, interieur: false, egal: false, croise: false };
    if (emprisesDisjointes(A.bb, B.bb)) return faux;
    var S = segments(A, B), TA = temoins(A, B), TB = temoins(B, A), dA = A.dim, dB = B.dim;
    var dansA = TA.ii + TA.ib + TA.bi + TA.bb, dansB = TB.ii + TB.ib + TB.bi + TB.bb;
    var inter = S.croise || S.colin || S.contacts.length > 0 || dansA > 0 || dansB > 0;
    if (!inter) return faux;
    var horsA = TA.dehors || TA.io + TA.bo > 0, horsB = TB.dehors || TB.io + TB.bo > 0;
    // contact entre lignes en un point intérieur aux deux (ni l'une ni l'autre ne s'y arrête)
    function bout(G, p) { return G.bouts.some(function (q) { return proches(q, p); }); }
    var contactInterieur = dA === 1 && dB === 1 && S.contacts.some(function (p) { return !bout(A, p) && !bout(B, p); });
    var interieurs;
    if (dA === 0) interieurs = TA.ii > 0;
    else if (dB === 0) interieurs = TB.ii > 0;
    else if (dA === 2 && dB === 2) interieurs = S.croise || TA.ii + TA.bi > 0 || TB.ii + TB.bi > 0;
    else if (dA === 2) interieurs = S.croise || TB.ii > 0;
    else if (dB === 2) interieurs = S.croise || TA.ii > 0;
    else interieurs = S.croise || S.colin || contactInterieur || TA.ii > 0 || TB.ii > 0;
    var aDansB = dA <= dB && !horsA && !(S.croise && dB === 2) && !(dA === 2 && TB.bi > 0);
    var bDansA = dB <= dA && !horsB && !(S.croise && dA === 2) && !(dB === 2 && TA.bi > 0);
    var croise = false;
    if (dA === 1 && dB === 1) croise = (S.croise || contactInterieur) && !S.colin;
    else if (dA === 1 && dB === 2) croise = interieurs && horsA;
    else if (dA === 2 && dB === 1) croise = interieurs && horsB;
    else if (dA === 0 && dB > 0) croise = TA.ii > 0 && TA.io + TA.bo > 0;
    else if (dB === 0 && dA > 0) croise = TB.ii > 0 && TB.io + TB.bo > 0;
    return {
      intersecte: true,
      touche: !interieurs,
      contient: bDansA && interieurs,
      interieur: aDansB && interieurs,
      egal: aDansB && bDansA && dA === dB,
      chevauche: dA === dB && !aDansB && !bDansA && (dA === 1 ? S.colin : interieurs),
      croise: croise
    };
  }

  window.LabeTopo = { preparer: preparer, relations: relations, emprisesDisjointes: emprisesDisjointes, EPS: EPS };
})();
