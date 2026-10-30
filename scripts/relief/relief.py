"""Relief et risques naturels de la commune de Labé, à partir du modèle numérique de terrain
Copernicus GLO-30 (30 m, gratuit, https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model).

Produit dans /out (data/public/relief) :
  relief.json          métadonnées de la grille et statistiques
  relief.bin.gz        grille compacte lue par le navigateur (altitude, pente, hauteur au-dessus du drainage)
  ombrage.png          relief ombré        } images en Web Mercator, découpées sur la commune,
  pentes.png           classes de pente    } affichées par Leaflet (imageOverlay)
  inondation.png       zones inondables    }
  zones_inondables.geojson   zones inondables vectorisées (aussi chargées dans PostGIS : ref.zones_inondables)

Méthode des zones inondables : HAND (« Height Above Nearest Drainage », Rennó et al. 2008).
  1. comblement des cuvettes et sens d'écoulement (Priority-Flood, Barnes et al. 2014) ;
  2. surface drainée de chaque cellule, réseau de drainage = cellules drainant plus de SEUIL_DRAINAGE_KM2 ;
  3. HAND = dénivelé entre la cellule et le point du réseau où ses eaux le rejoignent.
  Une faible hauteur au-dessus du drainage signale un terrain exposé aux débordements et au ruissellement.
"""
import gzip
import heapq
import json
import os
import subprocess

import numpy as np
from osgeo import gdal, ogr, osr

gdal.UseExceptions()

SOURCE = ("/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/"
          "Copernicus_DSM_COG_10_N11_00_W013_00_DEM/Copernicus_DSM_COG_10_N11_00_W013_00_DEM.tif")
COMMUNE = "/data/limite_commune.geojson"
OUT = "/out"
ARCSEC = 1 / 3600
MARGE_HYDRO = 0.10            # degrés autour de la commune pour le calcul des écoulements
SEUIL_DRAINAGE_KM2 = 0.5      # surface drainée à partir de laquelle une cellule fait partie du réseau
CLASSES_PENTE = [5, 15, 30]   # % : faible < 5 ≤ modérée < 15 ≤ forte < 30 ≤ très forte
CLASSES_HAND = [2, 5]         # m : fort < 2 ≤ moyen < 5


def emprise_commune():
    ds = ogr.Open(COMMUNE)
    lyr = ds.GetLayer(0)
    xmin, xmax, ymin, ymax = lyr.GetExtent()
    geoms = ogr.Geometry(ogr.wkbMultiPolygon)
    for f in lyr:
        g = f.GetGeometryRef()
        if g.GetGeometryType() == ogr.wkbPolygon:
            geoms.AddGeometry(g.Clone())
        else:
            for i in range(g.GetGeometryCount()):
                geoms.AddGeometry(g.GetGeometryRef(i).Clone())
    return (xmin, ymin, xmax, ymax), geoms


def lire_mnt(bb):
    """Fenêtre du MNT alignée sur la grille d'origine (centres de pixels aux secondes entières)."""
    src = gdal.Open(SOURCE)
    x0, dx, _, y0, _, dy = src.GetGeoTransform()
    c0 = int(np.floor((bb[0] - x0) / dx)); c1 = int(np.ceil((bb[2] - x0) / dx))
    r0 = int(np.floor((bb[3] - y0) / dy)); r1 = int(np.ceil((bb[1] - y0) / dy))
    z = src.GetRasterBand(1).ReadAsArray(c0, r0, c1 - c0, r1 - r0).astype(np.float64)
    gt = (x0 + c0 * dx, dx, 0, y0 + r0 * dy, 0, dy)
    return z, gt


def pas_metriques(gt, h):
    lat = gt[3] + (h / 2) * gt[5]
    return abs(gt[1]) * 111320 * np.cos(np.radians(lat)), abs(gt[5]) * 110574


def lisser(z):
    """Moyenne pondérée 3×3 (1-2-1) : atténue le bruit du modèle (arbres, toits) avant le calcul des pentes."""
    p = np.pad(z, 1, mode="edge")
    k = [1, 2, 1]
    out = np.zeros_like(z)
    for i in range(3):
        for j in range(3):
            out += k[i] * k[j] * p[i:i + z.shape[0], j:j + z.shape[1]]
    return out / 16


def pente_pct(z, ex, ey):
    """Pente en %, opérateur de Horn (comme gdaldem slope)."""
    p = np.pad(z, 1, mode="edge")
    a, b, c = p[:-2, :-2], p[:-2, 1:-1], p[:-2, 2:]
    d, f = p[1:-1, :-2], p[1:-1, 2:]
    g, h, i = p[2:, :-2], p[2:, 1:-1], p[2:, 2:]
    dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * ex)
    dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * ey)
    return 100 * np.hypot(dzdx, dzdy)


