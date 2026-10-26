/* Configuration du site.
 * mode 'server' : données servies par GeoServer et l'API (Docker).
 * mode 'static' : données lues dans data/*.geojson (GitHub Pages) — remplacé automatiquement
 *                 par le déploiement GitHub (.github/workflows/pages.yml).
 * espaceUrl     : adresse de l'espace agents (vide = lien masqué). */
window.LABE_CONFIG = {
  mode: 'server',
  espaceUrl: 'espace.html'
};
