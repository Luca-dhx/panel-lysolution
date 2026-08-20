// SIGNER RÉELLEMENT, DANS UN VRAI NAVIGATEUR — la preuve visuelle du placement.
//
// Campagne de migration Yousign → OpenSign, lots 1 et 5.
//
//   node src/scripts/opensign/signInBrowser.js [--keep] [--headed] [--explore]
//
// ══ POURQUOI UN NAVIGATEUR ICI, ALORS QUE TOUT LE RESTE S'EN PASSE ══════════
//
// Parce que c'est le client d'OpenSign — et lui seul — qui transforme nos
// coordonnées en position sur la page. Le serveur ne calcule rien : sa fonction
// `signPdf` reçoit un `pdfFile` DÉJÀ aplati par le navigateur. Reproduire ce
// calcul nous-mêmes prouverait notre propre arithmétique, pas la sienne.
//
// « Le fournisseur a accepté la charge utile » n'est pas une preuve de
// placement. La seule preuve est le PDF signé, mesuré.
//
// ══ CE QUE CE SCRIPT MESURE ═════════════════════════════════════════════════
//
// Il pose des repères aux coordonnées demandées, fait signer pour de vrai, puis
// relit le PDF signé et compare la position de l'image de signature au repère
// visé. L'écart est rendu en points, et il doit être nul à l'arrondi près.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { connectDatabase, disconnectDatabase } from '../../config/db.js';
import { openSignFetch } from '../../services/integratedApi/opensign/openSignTransport.js';
import { loadOpenSignSandboxCredentials } from './campaignCredentials.js';
import { buildFixturePdf, PAGE_SIZES } from './fixturePdf.js';

const GARDER = process.argv.includes('--keep');
const VISIBLE = process.argv.includes('--headed');
const EXPLORER = process.argv.includes('--explore');

const journal = (...a) => console.log(...a);
const appel = (credentials, method, chemin, json) =>
  openSignFetch({ credentials, method, path: chemin, json, timeoutMs: 120_000 });

const DOSSIER = path.resolve(process.cwd(), '../.campaign');
mkdirSync(DOSSIER, { recursive: true });

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

await connectDatabase();
const { credentials } = await loadOpenSignSandboxCredentials();

const TAILLE = PAGE_SIZES.A4_PORTRAIT;
/**
 * TROIS CIBLES, LOIN LES UNES DES AUTRES.
 *
 * Une seule cible ne distingue pas une translation d'une mise à l'échelle. Trois,
 * réparties sur la hauteur ET la largeur, le font : une échelle fausse déplace
 * la cible basse beaucoup plus que la haute.
 */
const CIBLES = [
  { nom: 'HAUT_GAUCHE', x: 45, y: 90, w: 150, h: 45 },
  { nom: 'MILIEU_DROITE', x: 380, y: 400, w: 150, h: 45 },
  { nom: 'BAS_GAUCHE', x: 45, y: 700, w: 150, h: 45 },
];

const rapport = { startedAt: new Date().toISOString(), page: TAILLE, cibles: CIBLES };
const aNettoyer = [];
let navigateur = null;

