// MESURE — REDIRECTION DE FIN ET ORDRE DE SIGNATURE.
//
// Campagne de migration Yousign → OpenSign, lot 1, points 11 et 12.
//
//   node tools/opensign/measureRedirectAndOrder.js [--keep]
//
// ══ LES DEUX QUESTIONS ══════════════════════════════════════════════════════
//
// 1. OÙ ATTERRIT LE SIGNATAIRE ? Yousign accepte trois URL PAR SIGNATAIRE
//    (succès, erreur, refus). OpenSign n'a qu'un `redirect_url`, pour tout le
//    document. Il faut savoir ce qu'il en fait réellement : est-il respecté ?
//    porte-t-il des paramètres ? distingue-t-il l'issue ?
//
//    L'enjeu est concret : le parcours actuel de SB Auto ramène le DÉVELOPPEUR
//    sur sa liste de contrats et le CLIENT sur une page de retour paramétrée
//    par l'issue. Si OpenSign ne sait pas les distinguer, il faut le savoir
//    avant d'écrire l'adaptateur, pas après.
//
// 2. L'ORDRE EST-IL RÉELLEMENT IMPOSÉ ? `sendInOrder` seul n'échelonne que les
//    e-mails. `send_in_order_strict` prétend BLOQUER l'accès. Le parcours métier
//    en dépend : le client ne doit pas pouvoir contresigner avant l'équipe
//    technique. Une promesse de documentation ne suffit pas.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectDatabase, disconnectDatabase } from '../../backend/src/config/db.js';
import { openSignFetch } from '../../backend/src/services/integratedApi/opensign/openSignTransport.js';
import { loadOpenSignSandboxCredentials } from './campaignCredentials.js';
import { chargerChromium } from './browser.js';
import { buildFixturePdf, PAGE_SIZES } from './fixturePdf.js';

const GARDER = process.argv.includes('--keep');
const journal = (...a) => console.log(...a);
const appel = (credentials, method, chemin, json) =>
  openSignFetch({ credentials, method, path: chemin, json, timeoutMs: 120_000 });

const DOSSIER = path.resolve(fileURLToPath(new URL('../../.campaign/', import.meta.url)));
mkdirSync(DOSSIER, { recursive: true });

/**
 * LA CIBLE DE RETOUR VISE L'API, PAS L'INTERFACE — et ce détail décide de la
 * mesure.
 *
 * Premier essai : une URL de l'application React. OpenSign y a bien redirigé,
 * mais l'application, ne connaissant pas cette route, a immédiatement réécrit
 * l'URL vers son écran de connexion. On mesurait donc le comportement du SPA,
 * pas celui du fournisseur — et les paramètres d'URL éventuels avaient disparu
 * avant qu'on puisse les lire.
 *
 * Une route d'API inexistante répond en JSON et NE RÉÉCRIT RIEN : l'URL finale
 * du navigateur est exactement celle qu'OpenSign a produite, paramètres
 * compris. C'est la seule façon de savoir ce qu'il ajoute — ou n'ajoute pas.
 */
const RETOUR = 'https://api.panel.ly-solution.com/recette/opensign/retour';
const TAILLE = PAGE_SIZES.A4_PORTRAIT;

await connectDatabase();
const { credentials } = await loadOpenSignSandboxCredentials();

const rapport = { startedAt: new Date().toISOString(), redirectDemande: RETOUR };
const aNettoyer = [];
let navigateur = null;

