// PDF DE RECETTE — généré, mesurable, et sans aucune donnée réelle.
//
// Campagne de migration Yousign → OpenSign.
//
// ══ POURQUOI UN GÉNÉRATEUR PLUTÔT QU'UN FICHIER D'EXEMPLE ═══════════════════
//
// Deux raisons, et la seconde est la plus importante :
//
//  1. Le bac à sable OpenSign est un environnement de TEST. Y téléverser un
//     contrat réel — même « juste pour voir » — y déposerait des identités et
//     des montants de clients dans un système dont la documentation dit
//     explicitement de ne pas lui confier de données confidentielles.
//
//  2. Prouver la sémantique des coordonnées EXIGE un document dont on connaît
//     les dimensions au point près, et qui porte des repères VISIBLES à des
//     positions calculées. Un PDF trouvé quelque part ne dit ni l'un ni
//     l'autre : on ne pourrait que constater qu'un widget « a l'air bien
//     placé », ce qui n'est pas une mesure.
//
// ══ POURQUOI PAS `pdf-lib` ══════════════════════════════════════════════════
//
// Ajouter une dépendance au backend du Panel pour fabriquer une mire de recette
// serait payer, en surface de production, un besoin d'outillage. Un PDF 1.4
// non compressé tient en une centaine de lignes et n'a aucune dépendance — et
// c'est justement un format qu'on veut pouvoir relire à l'œil quand une mesure
// surprend.
//
// ══ LE SYSTÈME DE COORDONNÉES ══════════════════════════════════════════════
//
// PDF mesure depuis le coin INFÉRIEUR gauche, en points (1/72 pouce).
// L'éditeur de SB Auto, lui, raisonne depuis le coin SUPÉRIEUR gauche.
// Ce module accepte les deux et fait la conversion explicitement — parce que
// c'est exactement l'endroit où une confusion se paie par une signature posée
// au mauvais bout de la page.

/** Formats usuels, en POINTS PDF. Ce sont des faits, pas des préférences. */
export const PAGE_SIZES = Object.freeze({
  A4_PORTRAIT: Object.freeze({ width: 595, height: 842, label: 'A4 portrait' }),
  A4_LANDSCAPE: Object.freeze({ width: 842, height: 595, label: 'A4 paysage' }),
  LETTER_PORTRAIT: Object.freeze({ width: 612, height: 792, label: 'Letter portrait' }),
});

const escapeText = (text) => String(text).replace(/([\\()])/g, '\\$1');

/**
 * Un repère : un rectangle vide, sa diagonale, et une étiquette.
 *
 * Il est décrit en coordonnées « depuis le HAUT », comme les zones de
 * l'éditeur — pour qu'une mire et une zone se lisent dans le même repère et
 * qu'aucune conversion mentale ne s'intercale entre les deux.
 */
function landmarkOperators({ xFromLeft, yFromTop, width, height, label }, pageHeight) {
  // PDF dessine depuis le BAS : c'est ici, et uniquement ici, que le monde
  // bascule.
  const yBottom = pageHeight - yFromTop - height;
  const parts = [
    'q',
    '0.85 0.10 0.10 RG', '1.2 w',
    `${xFromLeft} ${yBottom} ${width} ${height} re S`,
    // Les diagonales donnent un CENTRE visible à l'œil comme à la mesure.
    `${xFromLeft} ${yBottom} m ${xFromLeft + width} ${yBottom + height} l S`,
    `${xFromLeft} ${yBottom + height} m ${xFromLeft + width} ${yBottom} l S`,
    'Q',
  ];
  if (label) {
    parts.push(
      'BT', '/F1 7 Tf', '0.85 0.10 0.10 rg',
      `1 0 0 1 ${xFromLeft} ${yBottom + height + 3} Tm`,
      `(${escapeText(label)}) Tj`, 'ET',
    );
  }
  return parts.join('\n');
}

/** Le cadre de page et sa règle graduée — la référence absolue de la mesure. */
function pageFrameOperators({ width, height, title, pageNumber, pageCount }) {
  const parts = [
    'q', '0.20 0.20 0.20 RG', '0.75 w',
    `0.5 0.5 ${width - 1} ${height - 1} re S`, 'Q',
    'BT', '/F1 11 Tf', '0 0 0 rg',
    `1 0 0 1 24 ${height - 30} Tm`, `(${escapeText(title)}) Tj`, 'ET',
    'BT', '/F1 8 Tf', '0.35 0.35 0.35 rg',
    `1 0 0 1 24 ${height - 44} Tm`,
    `(MediaBox ${width} x ${height} pt  -  page ${pageNumber}/${pageCount}  -  repere: coin SUPERIEUR gauche) Tj`, 'ET',
  ];
  /**
   * UNE GRADUATION TOUS LES 100 POINTS, sur les deux bords, cotée DEPUIS LE
   * HAUT pour l'axe vertical.
   *
   * C'est ce qui permet de lire une position sur une capture d'écran sans
   * rouvrir le fichier : si un widget atterrit à côté de la graduation « 300 »,
   * la mesure est faite, et elle est faite dans le repère où les zones sont
   * stockées.
   */
  for (let x = 100; x < width; x += 100) {
    parts.push('q', '0.55 0.55 0.55 RG', '0.5 w', `${x} 0 m ${x} 12 l S`, 'Q');
    parts.push('BT', '/F1 6 Tf', '0.45 0.45 0.45 rg', `1 0 0 1 ${x + 2} 4 Tm`, `(x=${x}) Tj`, 'ET');
  }
  for (let yTop = 100; yTop < height; yTop += 100) {
    const y = height - yTop;
    parts.push('q', '0.55 0.55 0.55 RG', '0.5 w', `0 ${y} m 12 ${y} l S`, 'Q');
    parts.push('BT', '/F1 6 Tf', '0.45 0.45 0.45 rg', `1 0 0 1 14 ${y - 2} Tm`, `(y=${yTop}) Tj`, 'ET');
  }
  return parts.join('\n');
}

