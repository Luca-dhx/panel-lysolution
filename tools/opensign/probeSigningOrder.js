// L'ORDRE DE SIGNATURE EST-IL RÉELLEMENT IMPOSÉ ? — la question, tranchée.
//
// Campagne de migration Yousign → OpenSign, lot 6.
//
//   node tools/opensign/probeSigningOrder.js [--keep] [--headed]
//
// ══ POURQUOI CETTE SONDE EXISTE ═════════════════════════════════════════════
//
// La recette d'achèvement a mesuré que le client se voit offrir DEUX zones
// signables alors que le développeur n'a pas encore signé. Ce n'est pas une
// preuve que l'ordre est rompu — une interface peut afficher puis refuser — et
// ce n'est pas une preuve qu'il tient non plus.
//
// La question ne se contourne pas : SB Auto en dépend. Son cycle de vie fait
// passer le contrat en INACTIVE sur la signature du DÉVELOPPEUR, puis ouvre au
// client. Si le client peut signer d'abord, le contrat porte l'engagement d'une
// partie qui ne l'a pas encore relu, et l'état métier décrit une réalité qui
// n'existe pas.
//
// ══ CE QUE LA SONDE FAIT ════════════════════════════════════════════════════
//
// Elle ouvre une demande à deux signataires en ordre strict, puis TENTE
// RÉELLEMENT de signer comme CLIENT, en premier. Elle juge ensuite sur l'état
// rendu par le fournisseur — pas sur l'écran, pas sur un libellé.
//
// Elle mesure aussi À QUI appartiennent les zones affichées : un signataire à
// qui on présente la zone d'un autre pourrait apposer sa signature sur la ligne
// de son cocontractant.
//
// ══ SÛRETÉ ═════════════════════════════════════════════════════════════════
//
// PDF généré, identités sur `example.com`, aucun envoi, suppression après.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { connectDatabase, disconnectDatabase } from '../../backend/src/config/db.js';
import { invokeCapability } from '../../backend/src/services/capabilities/capabilityGateway.service.js';
import { INVOCATION_SOURCES } from '../../backend/src/services/capabilities/invocationContext.js';
import PanelSignatureBinding from '../../backend/src/models/PanelSignatureBinding.model.js';
import { openSignFetch } from '../../backend/src/services/integratedApi/opensign/openSignTransport.js';
import { loadOpenSignSandboxCredentials } from './campaignCredentials.js';
import { chargerChromium } from './browser.js';
import { buildFixturePdf, PAGE_SIZES } from './fixturePdf.js';

const GARDER = process.argv.includes('--keep');
const VISIBLE = process.argv.includes('--headed');
const journal = (...a) => console.log(...a);
const DOSSIER = path.resolve(fileURLToPath(new URL('../../.campaign/', import.meta.url)));
mkdirSync(DOSSIER, { recursive: true });

const PROJET = { projectId: 'sonde-ordre-signature', projectName: 'Sonde — ordre de signature' };
const appeler = (code, payload) => invokeCapability({
  code, panelProject: PROJET, payload, requestId: randomUUID(), source: INVOCATION_SOURCES.PANEL_INTERNAL,
});

const TAILLE = PAGE_SIZES.A4_PORTRAIT;
const rapport = { startedAt: new Date().toISOString() };
const aNettoyer = [];
let navigateur = null;

await connectDatabase();
const { credentials } = await loadOpenSignSandboxCredentials();