/** Signe la première zone disponible et rend l'URL d'atterrissage. */
async function signer(page, lien, etiquette) {
  journal(`\n   — ${etiquette} —`);
  await page.goto(lien, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForTimeout(6000);

  await page.getByRole('button', { name: /confirme|confirm|accept|agree/i })
    .first().click({ timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(3500);

  /**
   * L'ACCÈS EST-IL SEULEMENT OUVERT ?
   *
   * En ordre strict, un signataire qui n'a pas la main ne doit PAS voir de zone
   * à remplir. L'absence de zone n'est donc pas un échec du script : c'est la
   * mesure elle-même.
   */
  const texte = await page.locator('body').innerText().catch(() => '');
  const zones = await page.locator('.signYourselfBlock').count().catch(() => 0);
  if (zones === 0) {
    return { refuseAffichage: true, zones, url: page.url(), extrait: texte.slice(0, 400) };
  }

  await page.locator('.signYourselfBlock').first().click({ timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const canevas = page.locator('canvas.signatureCanvas').first();
  const boite = await canevas.boundingBox({ timeout: 8000 }).catch(() => null);
  if (boite) {
    const y = boite.y + boite.height / 2;
    await page.mouse.move(boite.x + boite.width * 0.2, y);
    await page.mouse.down();
    for (const t of [0.4, 0.55, 0.7, 0.8]) await page.mouse.move(boite.x + boite.width * t, y + (t > 0.5 ? -20 : 20));
    await page.mouse.up();
    await page.waitForTimeout(900);
  }
  await page.getByRole('button', { name: /champ suivant|terminé|save|appliquer/i })
    .last().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: /^terminé$|^finish$/i }).last().click({ timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await page.getByRole('button', { name: /oui|yes|confirm|ok|signer|^terminé$/i })
      .last().click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!ok) break;
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(7000);
  }
  await page.waitForTimeout(6000);
  /**
   * CE QUE L'ÉCRAN DIT APRÈS LA TENTATIVE.
   *
   * Un refus d'ordre strict ne masque pas le document : il refuse l'ACTE, et le
   * dit dans un message. Le capturer distingue « le fournisseur a refusé » de
   * « mon script n'a pas su cliquer » — deux causes qui produisent le même
   * silence dans la piste d'audit.
   */
  const apres = await page.locator('body').innerText().catch(() => '');
  const refus = apres.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => /ordre|order|attend|wait|previous|précéd|forbidden|autoris/i.test(l))
    .slice(0, 3);
  return { refuseAffichage: false, zones, url: page.url(), messageRefus: refus };
}

try {
  journal('\n=== REDIRECTION ET ORDRE DE SIGNATURE ===\n');

  const pdf = buildFixturePdf({ size: TAILLE, title: 'RECETTE — REDIRECTION ET ORDRE' });
  const cree = await appel(credentials, 'POST', '/createdocument', {
    file: pdf.toString('base64'),
    title: 'RECETTE OPENSIGN — redirection et ordre',
    send_email: false,
    enableOTP: false,
    enableTour: false,
    /** L'ordre STRICT : ce n'est pas un échelonnement d'e-mails, c'est un verrou. */
    sendInOrder: true,
    send_in_order_strict: true,
    redirect_url: RETOUR,
    signers: [
      {
        role: 'DEVELOPER', email: 'dev.recette@example.com', name: 'Recette Developpeur',
        signer_role: 'signer',
        widgets: [{ type: 'signature', page: 1, x: 60, y: 120, w: 150, h: 45 }],
      },
      {
        role: 'CLIENT', email: 'client.recette@example.com', name: 'Recette Client',
        signer_role: 'signer',
        widgets: [{ type: 'signature', page: 1, x: 60, y: 300, w: 150, h: 45 }],
      },
    ],
  });

  const objectId = cree.objectId;
  aNettoyer.push(objectId);
  const liens = new Map((cree.signurl ?? []).map((s) => [s.email, s.url]));
  journal(`document ${objectId} — ${liens.size} lien(s) de signature`);
  rapport.liensRendusPourTousLesSignataires = liens.size === 2;

  navigateur = await (await chargerChromium()).launch({ headless: true });
  const contexte = await navigateur.newContext({ viewport: { width: 1440, height: 1000 } });

  /* ── 1. LE CLIENT EN PREMIER : doit être BLOQUÉ ───────────────────────── */

  const pageClient = await contexte.newPage();
  const avant = await signer(pageClient, liens.get('client.recette@example.com'), 'CLIENT avant le DEV (doit être bloqué)');
  journal(`      document affiché : ${!avant.refuseAffichage} | zones visibles : ${avant.zones}`);
  if (avant.messageRefus?.length) journal(`      message du fournisseur : ${JSON.stringify(avant.messageRefus)}`);
  rapport.ordre = {
    clientAvantDev: {
      documentAffiche: !avant.refuseAffichage,
      zonesVisibles: avant.zones,
      messageRefus: avant.messageRefus ?? [],
    },
  };
  await pageClient.close();

  const apresTentative = await appel(credentials, 'GET', `/document/${objectId}`);
  const clientASigne = (apresTentative.audit_trail ?? []).some(
    (a) => a.email === 'client.recette@example.com' && a.signed,
  );
  rapport.ordre.clientASignePrematurement = clientASigne;
  journal(`      le client a-t-il pu signer avant son tour ? ${clientASigne ? 'OUI (ANOMALIE)' : 'non'}`);

  /* ── 2. LE DEV SIGNE : on mesure l'atterrissage ───────────────────────── */

  const pageDev = await contexte.newPage();
  const dev = await signer(pageDev, liens.get('dev.recette@example.com'), 'DEV (1er signataire)');
  journal(`      atterrissage : ${dev.url.slice(0, 160)}`);
  const urlDev = (() => { try { return new URL(dev.url); } catch { return null; } })();
  rapport.redirectionDev = {
    respectee: urlDev ? dev.url.startsWith(RETOUR) : false,
    origine: urlDev?.origin ?? null,
    chemin: urlDev?.pathname ?? null,
    parametres: urlDev ? [...urlDev.searchParams.keys()] : [],
  };
  await pageDev.close();

  /* ── 3. LE CLIENT APRÈS : l'accès doit s'ouvrir ───────────────────────── */

  const pageClient2 = await contexte.newPage();
  const apres = await signer(pageClient2, liens.get('client.recette@example.com'), 'CLIENT après le DEV');
  journal(`      document affiché : ${!apres.refuseAffichage} | zones visibles : ${apres.zones}`);
  journal(`      atterrissage : ${apres.url.slice(0, 160)}`);
  const urlClient = (() => { try { return new URL(apres.url); } catch { return null; } })();
  rapport.ordre.clientApresDev = { documentAffiche: !apres.refuseAffichage, zonesVisibles: apres.zones };
  rapport.redirectionClient = {
    respectee: urlClient ? apres.url.startsWith(RETOUR) : false,
    origine: urlClient?.origin ?? null,
    chemin: urlClient?.pathname ?? null,
    parametres: urlClient ? [...urlClient.searchParams.keys()] : [],
  };
  await pageClient2.close();

  /* ── 4. L'ÉTAT FINAL ─────────────────────────────────────────────────── */

  const final = await appel(credentials, 'GET', `/document/${objectId}`);
  rapport.etatFinal = {
    status: final.status,
    auditTrail: final.audit_trail,
    aCertificat: Boolean(final.certificate),
    aFichier: Boolean(final.file),
  };
  journal(`\n   état final : ${final.status}`);
  journal(`   piste d’audit : ${JSON.stringify(final.audit_trail)}`);
  journal(`   certificat disponible : ${Boolean(final.certificate)}`);

  journal('\n══ VERDICTS ══');
  /**
   * LE BON CRITÈRE N'EST PAS « LE DOCUMENT EST-IL CACHÉ ? »
   *
   * OpenSign AFFICHE le document au second signataire avant son tour — il peut
   * le lire, c'est même souhaitable. Ce qu'il ne peut pas, c'est SIGNER : le
   * serveur refuse l'acte tant que le précédent n'a pas agi.
   *
   * Mesurer l'affichage aurait donc conclu « ordre non respecté » sur un
   * comportement parfaitement correct, et poussé à chercher un réglage qui
   * n'existe pas. La preuve est dans la PISTE D'AUDIT : aucune signature du
   * client avant celle du développeur.
   */
  const ordreTenu = !clientASigne
    && (final.audit_trail ?? []).every((a) => a.email !== 'client.recette@example.com' || a.signed);
  journal(`   ordre strict tenu par le serveur : ${ordreTenu ? 'OUI' : 'NON'}`);
  journal(`      (le document est LISIBLE avant son tour, mais l’acte est refusé)`);
  rapport.ordre.tenuParLeServeur = ordreTenu;
  journal(`   redirection DEV respectée      : ${rapport.redirectionDev.respectee ? 'OUI' : 'NON'} ${JSON.stringify(rapport.redirectionDev.parametres)}`);
  journal(`   redirection CLIENT respectée   : ${rapport.redirectionClient.respectee ? 'OUI' : 'NON'} ${JSON.stringify(rapport.redirectionClient.parametres)}`);
  journal(`   les deux atterrissent au MÊME endroit : ${rapport.redirectionDev.chemin === rapport.redirectionClient.chemin ? 'OUI' : 'NON'}`);
} catch (error) {
  journal(`\nÉCHEC : ${error?.httpStatus ?? ''} ${error?.providerError ?? error?.message}`);
  rapport.erreur = { message: error?.message ?? String(error) };
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
  writeFileSync(path.join(DOSSIER, 'opensign-redirect-ordre.json'), JSON.stringify(rapport, null, 1), 'utf8');
  journal(`\nartefact : ${path.join(DOSSIER, 'opensign-redirect-ordre.json')}`);
  await disconnectDatabase();
}