def ombrage(z, ex, ey, azimut=315, hauteur=45, exageration=2.0):
    p = np.pad(z * exageration, 1, mode="edge")
    dzdx = ((p[:-2, 2:] + 2 * p[1:-1, 2:] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[1:-1, :-2] + p[2:, :-2])) / (8 * ex)
    dzdy = ((p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:])) / (8 * ey)
    pente = np.arctan(np.hypot(dzdx, dzdy))
    aspect = np.arctan2(dzdy, -dzdx)
    az, alt = np.radians(360 - azimut + 90), np.radians(hauteur)
    hs = np.sin(alt) * np.cos(pente) + np.cos(alt) * np.sin(pente) * np.cos(az - aspect)
    return np.clip(hs, 0, 1)


def priority_flood(z):
    """Comble les cuvettes et donne, pour chaque cellule, la cellule vers laquelle elle s'écoule.
    Retourne (altitude comblée, aval, ordre de traitement de l'aval vers l'amont)."""
    H, W = z.shape
    n = H * W
    zf = z.ravel().copy()
    aval = np.full(n, -1, dtype=np.int64)
    fait = np.zeros(n, dtype=bool)
    ordre = np.empty(n, dtype=np.int64)
    tas, seq = [], 0
    for r in range(H):
        for c in (0, W - 1):
            k = r * W + c
            if not fait[k]:
                fait[k] = True; heapq.heappush(tas, (zf[k], seq, k)); seq += 1
    for c in range(1, W - 1):
        for r in (0, H - 1):
            k = r * W + c
            if not fait[k]:
                fait[k] = True; heapq.heappush(tas, (zf[k], seq, k)); seq += 1
    voisins = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    m = 0
    pop, push = heapq.heappop, heapq.heappush
    while tas:
        zc, _, k = pop(tas)
        ordre[m] = k; m += 1
        r, c = divmod(k, W)
        for dr, dc in voisins:
            rr, cc = r + dr, c + dc
            if 0 <= rr < H and 0 <= cc < W:
                kk = rr * W + cc
                if not fait[kk]:
                    fait[kk] = True
                    aval[kk] = k
                    if zf[kk] < zc:
                        zf[kk] = zc
                    push(tas, (zf[kk], seq, kk)); seq += 1
    return zf.reshape(H, W), aval, ordre


def hand(zf, aval, ordre, ex, ey):
    n = zf.size
    surf = np.ones(n)
    for k in ordre[::-1]:            # de l'amont vers l'aval
        a = aval[k]
        if a >= 0:
            surf[a] += surf[k]
    surf_km2 = surf * ex * ey / 1e6
    reseau = surf_km2 >= SEUIL_DRAINAGE_KM2
    base = np.empty(n, dtype=np.int64)
    for k in ordre:                  # de l'aval vers l'amont
        a = aval[k]
        base[k] = k if (reseau[k] or a < 0) else base[a]
    z = zf.ravel()
    return (z - z[base]).reshape(zf.shape), surf_km2.reshape(zf.shape), reseau.reshape(zf.shape)


def masque_commune(geom, gt, shape):
    drv = gdal.GetDriverByName("MEM")
    ds = drv.Create("", shape[1], shape[0], 1, gdal.GDT_Byte)
    ds.SetGeoTransform(gt)
    srs = osr.SpatialReference(); srs.ImportFromEPSG(4326)
    ds.SetProjection(srs.ExportToWkt())
    mem = ogr.GetDriverByName("Memory").CreateDataSource("")
    lyr = mem.CreateLayer("c", srs, ogr.wkbMultiPolygon)
    f = ogr.Feature(lyr.GetLayerDefn()); f.SetGeometry(geom); lyr.CreateFeature(f)
    gdal.RasterizeLayer(ds, [1], lyr, burn_values=[1], options=["ALL_TOUCHED=TRUE"])
    return ds.GetRasterBand(1).ReadAsArray().astype(bool)


def lignes_mercator(gt, h):
    """Pour une image Web Mercator de même hauteur, indice de la ligne source (géographique) de chaque ligne."""
    lat_n, lat_s = gt[3] - gt[5] / 2, gt[3] + (h - 0.5) * gt[5]   # bords nord et sud
    merc = lambda lat: np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))
    yn, ys = merc(lat_n), merc(lat_s)
    y = yn + (np.arange(h) + 0.5) / h * (ys - yn)
    lat = np.degrees(2 * np.arctan(np.exp(y)) - np.pi / 2)
    return np.clip(np.round((lat - gt[3]) / gt[5]).astype(int), 0, h - 1), (lat_s, lat_n)