try {
  journal('\n=== SONDE — L’ORDRE DE SIGNATURE EST-IL IMPOSÉ ? ===');

  const pdf = buildFixturePdf({
    size: TAILLE,
    title: 'SONDE — ORDRE DE SIGNATURE',
    landmarksByPage: [[
      { xFromLeft: 70, yFromTop: 600, width: 170, height: 55, label: 'DEVELOPPEUR' },
      { xFromLeft: 330, yFromTop: 600, width: 170, height: 55, label: 'CLIENT' },
    ]],
  });

  const contractRef = `sonde-ordre-${Date.now()}`;
  const r = await appeler('signature.request.open', {
    contractRef,
    name: `Sonde ordre ${contractRef}`,
    documentBase64: pdf.toString('base64'),
    documentFilename: 'sonde-ordre.pdf',
    returnUrl: 'https://api.panel.ly-solution.com/recette/opensign/retour',
    signers: [
      { role: 'DEVELOPER', firstName: 'Sonde', lastName: 'Developpeur', email: 'dev.recette@example.com' },
      { role: 'CLIENT', firstName: 'Sonde', lastName: 'Client', email: 'client.recette@example.com' },
    ],
    fields: [
      { signerRole: 'DEVELOPER', page: 1, x: 70, y: 600, width: 170, height: 55 },
      { signerRole: 'CLIENT', page: 1, x: 330, y: 600, width: 170, height: 55 },
    ],
    operationId: `sig-open-${contractRef}`,
  });
  const demandeId = r.result.signatureRequestId;
  aNettoyer.push(demandeId);
  journal(`demande ${demandeId}`);

  const lienDe = async (role) => {
    const lecture = await appeler('signature.request.retrieve', { signatureRequestId: demandeId });
    const cible = lecture.result.signers.find((s) => s.role === role);
    const l = await appeler('signature.signer.retrieve', {
      signatureRequestId: demandeId, signerId: cible.signerId,
    });
    return l.result.signatureLink;
  };

  navigateur = await (await chargerChromium()).launch({ headless: !VISIBLE });
  const contexte = await navigateur.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await contexte.newPage();

  await page.goto(await lienDe('CLIENT'), { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: /confirme|confirm|accept|agree/i })
    .first().click({ timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(4000);

  /**
   * À QUI APPARTIENNENT LES ZONES AFFICHÉES ?
   *
   * Le client n'a qu'une zone. S'il en voit deux et qu'elles sont toutes deux
   * signables par lui, il peut apposer sa signature sur la ligne de son
   * cocontractant — ce qui produirait un contrat où la même personne a signé
   * pour les deux parties.
   */
  const zones = await page.evaluate(() => [...document.querySelectorAll('.signYourselfBlock')].map((el) => ({
    texte: (el.innerText ?? '').trim().split('\n')[0] ?? '',
    classes: el.className,
    style: (el.getAttribute('style') ?? '').slice(0, 120),
  })));
  journal(`\nzones offertes au CLIENT : ${zones.length}`);
  for (const z of zones) journal(`   · « ${z.texte} » — ${z.style}`);
  await page.screenshot({ path: path.join(DOSSIER, 'sonde-ordre-client-ecran.png') });

  /* ── LA TENTATIVE RÉELLE ───────────────────────────────────────────────── */

  journal('\n— le client TENTE de signer, avant le développeur —');
  const essayer = async (description, action) => {
    try { await action(); journal(`   ✓ ${description}`); return true; }
    catch (e) { journal(`   – ${description} (${String(e.message).split('\n')[0].slice(0, 80)})`); return false; }
  };

  await essayer('ouverture du pavé', async () => {
    await page.locator('.signYourselfBlock').first().click({ timeout: 12_000 });
    await page.waitForTimeout(2500);
  });
  await essayer('tracé', async () => {
    const canevas = page.locator('canvas.signatureCanvas').first();
    const boite = await canevas.boundingBox({ timeout: 6000 });
    if (!boite) throw new Error('canevas introuvable');
    const y = boite.y + boite.height / 2;
    await page.mouse.move(boite.x + boite.width * 0.15, y);
    await page.mouse.down();
    for (const t of [0.3, 0.5, 0.7, 0.85]) {
      // eslint-disable-next-line no-await-in-loop
      await page.mouse.move(boite.x + boite.width * t, y + (t % 0.2 > 0.1 ? -22 : 22));
    }
    await page.mouse.up();
    await page.waitForTimeout(900);
  });
  await essayer('application', async () => {
    await page.getByRole('button', { name: /champ suivant|next field|terminé|finish|save|appliquer/i })
      .last().click({ timeout: 8000 });
    await page.waitForTimeout(2500);
  });
  await essayer('finalisation', async () => {
    await page.getByRole('button', { name: /^terminé$|^finish$|^complete$/i })
      .last().click({ timeout: 10_000 });
    await page.waitForTimeout(4000);
  });
  for (let tour = 0; tour < 3; tour += 1) {
    // eslint-disable-next-line no-await-in-loop
    const clique = await essayer(`confirmation ${tour + 1}`, async () => {
      await page.getByRole('button', { name: /oui|yes|confirm|ok|signer|^sign$|^terminé$/i })
        .last().click({ timeout: 6000 });
      await page.waitForTimeout(8000);
    });
    if (!clique) break;
  }
  await page.screenshot({ path: path.join(DOSSIER, 'sonde-ordre-apres-tentative.png') });
  const messages = await page.locator('body').innerText().catch(() => '');

  /* ── LE VERDICT VIENT DE L'ÉTAT, PAS DE L'ÉCRAN ────────────────────────── */

  const lecture = await appeler('signature.request.retrieve', { signatureRequestId: demandeId });
  const parRole = Object.fromEntries(lecture.result.signers.map((s) => [s.role, s.state]));
  const clientASigne = parRole.CLIENT === 'SIGNED';

  rapport.zonesOffertesAuClient = zones.length;
  rapport.etatsApresTentative = parRole;
  rapport.etatDemande = lecture.result.state;
  rapport.ordreImpose = !clientASigne;
  rapport.extraitEcran = String(messages).split('\n').map((l) => l.trim())
    .filter(Boolean).slice(0, 30);

  journal('\n══ VERDICT ══');
  journal(`   zones offertes au client       : ${zones.length}`);
  journal(`   états après tentative          : ${JSON.stringify(parRole)}`);
  journal(`   état de la demande             : ${lecture.result.state}`);
  journal(`   L'ORDRE EST-IL IMPOSÉ ?        : ${clientASigne ? 'NON — le client a signé en premier' : 'OUI — le client n’a pas pu signer'}`);
} catch (error) {
  journal(`\nÉCHEC : ${error?.httpStatus ?? ''} ${error?.providerError ?? error?.message}`);
  rapport.erreur = { message: String(error?.message ?? error), code: error?.code ?? null };
} finally {
  if (navigateur) await navigateur.close().catch(() => {});
  if (!GARDER) {
    for (const id of aNettoyer) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await openSignFetch({ credentials, method: 'DELETE', path: `/document/${id}`, timeoutMs: 60_000 });
        journal(`\nnettoyé : ${id}`);
      } catch (e) { journal(`\nNON nettoyé : ${id} — ${e?.providerError ?? e?.message}`); }
    }
    await PanelSignatureBinding.deleteMany({ projectId: PROJET.projectId });
  }
  rapport.finishedAt = new Date().toISOString();
  writeFileSync(path.join(DOSSIER, 'opensign-signing-order.json'), JSON.stringify(rapport, null, 1), 'utf8');
  journal(`\nartefact : ${path.join(DOSSIER, 'opensign-signing-order.json')}`);
  await disconnectDatabase();
}