/**
 * Fabrique un PDF de mire.
 *
 * @param {object} args
 * @param {{width:number,height:number}} [args.size]
 * @param {Array<Array<object>>} [args.landmarksByPage] repères, page par page
 * @param {number} [args.pageCount]
 * @param {string} [args.title]
 * @param {number} [args.padBytes] octets de remplissage — pour éprouver une
 *   limite de taille SANS téléverser un document pour rien
 * @returns {Buffer}
 */
export function buildFixturePdf({
  size = PAGE_SIZES.A4_PORTRAIT,
  landmarksByPage = [],
  pageCount = Math.max(1, landmarksByPage.length),
  title = 'OPENSIGN RECETTE - MIRE DE MESURE',
  padBytes = 0,
} = {}) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };

  // 1 = catalogue, 2 = arbre de pages : réservés, remplis ensuite.
  objects.push(null, null);
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  const pageIds = [];
  for (let index = 0; index < pageCount; index += 1) {
    const landmarks = landmarksByPage[index] ?? [];
    const stream = [
      pageFrameOperators({ ...size, title, pageNumber: index + 1, pageCount }),
      ...landmarks.map((l) => landmarkOperators(l, size.height)),
    ].join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.width} ${size.height}] `
      + `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ));
  }

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  /**
   * LE REMPLISSAGE EST UN OBJET FLUX LÉGITIME, JAMAIS UN COMMENTAIRE GÉANT.
   *
   * Un PDF gonflé par des commentaires reste petit une fois normalisé par le
   * fournisseur : on mesurerait alors la limite d'un fichier qui n'existe plus
   * après son passage. Un flux référencé, lui, traverse.
   *
   * Le contenu est du texte compressible mais non trivial : ni zéros (qu'un
   * ré-encodage réduirait à rien), ni aléatoire (qui rendrait la fixture non
   * reproductible d'une exécution à l'autre).
   */
  if (padBytes > 0) {
    const motif = 'OPENSIGN-FIXTURE-PADDING-0123456789-';
    const remplissage = motif.repeat(Math.ceil(padBytes / motif.length)).slice(0, padBytes);
    add(`<< /Length ${remplissage.length} /Type /EmbeddedFile >>\nstream\n${remplissage}\nendstream`);
  }

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/**
 * LA MIRE DE MESURE DES COORDONNÉES — celle qui répond à la question du lot 1.
 *
 * Cinq repères choisis pour que chaque hypothèse fausse produise une erreur
 * VISIBLE et DISTINCTE, au lieu d'un décalage qu'on pourrait mettre sur le
 * compte d'un arrondi :
 *
 *   HAUT_GAUCHE   près de l'origine : une inversion d'axe l'envoie en bas
 *   HAUT_DROITE   asymétrique : un échange x/y le déplace franchement
 *   CENTRE        invariant par symétrie : il reste juste même si tout est faux,
 *                 et c'est justement pourquoi il ne sert PAS de preuve à lui seul
 *   BAS_GAUCHE    le témoin de l'origine verticale
 *   BAS_DROITE    le témoin des deux à la fois
 *
 * Une erreur d'échelle (points vs pixels d'un rendu) ne déplace pas les repères
 * proportionnellement de la même façon selon leur distance à l'origine : c'est
 * ce qui permet de la distinguer d'une simple translation.
 */
export function coordinateProbeLandmarks(size, { width = 120, height = 40 } = {}) {
  const marge = 40;
  return [
    { name: 'HAUT_GAUCHE', xFromLeft: marge, yFromTop: marge, width, height },
    { name: 'HAUT_DROITE', xFromLeft: size.width - marge - width, yFromTop: marge, width, height },
    { name: 'CENTRE', xFromLeft: Math.round((size.width - width) / 2), yFromTop: Math.round((size.height - height) / 2), width, height },
    { name: 'BAS_GAUCHE', xFromLeft: marge, yFromTop: size.height - marge - height, width, height },
    { name: 'BAS_DROITE', xFromLeft: size.width - marge - width, yFromTop: size.height - marge - height, width, height },
  ].map((l) => ({ ...l, label: l.name }));
}

export default { PAGE_SIZES, buildFixturePdf, coordinateProbeLandmarks };
