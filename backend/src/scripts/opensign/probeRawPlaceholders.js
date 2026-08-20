// SONDE — CE QU'OPENSIGN STOCKE VRAIMENT DERRIÈRE NOS COORDONNÉES.
//
// Campagne de migration Yousign → OpenSign, lot 1, point 9 (porte dure).
//
//   node src/scripts/opensign/probeRawPlaceholders.js [--keep]
//
// ══ POURQUOI CETTE SONDE EXISTE ═════════════════════════════════════════════
//
// `GET /document/{id}` de l'API v1.2 rend nos propres x/y/w/h inchangés : c'est
// un ÉCHO, et un écho ne prouve aucune position. Le placement réel est calculé
// par le client d'OpenSign au moment du rendu, selon (code source du
// fournisseur, `getWidgetPosition`) :
//
//     pageRatio = pageWidth / vpWidth        (vpWidth ← pageWidth s'il est absent)
//     x_pdf     = x * pageRatio
//     y_pdf     = pageHeight - (y * pageRatio + hauteur)
//
// Tout tient donc à UN champ que l'API ne montre pas : `vpWidth`. S'il est
// absent, le rapport vaut 1 et nos coordonnées sont des POINTS PDF. S'il porte
// la largeur d'un aperçu, elles sont des pixels d'aperçu — et une signature
// posée en bas de page manquerait sa ligne de plusieurs centimètres, sans
// qu'aucune erreur ne soit levée.
//
// ══ COMMENT ON VA LE VOIR ═══════════════════════════════════════════════════
//
// OpenSign est un Parse Server. Le lien de signature qu'il rend
// (`/login/<base64url>`) encode `docId/email/contactBookId/sendmail` — c'est son
// propre client qui le décode, puis appelle `getDocument` pour afficher le
// document au signataire invité. Cette lecture est ANONYME : le parcours invité
// n'a pas de session tant que l'OTP est désactivé.
//
// On emprunte exactement ce chemin, en LECTURE SEULE, sur un document de
// recette que nous venons de créer. Ce n'est pas un contournement : c'est la
// surface que le fournisseur ouvre à tout porteur du lien, et elle rend
// l'enregistrement BRUT — `Placeholders` compris, `vpWidth` compris.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { connectDatabase, disconnectDatabase } from '../../config/db.js';
import { openSignFetch } from '../../services/integratedApi/opensign/openSignTransport.js';
import { loadOpenSignSandboxCredentials } from './campaignCredentials.js';
import { buildFixturePdf, PAGE_SIZES } from './fixturePdf.js';

const GARDER = process.argv.includes('--keep');
const journal = (...a) => console.log(...a);
const appel = (credentials, method, chemin, json) =>
  openSignFetch({ credentials, method, path: chemin, json, timeoutMs: 90_000 });

/** Parse REST — l'identifiant d'application du client OpenSign est public. */
const PARSE_APP_ID = 'opensign';

