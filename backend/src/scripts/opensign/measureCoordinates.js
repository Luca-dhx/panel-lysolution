// MESURE DES COORDONNÉES OPENSIGN — la porte dure du lot 1.
//
// Campagne de migration Yousign → OpenSign, lot 1, point 9.
//
//   node src/scripts/opensign/measureCoordinates.js [--keep]
//
// ══ LA QUESTION, ET POURQUOI ELLE NE SE DEVINE PAS ══════════════════════════
//
// La documentation d'OpenSign dit « x, y : coin supérieur gauche » et renvoie à
// son « Debug UI » pour obtenir les valeurs. Elle ne dit JAMAIS dans quelle
// unité. Deux lectures tiennent :
//
//   POINTS PDF      les coordonnées sont celles du document lui-même ;
//   PIXELS DE RENDU les coordonnées sont celles d'un aperçu de largeur fixe,
//                   remises à l'échelle de la page au moment du rendu.
//
// L'écart entre les deux n'est PAS un décalage constant : il est proportionnel
// à la distance à l'origine. Une signature posée en haut à gauche paraîtrait
// juste, et la même signature en bas de page manquerait sa ligne de plusieurs
// centimètres. C'est exactement le mode de défaillance qu'on ne voit pas en
// recette et qu'un client voit sur son contrat.
//
// ══ POURQUOI CE PROTOCOLE PLUTÔT QU'UN NAVIGATEUR ══════════════════════════
//
// Prouver la position exige de voir le RENDU, pas l'écho de nos propres
// paramètres — `GET /document` renvoie nos x/y inchangés, ce qui ne prouve
// rien. La voie évidente serait de signer dans un navigateur et de mesurer le
// PDF signé ; elle imposerait Playwright et ses navigateurs au Panel, pour une
// mesure ponctuelle.
//
// Il existe un levier plus direct : les widgets `prefill`. OpenSign les
// INCRUSTE lui-même dans le document avant tout envoi — c'est leur définition.
// Le PDF stocké porte donc le rendu du fournisseur, aux coordonnées qu'il a
// calculées. Il suffit de le relire et de mesurer.
//
// On envoie des repères à des positions connues, on télécharge le document, et
// on regarde où le texte a réellement été posé. Le PDF est notre propre mire :
// ses dimensions sont connues au point près.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { connectDatabase, disconnectDatabase } from '../../config/db.js';
import { openSignFetch } from '../../services/integratedApi/opensign/openSignTransport.js';
import { loadOpenSignSandboxCredentials } from './campaignCredentials.js';
import { buildFixturePdf, PAGE_SIZES } from './fixturePdf.js';

const GARDER = process.argv.includes('--keep');
const journal = (...a) => console.log(...a);

const appel = (credentials, method, chemin, json) =>
  openSignFetch({ credentials, method, path: chemin, json, timeoutMs: 90_000 });

/* -------------------------------------------------------------------------- */
/*  LECTURE D'UN PDF — juste assez pour mesurer, pas une bibliothèque          */
/* -------------------------------------------------------------------------- */

/**
 * Décompresse les flux de contenu et rend les opérateurs de texte positionnés.
 *
 * On ne prétend pas analyser le PDF : on cherche les matrices `Tm` et les
 * `Td`/`TD` qui précèdent un `Tj`/`TJ`, ce qui suffit à localiser une chaîne.
 * Un analyseur complet serait une bibliothèque ; ici, c'est un pied à coulisse.
 */