try {
  journal('\n=== PREUVE VISUELLE — SIGNATURE RÉELLE DANS UN NAVIGATEUR ===\n');

  const pdf = buildFixturePdf({
    size: TAILLE,
    title: 'PREUVE DE PLACEMENT OPENSIGN',
    landmarksByPage: [CIBLES.map((c) => ({
      xFromLeft: c.x, yFromTop: c.y, width: c.w, height: c.h, label: c.nom,
    }))],
  });
  writeFileSync(path.join(DOSSIER, 'placement-mire.pdf'), pdf);

  const cree = await appel(credentials, 'POST', '/createdocument', {
    file: pdf.toString('base64'),
    title: 'RECETTE OPENSIGN — preuve de placement',
    send_email: false,
    /**
     * OTP DÉSACTIVÉ : le parcours invité doit rester accessible par le seul
     * lien. C'est déjà le réglage du parcours métier visé, et l'activer ici
     * mesurerait un autre parcours que celui qu'on va livrer.
     */
    enableOTP: false,
    enableTour: false,
    signers: [{
      role: 'DEVELOPER', email: 'dev.recette@example.com', name: 'Recette Developpeur',
      signer_role: 'signer',
      widgets: CIBLES.map((c) => ({
        type: 'signature', page: 1, x: c.x, y: c.y, w: c.w, h: c.h,
        options: { hint: c.nom },
      })),
    }],
  });

  const objectId = cree.objectId;
  aNettoyer.push(objectId);
  const lien = cree.signurl?.[0]?.url;
  journal(`document ${objectId}`);
  if (!lien) throw new Error('Aucun lien de signature.');

  const { chromium } = await import('playwright');
  navigateur = await chromium.launch({ headless: !VISIBLE });
  const contexte = await navigateur.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await contexte.newPage();

  const etapes = [];
  const capture = async (nom) => {
    const fichier = path.join(DOSSIER, `signature-${nom}.png`);
    await page.screenshot({ path: fichier, fullPage: false });
    const titres = await page.locator('button, a[role=button]').allTextContents().catch(() => []);
    etapes.push({ nom, url: page.url(), boutons: titres.map((t) => t.trim()).filter(Boolean).slice(0, 25) });
    journal(`   [${nom}] ${page.url()}`);
    journal(`        boutons: ${JSON.stringify(titres.map((t) => t.trim()).filter(Boolean).slice(0, 20))}`);
  };

  journal('\n— ouverture du lien de signature —');
  await page.goto(lien, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForTimeout(6000);
  await capture('01-arrivee');

  /* ── LE CONSENTEMENT — sans lui, rien ne s'affiche ────────────────────── */

  await page.getByRole('button', { name: /confirme|confirm|accept|agree/i })
    .first().click({ timeout: 15_000 }).catch(() => journal('   (pas d’écran de consentement)'));
  await page.waitForTimeout(4000);
  await capture('02-consentement');

  /* ══ MESURE DU RENDU — la preuve, prise dans le DOM du fournisseur ═════ */

  journal('\n══ MESURE DU RENDU DANS LE CLIENT D’OPENSIGN ══');

  const geometrie = await page.evaluate(() => {
    const conteneur = document.querySelector('[data-pdf-transform-target="true"]')
      ?? document.querySelector('.react-pdf__Document');
    const blocs = [...document.querySelectorAll('.signYourselfBlock')];
    const lire = (el) => {
      const style = el.getAttribute('style') ?? '';
      const t = /translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)/.exec(style);
      const w = /width:\s*([-\d.]+)px/.exec(style);
      const h = /height:\s*([-\d.]+)px/.exec(style);
      return {
        etiquette: (el.innerText ?? '').trim().split('\n')[0] ?? '',
        gauche: t ? parseFloat(t[1]) : null,
        haut: t ? parseFloat(t[2]) : null,
        largeur: w ? parseFloat(w[1]) : null,
        hauteur: h ? parseFloat(h[1]) : null,
      };
    };
    return {
      largeurConteneur: conteneur ? parseFloat(getComputedStyle(conteneur).width) : null,
      blocs: blocs.map(lire),
    };
  });

  /**
   * L'ARBITRAGE.
   *
   * Le client rend la page à une largeur qui lui appartient (elle dépend de la
   * fenêtre). Si les coordonnées stockées sont des POINTS, chaque widget est
   * rendu à `coordonnée × largeurRendue / largeurPageEnPoints`. Si ce sont des
   * pixels d'un aperçu de largeur fixe, le facteur observé serait différent —
   * et il ne coïnciderait pas avec le rapport des largeurs.
   *
   * On ne compare donc pas à une constante devinée : on compare le facteur
   * OBSERVÉ sur chaque widget au facteur que la page impose. S'ils coïncident
   * sur les trois cibles, l'unité est le point PDF, et rien d'autre ne peut
   * produire cette coïncidence.
   */
  const facteurAttendu = geometrie.largeurConteneur ? geometrie.largeurConteneur / TAILLE.width : null;
  journal(`   largeur de rendu : ${geometrie.largeurConteneur} px pour une page de ${TAILLE.width} pt`);
  journal(`   facteur imposé par la page : ${facteurAttendu?.toFixed(5)}`);

  const rendu = geometrie.blocs.map((b) => {
    const cible = CIBLES.find((c) => b.etiquette.includes(c.nom)) ?? null;
    if (!cible) return { ...b, cible: null };
    return {
      cible: cible.nom,
      envoye: { x: cible.x, y: cible.y, w: cible.w, h: cible.h },
      renduPx: { gauche: b.gauche, haut: b.haut, largeur: b.largeur, hauteur: b.hauteur },
      facteurObserve: {
        x: b.gauche != null ? +(b.gauche / cible.x).toFixed(5) : null,
        y: b.haut != null ? +(b.haut / cible.y).toFixed(5) : null,
        w: b.largeur != null ? +(b.largeur / cible.w).toFixed(5) : null,
        h: b.hauteur != null ? +(b.hauteur / cible.h).toFixed(5) : null,
      },
    };
  }).filter((r) => r.cible);

  for (const r of rendu) {
    journal(`   ${r.cible.padEnd(15)} envoyé (${r.envoye.x},${r.envoye.y},${r.envoye.w}x${r.envoye.h})`
      + `  rendu (${r.renduPx.gauche},${r.renduPx.haut},${r.renduPx.largeur}x${r.renduPx.hauteur})`
      + `  facteurs ${JSON.stringify(r.facteurObserve)}`);
  }

  const tolerance = 0.0005;
  const coherent = facteurAttendu != null && rendu.length === CIBLES.length && rendu.every((r) =>
    ['x', 'y', 'w', 'h'].every((axe) => r.facteurObserve[axe] != null
      && Math.abs(r.facteurObserve[axe] - facteurAttendu) < tolerance));

  rapport.rendu = { facteurAttendu, largeurConteneur: geometrie.largeurConteneur, widgets: rendu, coherent };
  journal(`\n   VERDICT RENDU : ${coherent
    ? 'les coordonnées de l’API sont des POINTS PDF, origine coin SUPÉRIEUR gauche'
    : 'INCOHÉRENT — les facteurs ne coïncident pas'}`);

  if (EXPLORER) {
    const texte = await page.locator('body').innerText().catch(() => '');
    writeFileSync(path.join(DOSSIER, 'signature-page.txt'), texte, 'utf8');
    writeFileSync(path.join(DOSSIER, 'signature-page.html'), await page.content(), 'utf8');
    journal('\n--explore : page.txt et page.html écrits. Arrêt avant de signer.');
    rapport.exploration = { etapes };
  } else {
    /**
     * LE PARCOURS RÉEL DU SIGNATAIRE.
     *
     * On ne cherche pas à être malin : on clique ce qu'un humain clique. Chaque
     * sélecteur est essayé puis abandonné sans lever — l'interface d'un
     * fournisseur change, et un script de mesure qui casse au premier libellé
     * modifié ne mesure plus rien du tout.
     */
    const essayer = async (description, action) => {
      try { await action(); journal(`   ✓ ${description}`); return true; }
      catch (e) { journal(`   – ${description} (${String(e.message).split('\n')[0].slice(0, 80)})`); return false; }
    };

    journal('\n— parcours de signature —');

    /**
     * ON REMPLIT CHAQUE ZONE, PAS SEULEMENT LA PREMIÈRE.
     *
     * Les trois cibles doivent porter une signature : c'est ce qui permet de
     * mesurer un FACTEUR et non une translation. Une seule signature ne
     * distinguerait pas une échelle fausse d'un décalage constant.
     */
    /**
     * LE PAVÉ S'OUVRE UNE FOIS, PUIS IL ENCHAÎNE.
     *
     * « Champ suivant » ne referme pas le pavé : il applique le tracé et passe
     * à la zone suivante. Tenter de recliquer une zone sur la page échoue —
     * l'overlay du pavé la recouvre. On ouvre donc une seule fois, et on
     * enchaîne autant de tracés qu'il y a de zones.
     */
    for (let index = 0; index < CIBLES.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ouvert = index === 0
        ? await essayer('ouverture du pavé (zone 1)', async () => {
          await page.locator('.signYourselfBlock').first().click({ timeout: 10_000 });
          await page.waitForTimeout(2500);
        })
        : true;
      if (!ouvert) continue;
      if (index === 0) {
        await capture('03-pave-signature');
        // Le pavé du fournisseur change de forme au fil des versions : on garde
        // sa structure à chaque passage, pour que l'adaptation soit une lecture
        // et non une devinette.
        writeFileSync(path.join(DOSSIER, 'pave-signature.html'), await page.content(), 'utf8');
      }

      /**
       * ON TRACE, PARCE QUE C'EST CE QUE LE PAVÉ PROPOSE.
       *
       * Le pavé d'OpenSign est un canevas de tracé (`.signatureCanvas`). Le
       * tracé lui-même n'a aucune importance : ce qu'on mesure n'est pas
       * l'image, c'est l'ENDROIT où le client la pose. Un geste simple et
       * reproductible suffit — et il doit couvrir assez de surface pour que
       * l'image produite ne soit pas dégénérée.
       */
      // eslint-disable-next-line no-await-in-loop
      await essayer(`zone ${index + 1} — tracé`, async () => {
        const canevas = page.locator('canvas.signatureCanvas').first();
        const boite = await canevas.boundingBox({ timeout: 6000 });
        if (!boite) throw new Error('canevas introuvable');
        const y = boite.y + boite.height / 2;
        await page.mouse.move(boite.x + boite.width * 0.15, y);
        await page.mouse.down();
        for (const t of [0.3, 0.45, 0.6, 0.75, 0.85]) {
          // eslint-disable-next-line no-await-in-loop
          await page.mouse.move(boite.x + boite.width * t, y + (t % 0.2 > 0.1 ? -22 : 22));
        }
        await page.mouse.up();
        await page.waitForTimeout(900);
      });

      /**
       * « CHAMP SUIVANT » APPLIQUE ET AVANCE — c'est le verbe du pavé, et il
       * enchaîne les zones sans repasser par la page. Un bouton « enregistrer »
       * n'existe pas ici : le chercher ferait échouer chaque zone.
       */
      /**
       * LE LIBELLÉ CHANGE SUR LA DERNIÈRE ZONE.
       *
       * « Champ suivant » devient « Terminé » quand il n'y a plus de zone
       * après. Et « Terminé » existe AUSSI dans la barre d'outils de la page,
       * derrière l'overlay : viser le premier bouton trouvé cliquerait celui
       * qui est masqué, et l'attente expirerait sans rien dire d'utile. On
       * prend donc le DERNIER — celui du pavé, ouvert par-dessus.
       */
      // eslint-disable-next-line no-await-in-loop
      await essayer(`zone ${index + 1} — application`, async () => {
        await page.getByRole('button', { name: /champ suivant|next field|terminé|finish|save|appliquer/i })
          .last().click({ timeout: 8000 });
        await page.waitForTimeout(2500);
      });
      if (index === 0) await capture('04-premiere-signature');
    }

    await capture('05-zones-remplies');

    /**
     * TOUJOURS LE DERNIER BOUTON QUI CORRESPOND.
     *
     * « terminé » existe en permanence dans la barre d'outils, sous l'overlay.
     * Les modales successives en ajoutent un par-dessus. Le DERNIER dans le DOM
     * est celui qui est visible ; le premier est celui qui ne l'est pas. Viser
     * le premier produit une attente qui expire sans jamais dire pourquoi.
     */
    await essayer('finalisation « terminé »', async () => {
      await page.getByRole('button', { name: /^terminé$|^finish$|^complete$/i })
        .last().click({ timeout: 10_000 });
      await page.waitForTimeout(4000);
    });
    await capture('06-finalisation');

    // La chaîne de confirmations n'a pas de longueur garantie : on la déroule
    // tant qu'un bouton d'assentiment reste visible, sans jamais boucler.
    for (let tour = 0; tour < 3; tour += 1) {
      // eslint-disable-next-line no-await-in-loop
      const clique = await essayer(`confirmation ${tour + 1}`, async () => {
        await page.getByRole('button', { name: /oui|yes|confirm|ok|signer|^sign$|^terminé$/i })
          .last().click({ timeout: 6000 });
        await page.waitForTimeout(8000);
      });
      if (!clique) break;
    }
    await capture('07-confirme');

    rapport.etapes = etapes;
  }

  /* ── MESURE SUR LE DOCUMENT RÉELLEMENT PRODUIT ────────────────────────── */

  journal('\n— relecture du document —');
  let doc = null;
  for (let essai = 0; essai < 10; essai += 1) {
    // eslint-disable-next-line no-await-in-loop
    doc = await appel(credentials, 'GET', `/document/${objectId}`);
    journal(`   tentative ${essai + 1} : status=${doc?.status} auditTrail=${JSON.stringify(doc?.audit_trail ?? [])}`);
    if (doc?.status === 'completed' || doc?.audit_trail?.some((a) => a.signed)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 4000));
  }

  rapport.documentFinal = { status: doc?.status ?? null, auditTrail: doc?.audit_trail ?? null };

  if (doc?.file) {
    const reponse = await fetch(doc.file);
    const octets = Buffer.from(await reponse.arrayBuffer());
    writeFileSync(path.join(DOSSIER, 'placement-signe.pdf'), octets);
    journal(`   PDF relu : ${octets.length} octets`);

    const images = imagesPositionnees(octets);
    journal(`   images positionnées : ${images.length}`);
    rapport.imagesTrouvees = images;

    const mesures = CIBLES.map((c) => {
      const attendu = { x: c.x, yBas: TAILLE.height - c.y - c.h, largeur: c.w, hauteur: c.h };
      /**
       * ON APPARIE PAR PROXIMITÉ, PAS PAR ORDRE.
       *
       * L'ordre des `Do` dans un flux n'a aucune raison de suivre l'ordre de nos
       * widgets. Apparier par index produirait des écarts inventés.
       */
      const candidat = images
        .map((i) => ({ i, d: Math.hypot(i.x - attendu.x, i.yBas - attendu.yBas) }))
        .sort((a, b) => a.d - b.d)[0];
      return {
        cible: c.nom,
        attendu,
        mesure: candidat ? { x: candidat.i.x, yBas: candidat.i.yBas, largeur: candidat.i.largeur, hauteur: candidat.i.hauteur } : null,
        ecart: candidat ? { x: +(candidat.i.x - attendu.x).toFixed(2), y: +(candidat.i.yBas - attendu.yBas).toFixed(2) } : null,
      };
    });
    rapport.mesures = mesures;

    journal('\n══ ÉCART ENTRE LA POSITION DEMANDÉE ET LA POSITION RENDUE ══');
    for (const m of mesures) {
      journal(`  ${m.cible.padEnd(15)} attendu x=${m.attendu.x} y_bas=${m.attendu.yBas}`
        + `  →  mesuré ${m.mesure ? `x=${m.mesure.x} y_bas=${m.mesure.yBas}` : '(aucune image)'}`
        + `  →  écart ${m.ecart ? `Δx=${m.ecart.x} Δy=${m.ecart.y}` : '—'}`);
    }
    const bon = mesures.every((m) => m.ecart && Math.abs(m.ecart.x) <= 2 && Math.abs(m.ecart.y) <= 2);
    rapport.verdict = bon ? 'PLACEMENT CONFORME' : 'PLACEMENT NON PROUVÉ';
    journal(`\n  VERDICT : ${rapport.verdict}`);
  } else {
    journal('   aucun fichier lisible sur le document.');
  }
} catch (error) {
  journal(`\nÉCHEC : ${error?.httpStatus ?? ''} ${error?.providerError ?? error?.message}`);
  rapport.erreur = { message: error?.message ?? String(error), stack: String(error?.stack ?? '').split('\n').slice(0, 4) };
} finally {
  if (navigateur) await navigateur.close().catch(() => {});
  if (!GARDER) {
    for (const id of aNettoyer.filter(Boolean)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await appel(credentials, 'DELETE', `/document/${id}`);
        journal(`\nnettoyé : ${id}`);
      } catch (e) { journal(`\nNON nettoyé : ${id} — ${e?.providerError ?? e?.message}`); }
    }
  } else journal(`\n--keep : ${aNettoyer.join(', ')}`);

  writeFileSync(path.join(DOSSIER, 'opensign-placement.json'), JSON.stringify(rapport, null, 1), 'utf8');
  journal(`\nartefact : ${path.join(DOSSIER, 'opensign-placement.json')}`);
  await disconnectDatabase();
}