def png(nom, rgba, rows):
    rgba = rgba[rows]
    h, w, _ = rgba.shape
    mem = gdal.GetDriverByName("MEM").Create("", w, h, 4, gdal.GDT_Byte)
    for b in range(4):
        mem.GetRasterBand(b + 1).WriteArray(rgba[:, :, b])
    gdal.GetDriverByName("PNG").CreateCopy(os.path.join(OUT, nom), mem, options=["ZLEVEL=9"])
    try:
        os.remove(os.path.join(OUT, nom + ".aux.xml"))
    except FileNotFoundError:
        pass


def couleurs(classes, palette, dedans):
    rgba = np.zeros(classes.shape + (4,), dtype=np.uint8)
    for k, col in palette.items():
        sel = (classes == k) & dedans
        rgba[sel] = col
    return rgba


def main():
    os.makedirs(OUT, exist_ok=True)
    bb, geom = emprise_commune()
    print("Commune :", [round(v, 4) for v in bb])

    # ---------- Hydrologie sur une fenêtre élargie ----------
    bbh = (bb[0] - MARGE_HYDRO, bb[1] - MARGE_HYDRO, bb[2] + MARGE_HYDRO, bb[3] + MARGE_HYDRO)
    zh, gth = lire_mnt(bbh)
    exh, eyh = pas_metriques(gth, zh.shape[0])
    print("MNT lu :", zh.shape, "cellules de %.1f × %.1f m" % (exh, eyh))
    zf, aval, ordre = priority_flood(lisser(zh))
    print("Écoulements calculés")
    hh, surf, reseau = hand(zf, aval, ordre, exh, eyh)

    # ---------- Fenêtre de la commune ----------
    m = 0.003
    c0 = int(np.floor((bb[0] - m - gth[0]) / gth[1])); c1 = int(np.ceil((bb[2] + m - gth[0]) / gth[1]))
    r0 = int(np.floor((bb[3] + m - gth[3]) / gth[5])); r1 = int(np.ceil((bb[1] - m - gth[3]) / gth[5]))
    win = (slice(r0, r1), slice(c0, c1))
    z, hd = zh[win], hh[win]
    gt = (gth[0] + c0 * gth[1], gth[1], 0, gth[3] + r0 * gth[5], 0, gth[5])
    H, W = z.shape
    ex, ey = pas_metriques(gt, H)
    pente = pente_pct(lisser(z), ex, ey)
    dedans = masque_commune(geom, gt, z.shape)

    # ---------- Grille pour le navigateur ----------
    alt_dm = np.clip(np.round(z * 10), 0, 65535).astype("<u2")
    pente_b = np.clip(np.round(pente * 2), 0, 254).astype(np.uint8)     # 0,5 % ; 254 = ≥ 127 %
    hand_b = np.clip(np.round(hd * 10), 0, 254).astype(np.uint8)        # 0,1 m ; 254 = ≥ 25,4 m
    hand_b[~dedans] = 255                                               # 255 = hors commune
    with gzip.open(os.path.join(OUT, "relief.bin.gz"), "wb", compresslevel=9) as f:
        f.write(alt_dm.tobytes() + pente_b.tobytes() + hand_b.tobytes())

    # ---------- Images ----------
    rows, (lat_s, lat_n) = lignes_mercator(gt, H)
    hs = ombrage(z, ex, ey)
    ombre = np.zeros((H, W, 4), dtype=np.uint8)
    ombre[..., 3] = np.where(dedans, np.clip((0.75 - hs) * 255 * 1.2, 0, 200), 0).astype(np.uint8)
    lum = np.where(dedans, np.clip((hs - 0.75) * 255 * 2.5, 0, 90), 0).astype(np.uint8)   # versants éclairés
    clair = lum > ombre[..., 3]
    ombre[clair] = np.stack([np.full_like(lum, 255)] * 3 + [lum], -1)[clair]
    png("ombrage.png", ombre, rows)

    cl_pente = np.digitize(pente, CLASSES_PENTE)          # 0 faible … 3 très forte
    png("pentes.png", couleurs(cl_pente, {1: (255, 212, 59, 120), 2: (247, 103, 7, 170), 3: (201, 42, 42, 200)}, dedans), rows)
    cl_hand = np.digitize(hd, CLASSES_HAND)               # 0 fort, 1 moyen, 2 faible
    png("inondation.png", couleurs(cl_hand, {0: (24, 100, 171, 175), 1: (116, 192, 252, 140)}, dedans), rows)

    # ---------- Zones inondables vectorisées ----------
    zones = np.where(dedans, np.where(cl_hand == 0, 1, np.where(cl_hand == 1, 2, 0)), 0).astype(np.uint8)
    srs = osr.SpatialReference(); srs.ImportFromEPSG(4326)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    mem = gdal.GetDriverByName("MEM").Create("", W, H, 1, gdal.GDT_Byte)
    mem.SetGeoTransform((gt[0] - gt[1] / 2, gt[1], 0, gt[3] - gt[5] / 2, 0, gt[5]))   # bords de pixels
    mem.SetProjection(srs.ExportToWkt())
    mem.GetRasterBand(1).WriteArray(zones)
    mem.GetRasterBand(1).SetNoDataValue(0)
    tmp = "/tmp/zones_brutes.geojson"
    vds = ogr.GetDriverByName("GeoJSON").CreateDataSource(tmp)
    lyr = vds.CreateLayer("zones", srs, ogr.wkbPolygon)
    lyr.CreateField(ogr.FieldDefn("classe", ogr.OFTInteger))
    gdal.Polygonize(mem.GetRasterBand(1), mem.GetRasterBand(1), lyr, 0)
    vds = None
    dst = os.path.join(OUT, "zones_inondables.geojson")
    if os.path.exists(dst):
        os.remove(dst)
    subprocess.run(["ogr2ogr", "-f", "GeoJSON", dst, tmp, "-dialect", "SQLite", "-sql",
                    "SELECT CASE classe WHEN 1 THEN 'Fort' ELSE 'Moyen' END AS alea, "
                    "CASE classe WHEN 1 THEN 'moins de %g m au-dessus du drainage' ELSE 'de %g à %g m au-dessus du drainage' END AS critere, "
                    "ROUND(ST_Area(ST_Union(geometry), 1) / 10000.0, 2) AS surface_ha, "
                    "ST_SimplifyPreserveTopology(ST_Union(geometry), 0.00004) AS geometry "
                    "FROM zones GROUP BY classe" % (CLASSES_HAND[0], CLASSES_HAND[0], CLASSES_HAND[1]),
                    "-lco", "COORDINATE_PRECISION=6", "-nln", "zones_inondables"], check=True)

    # ---------- Métadonnées et statistiques ----------
    zc, pc, hc = z[dedans], pente[dedans], hd[dedans]
    cell_km2 = ex * ey / 1e6
    meta = {
        "source": "Copernicus GLO-30 DEM (© DLR e.V. 2010-2014 et © Airbus Defence and Space GmbH 2014-2018, fourni dans le cadre du programme Copernicus)",
        "methode": "Pentes : opérateur de Horn sur le MNT lissé 3×3. Zones inondables : hauteur au-dessus du drainage (HAND), "
                   "réseau de drainage = cellules drainant plus de %g km²." % SEUIL_DRAINAGE_KM2,
        "largeur": W, "hauteur": H,
        # centres de la première cellule (nord-ouest) et pas de la grille, en degrés
        "x0": gt[0], "y0": gt[3], "dx": gt[1], "dy": gt[5],
        "pas_m": [round(ex, 1), round(ey, 1)],
        "image_bounds": [[lat_s, gt[0] - gt[1] / 2], [lat_n, gt[0] + (W - 0.5) * gt[1]]],
        "bandes": [
            {"nom": "altitude", "type": "uint16", "echelle": 0.1, "unite": "m"},
            {"nom": "pente", "type": "uint8", "echelle": 0.5, "unite": "%", "max": 254},
            {"nom": "hand", "type": "uint8", "echelle": 0.1, "unite": "m", "max": 254, "hors_commune": 255}
        ],
        "classes_pente": CLASSES_PENTE, "classes_hand": CLASSES_HAND, "seuil_drainage_km2": SEUIL_DRAINAGE_KM2,
        "stats": {
            "altitude_min": round(float(zc.min()), 1), "altitude_max": round(float(zc.max()), 1),
            "altitude_moyenne": round(float(zc.mean()), 1),
            "pente_moyenne": round(float(pc.mean()), 1),
            "surface_km2": round(float(dedans.sum() * cell_km2), 2),
            "pentes_km2": [round(float(((cl_pente[dedans]) == k).sum() * cell_km2), 2) for k in range(4)],
            "hand_km2": [round(float(((cl_hand[dedans]) == k).sum() * cell_km2), 2) for k in range(3)],
        },
    }
    with open(os.path.join(OUT, "relief.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print(json.dumps(meta["stats"], ensure_ascii=False))

    # ---------- PostGIS (si la base est accessible) ----------
    if os.environ.get("POSTGRES_DB"):
        pg = "PG:host=db port=5432 dbname=%s user=%s password=%s" % (
            os.environ["POSTGRES_DB"], os.environ["POSTGRES_USER"], os.environ["POSTGRES_PASSWORD"])
        subprocess.run(["ogr2ogr", "-f", "PostgreSQL", pg, dst, "-nln", "ref.zones_inondables", "-overwrite",
                        "-nlt", "MULTIPOLYGON", "-lco", "GEOMETRY_NAME=geom", "-lco", "FID=gid"], check=True)
        print("Table ref.zones_inondables chargée")
    print("Terminé :", sorted(os.listdir(OUT)))


if __name__ == "__main__":
    main()