async function parseCloud(origine, fonction, sessionToken, params) {
  const reponse = await fetch(`${origine}/api/app/functions/${fonction}`, {
    method: 'POST',
    headers: {
      'X-Parse-Application-Id': PARSE_APP_ID,
      ...(sessionToken ? { 'X-Parse-Session-Token': sessionToken } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params ?? {}),
  });
  const texte = await reponse.text();
  let corps;
  try { corps = JSON.parse(texte); } catch { corps = { raw: texte.slice(0, 400) }; }
  return { status: reponse.status, corps };
}

await connectDatabase();
const { credentials } = await loadOpenSignSandboxCredentials();

const TAILLE = PAGE_SIZES.A4_PORTRAIT;
const rapport = { startedAt: new Date().toISOString(), page: TAILLE };
const aNettoyer = [];

try {
  journal('\n=== SONDE — PLACEHOLDERS BRUTS ===\n');

  /**
   * DES COORDONNÉES CHOISIES POUR ÊTRE DISCRIMINANTES.
   *
   * `x=460` sur une page de 595 pt : sous l'hypothèse « points », le widget est
   * à 6,5 cm du bord droit ; sous l'hypothèse « aperçu 757 px », il serait à
   * 362 pt, soit 8 cm plus à gauche. Aucun arrondi ne produit cet écart.
   */
  const widgets = [
    { nom: 'HG', x: 40, y: 40, w: 120, h: 40 },
    { nom: 'HD', x: 435, y: 40, w: 120, h: 40 },
    { nom: 'BG', x: 40, y: 762, w: 120, h: 40 },
  ];

  const pdf = buildFixturePdf({
    size: TAILLE,
    title: 'SONDE PLACEHOLDERS',
    landmarksByPage: [widgets.map((w) => ({
      xFromLeft: w.x, yFromTop: w.y, width: w.w, height: w.h, label: w.nom,
    }))],
  });

  const cree = await appel(credentials, 'POST', '/createdocument', {
    file: pdf.toString('base64'),
    title: 'RECETTE OPENSIGN — sonde placeholders',
    send_email: false,
    signers: [{
      role: 'DEVELOPER', email: 'dev.recette@example.com', name: 'Recette Developpeur',
      signer_role: 'signer',
      widgets: widgets.map((w) => ({
        type: 'signature', page: 1, x: w.x, y: w.y, w: w.w, h: w.h,
        options: { hint: w.nom },
      })),
    }],
  });

  const objectId = cree?.objectId;
  aNettoyer.push(objectId);
  journal(`document ${objectId}`);

  const lien = cree?.signurl?.[0]?.url ?? null;
  journal(`lien de signature : ${lien ? lien.replace(/[^/]+$/, '<jeton>') : '(aucun)'}`);
  if (!lien) throw new Error('Aucun lien de signature rendu.');

  const url = new URL(lien);
  const encode = url.pathname.split('/').filter(Boolean).pop();
  const origine = url.origin;
  rapport.lien = { origine, chemin: url.pathname.replace(/[^/]+$/, '<jeton>') };

  /**
   * LE LIEN N'EST PAS UN JETON, C'EST UNE ADRESSE ENCODÉE.
   *
   * `atob(base64url)` rend « docId/email/contactBookId/sendmail ». On ne
   * conserve que le docId — l'adresse du signataire de recette est déjà connue,
   * et rien d'autre n'a de raison d'entrer dans un artefact.
   */
  const decode = Buffer.from(encode, 'base64').toString('utf8').split('/');
  journal(`lien décodé → docId=${decode[0]} contactBookId=${decode[2] ?? '(absent)'} sendmail=${decode[3] ?? '(absent)'}`);
  rapport.lienDecode = { docIdCorrespond: decode[0] === objectId, aContactBookId: Boolean(decode[2]) };

  journal('\n— appel de la fonction que le client du fournisseur utilise lui-même (parcours invité, sans session) —');
  const doc = await parseCloud(origine, 'getDocument', null, { docId: decode[0] || objectId });
  journal(`getDocument → HTTP ${doc.status}`);

  const resultat = doc.corps?.result ?? doc.corps;
  rapport.parseStatus = doc.status;

  if (doc.status !== 200) {
    journal(`corps : ${JSON.stringify(doc.corps).slice(0, 500)}`);
    rapport.echec = doc.corps;
  } else {
    const placeholders = resultat?.Placeholders ?? [];
    journal(`\nchamps du document brut : ${Object.keys(resultat ?? {}).join(', ')}`);
    journal(`Placeholders : ${placeholders.length}`);

    const positions = [];
    for (const p of placeholders) {
      for (const page of p?.placeHolder ?? []) {
        for (const pos of page?.pos ?? []) {
          positions.push({ role: p.Role ?? null, pageNumber: page.pageNumber, ...pos });
        }
      }
    }
    rapport.placeholdersBruts = placeholders;
    rapport.positions = positions;

    journal('\n══ CE QUE LE FOURNISSEUR A STOCKÉ ══');
    for (const pos of positions) {
      journal(`  ${JSON.stringify(pos)}`);
    }

    const avecVpWidth = positions.filter((p) => p.vpWidth !== undefined && p.vpWidth !== null);
    journal('\n══ VERDICT ══');
    if (positions.length === 0) {
      journal('  aucune position lisible — la sonde n’a pas abouti.');
    } else if (avecVpWidth.length === 0) {
      journal('  `vpWidth` ABSENT de toutes les positions.');
      journal('  → pageRatio = pageWidth / pageWidth = 1');
      journal('  → LES COORDONNÉES DE L’API SONT DES POINTS PDF, origine coin SUPÉRIEUR gauche.');
      rapport.verdict = { unite: 'POINTS_PDF', origine: 'HAUT_GAUCHE', vpWidthPresent: false };
    } else {
      const valeurs = [...new Set(avecVpWidth.map((p) => p.vpWidth))];
      journal(`  \`vpWidth\` PRÉSENT : ${JSON.stringify(valeurs)}`);
      journal(`  largeur de page : ${TAILLE.width} pt`);
      const ratioUn = valeurs.every((v) => Math.abs(v - TAILLE.width) < 0.5);
      journal(ratioUn
        ? '  → vpWidth == largeur de page : le rapport vaut 1, donc POINTS PDF.'
        : `  → vpWidth != largeur de page : les coordonnées sont mises à l’échelle par ${TAILLE.width}/vpWidth.`);
      rapport.verdict = {
        unite: ratioUn ? 'POINTS_PDF' : 'PIXELS_APERCU',
        origine: 'HAUT_GAUCHE',
        vpWidthPresent: true,
        vpWidth: valeurs,
        pageWidth: TAILLE.width,
      };
    }
  }
} catch (error) {
  journal(`\nÉCHEC : ${error?.httpStatus ?? ''} ${error?.providerError ?? error?.message}`);
  rapport.erreur = { message: error?.message ?? String(error), httpStatus: error?.httpStatus ?? null };
} finally {
  if (!GARDER) {
    for (const id of aNettoyer.filter(Boolean)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await appel(credentials, 'DELETE', `/document/${id}`);
        journal(`\nnettoyé : ${id}`);
      } catch (e) { journal(`\nNON nettoyé : ${id} — ${e?.providerError ?? e?.message}`); }
    }
  } else journal(`\n--keep : ${aNettoyer.join(', ')}`);

  const dossier = path.resolve(process.cwd(), '../.campaign');
  mkdirSync(dossier, { recursive: true });
  writeFileSync(path.join(dossier, 'opensign-placeholders.json'), JSON.stringify(rapport, null, 1), 'utf8');
  journal(`\nartefact : ${path.join(dossier, 'opensign-placeholders.json')}`);
  await disconnectDatabase();
}
