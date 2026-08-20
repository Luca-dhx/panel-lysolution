// LIRE LA POSITION RÉELLE DES IMAGES D'UN PDF — juste assez pour mesurer.
//
// Campagne de migration Yousign → OpenSign, lots 1 et 5.
//
// ══ POURQUOI CE MODULE EXISTE À PART ════════════════════════════════════════
//
// Cette fonction vivait dans `signInBrowser.js`, qui est un SCRIPT : il ouvre
// une base, appelle le fournisseur, signe dans un navigateur et supprime des
// documents, le tout au chargement du module.
//
// L'importer depuis une autre recette pour réutiliser la mesure exécutait donc
// la recette entière — une signature réelle de plus, un crédit consommé, et un
// document créé puis supprimé sans que personne l'ait demandé. Le symptôme est
// discret : la recette appelante marche, elle est juste précédée d'une autre.
//
// Une fonction pure n'a rien à faire dans un script à effets. Elle est ici.
import zlib from 'node:zlib';

/**
 * Les images posées dans un PDF, avec leur position et leur taille RÉELLES.
 *
 * ══ POURQUOI IL FAUT COMPOSER LES MATRICES, ET NE PAS LIRE LA DERNIÈRE ══════
 *
 * Un PDF ne pose pas une image « à » des coordonnées : il pose une image
 * unitaire (1×1, coin en bas à gauche) et compose la matrice courante. OpenSign
 * en empile quatre :
 *
 *     1 0 0 1 45 707 cm     ← translation vers la zone
 *     1 0 0 1  0   0 cm     ← neutre
 *     150 0 0 45 0 0 cm     ← mise à l'échelle aux dimensions de la zone
 *     1 0 0 1  0   0 cm     ← neutre
 *     /Image-… Do
 *
 * Lire la matrice qui précède immédiatement le `Do` rendrait « x=0, y=0,
 * 1×1 » — c'est-à-dire rien. Il faut multiplier, dans l'ordre, en respectant la
 * pile `q`/`Q`. C'est le seul moyen d'obtenir la position que verra un lecteur.
 *
 * ⚠️ `yBas` est mesuré depuis le BAS de la page, comme le PDF les compte. Les
 * ratios de l'éditeur, eux, partent du HAUT : la conversion appartient à
 * l'appelant, qui seul connaît la hauteur de la page.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Array<{nom: string, largeur: number, hauteur: number, x: number, yBas: number}>}
 */
export function imagesPositionnees(pdfBuffer) {
  const brut = pdfBuffer.toString('latin1');
  const trouvailles = [];

  /** [a b c d e f] — composition PDF : M_nouvelle × M_courante. */
  const composer = (m, n) => [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];

  const motif = /stream\r?\n?([\s\S]*?)endstream/g;
  let m;
  while ((m = motif.exec(brut)) !== null) {
    const entete = brut.slice(Math.max(0, m.index - 500), m.index);
    let contenu = m[1];
    if (/FlateDecode/.test(entete)) {
      try { contenu = zlib.inflateSync(Buffer.from(contenu, 'latin1')).toString('latin1'); } catch { continue; }
    }
    if (!/\bDo\b/.test(contenu)) continue;

    let courante = [1, 0, 0, 1, 0, 0];
    const pile = [];
    for (const jeton of contenu.split(/[\r\n]+/)) {
      const ligne = jeton.trim();
      if (ligne === 'q') { pile.push([...courante]); continue; }
      if (ligne === 'Q') { courante = pile.pop() ?? [1, 0, 0, 1, 0, 0]; continue; }
      const cm = ligne.match(/^([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+cm$/);
      if (cm) { courante = composer(cm.slice(1).map(Number), courante); continue; }
      const doOp = ligne.match(/^\/([A-Za-z0-9_-]+)\s+Do$/);
      if (doOp) {
        trouvailles.push({
          nom: doOp[1],
          // L'unité de l'image est [0,1]² : la matrice porte donc directement
          // sa taille en `a` et `d`, et son coin bas-gauche en `e`/`f`.
          largeur: +courante[0].toFixed(3),
          hauteur: +courante[3].toFixed(3),
          x: +courante[4].toFixed(3),
          yBas: +courante[5].toFixed(3),
        });
      }
    }
  }
  return trouvailles;
}

export default { imagesPositionnees };