function extractPositionedText(pdfBuffer) {
  const brut = pdfBuffer.toString('latin1');
  const flux = [];

  // Les flux, compressés ou non. `stream\r?\n … endstream`.
  const motif = /stream\r?\n?([\s\S]*?)endstream/g;
  let m;
  while ((m = motif.exec(brut)) !== null) {
    const contenu = m[1];
    const entete = brut.slice(Math.max(0, m.index - 400), m.index);
    let texte = contenu;
    if (/FlateDecode/.test(entete)) {
      try {
        texte = zlib.inflateSync(Buffer.from(contenu, 'latin1')).toString('latin1');
      } catch {
        continue; // flux binaire (image, police) : rien à mesurer
      }
    }
    if (/\bTj\b|\bTJ\b/.test(texte)) flux.push(texte);
  }

  const trouvailles = [];
  for (const contenu of flux) {
    // On suit l'état minimal : dernière matrice de texte vue.
    let dernierTm = null;
    const lignes = contenu.split(/[\r\n]+/);
    for (const ligne of lignes) {
      const tm = ligne.match(/([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm/);
      if (tm) dernierTm = { x: parseFloat(tm[5]), y: parseFloat(tm[6]) };
      const td = ligne.match(/([-\d.]+)\s+([-\d.]+)\s+T[dD]\b/);
      if (td && !tm) dernierTm = { x: parseFloat(td[1]), y: parseFloat(td[2]) };
      const tj = ligne.match(/\((.*?)\)\s*Tj/);
      if (tj && dernierTm) {
        trouvailles.push({ texte: tj[1], x: dernierTm.x, y: dernierTm.y });
      }
    }
  }
  return trouvailles;
}

/** Les images posées, avec leur matrice — une signature est une image. */
function extractPositionedImages(pdfBuffer) {
  const brut = pdfBuffer.toString('latin1');
  const flux = [];
  const motif = /stream\r?\n?([\s\S]*?)endstream/g;
  let m;
  while ((m = motif.exec(brut)) !== null) {
    const entete = brut.slice(Math.max(0, m.index - 400), m.index);
    let texte = m[1];
    if (/FlateDecode/.test(entete)) {
      try { texte = zlib.inflateSync(Buffer.from(texte, 'latin1')).toString('latin1'); } catch { continue; }
    }
    if (/\bDo\b/.test(texte)) flux.push(texte);
  }
  const trouvailles = [];
  for (const contenu of flux) {
    const motifCm = /([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+cm[\s\S]{0,120}?\/(\w+)\s+Do/g;
    let c;
    while ((c = motifCm.exec(contenu)) !== null) {
      trouvailles.push({
        nom: c[7],
        width: parseFloat(c[1]), height: parseFloat(c[4]),
        x: parseFloat(c[5]), y: parseFloat(c[6]),
      });
    }
  }
  return trouvailles;
}

/* -------------------------------------------------------------------------- */

await connectDatabase();
const { credentials } = await loadOpenSignSandboxCredentials();

const rapport = { startedAt: new Date().toISOString(), mesures: [] };
const aNettoyer = [];

/**
 * LES POINTS DE MESURE.
 *
 * Choisis pour que les deux hypothèses divergent le PLUS possible. Sur une A4
 * portrait (595 x 842 pt) et un aperçu large de 757 px, le facteur serait
 * 595/757 = 0,786 : un repère à x=520 atterrirait à 409 pt. Un demi-centimètre
 * d'écart passerait inaperçu ; huit centimètres, non.
 *
 * On place donc les repères LOIN de l'origine — c'est là que les hypothèses se
 * séparent — et un témoin près de l'origine, où elles se confondent : s'il est
 * juste et que les autres ne le sont pas, la mesure désigne une ÉCHELLE et non
 * un décalage.
 */
const TAILLE = PAGE_SIZES.A4_PORTRAIT;
const POINTS = [
  { nom: 'TEMOIN_ORIGINE', x: 40, y: 40, w: 90, h: 24, texte: 'AA' },
  { nom: 'DROITE_HAUT', x: 460, y: 60, w: 90, h: 24, texte: 'BB' },
  { nom: 'GAUCHE_BAS', x: 40, y: 740, w: 90, h: 24, texte: 'CC' },
  { nom: 'DROITE_BAS', x: 460, y: 740, w: 90, h: 24, texte: 'DD' },
];

try {
  journal('\n=== MESURE DES COORDONNÉES — widgets prefill incrustés par OpenSign ===\n');
  journal(`page de mire : ${TAILLE.label} — ${TAILLE.width} x ${TAILLE.height} pt`);

  const pdf = buildFixturePdf({
    size: TAILLE,
    title: 'MESURE COORDONNEES OPENSIGN',
    landmarksByPage: [POINTS.map((p) => ({
      xFromLeft: p.x, yFromTop: p.y, width: p.w, height: p.h, label: p.nom,
    }))],
  });

  const reponse = await appel(credentials, 'POST', '/createdocument', {
    file: pdf.toString('base64'),
    title: 'RECETTE OPENSIGN — mesure des coordonnées',
    send_email: false,
    signers: [{
      role: 'DEVELOPER', email: 'dev.recette@example.com', name: 'Recette Developpeur',
      signer_role: 'signer',
      widgets: [{ type: 'signature', page: 1, x: 240, y: 400, w: 120, h: 40 }],
    }],
    /**
     * LES REPÈRES SONT DES `prefill` : c'est OpenSign qui les dessine.
     * Un widget de signataire ne serait dessiné qu'après signature ; un prefill
     * l'est avant l'envoi, ce qui rend la mesure possible sans navigateur.
     */
    prefill: {
      widgets: POINTS.map((p) => ({
        type: 'textbox', page: 1, x: p.x, y: p.y, w: p.w, h: p.h,
        options: { name: p.nom, response: p.texte, color: 'blue', fontsize: 18 },
      })),
    },
  });

  const objectId = reponse?.objectId;
  if (objectId) aNettoyer.push(objectId);
  journal(`document ${objectId} — ${reponse?.message ?? ''}`);

  const doc = await appel(credentials, 'GET', `/document/${objectId}`);
  journal(`fichier disponible : ${Boolean(doc?.file)}`);

  const fichier = await fetch(doc.file);
  const octets = Buffer.from(await fichier.arrayBuffer());
  journal(`PDF stocké : ${octets.length} octets (envoyé : ${pdf.length})`);
  journal(`le fournisseur a-t-il RÉÉCRIT le document ? ${octets.length !== pdf.length ? 'OUI' : 'non'}`);

  const dossier = path.resolve(process.cwd(), '../.campaign');
  mkdirSync(dossier, { recursive: true });
  writeFileSync(path.join(dossier, 'coordonnees-rendu.pdf'), octets);

  const textes = extractPositionedText(octets);
  const images = extractPositionedImages(octets);

  journal(`\ntextes positionnés trouvés : ${textes.length}`);
  journal(`images positionnées trouvées : ${images.length}`);

  /**
   * L'INTERPRÉTATION.
   *
   * PDF mesure depuis le BAS. Nos repères sont cotés depuis le HAUT. Pour
   * chaque repère, on calcule où le texte DEVRAIT tomber sous chaque
   * hypothèse, et on compare à la mesure.
   */
  const mesures = [];
  for (const p of POINTS) {
    const trouve = textes.filter((t) => t.texte.trim() === p.texte);
    const attenduPoints = { x: p.x, yBas: TAILLE.height - p.y - p.h };
    const facteurApercu = TAILLE.width / 757;
    const attenduApercu = {
      x: p.x * facteurApercu,
      yBas: TAILLE.height - (p.y + p.h) * facteurApercu,
    };
    mesures.push({
      repere: p.nom,
      envoye: { x: p.x, yDepuisHaut: p.y, w: p.w, h: p.h },
      attenduSiPoints: attenduPoints,
      attenduSiApercu757: attenduApercu,
      mesure: trouve.map((t) => ({ x: t.x, y: t.y })),
    });
    journal(`\n  ${p.nom} (envoyé x=${p.x} y_haut=${p.y})`);
    journal(`     si POINTS  → x≈${attenduPoints.x} y_bas≈${attenduPoints.yBas.toFixed(1)}`);
    journal(`     si APERÇU  → x≈${attenduApercu.x.toFixed(1)} y_bas≈${attenduApercu.yBas.toFixed(1)}`);
    journal(`     MESURÉ     → ${trouve.length ? trouve.map((t) => `x=${t.x} y=${t.y}`).join(' | ') : '(texte non retrouvé)'}`);
  }

  rapport.mesures = mesures;
  rapport.textesBruts = textes.slice(0, 60);
  rapport.imagesBrutes = images.slice(0, 30);
  rapport.pdfEnvoyeOctets = pdf.length;
  rapport.pdfStockeOctets = octets.length;
  rapport.page = TAILLE;
} catch (error) {
  journal(`\nÉCHEC : ${error?.httpStatus ?? ''} ${error?.providerError ?? error?.message}`);
  rapport.erreur = {
    code: error?.code ?? null, httpStatus: error?.httpStatus ?? null,
    providerError: error?.providerError ?? null, message: error?.message ?? String(error),
  };
} finally {
  if (!GARDER) {
    for (const id of aNettoyer) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await appel(credentials, 'DELETE', `/document/${id}`);
        journal(`\nnettoyé : ${id}`);
      } catch (e) { journal(`\nNON nettoyé : ${id} — ${e?.providerError ?? e?.message}`); }
    }
  } else {
    journal(`\n--keep : documents conservés (${aNettoyer.join(', ')})`);
  }

  const dossier = path.resolve(process.cwd(), '../.campaign');
  mkdirSync(dossier, { recursive: true });
  writeFileSync(path.join(dossier, 'opensign-coordinates.json'), JSON.stringify(rapport, null, 1), 'utf8');
  journal(`\nartefact : ${path.join(dossier, 'opensign-coordinates.json')}`);
  await disconnectDatabase();
}
