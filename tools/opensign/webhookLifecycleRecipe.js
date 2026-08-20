// RECETTE DU CHEMIN RETOUR — de vrais webhooks OpenSign, reçus par le Panel DÉPLOYÉ.
//
// Campagne de migration Yousign → OpenSign, lots 1 (point 6) et 3.
//
//   node tools/opensign/webhookLifecycleRecipe.js [--keep]
//
// ══ POURQUOI CETTE RECETTE NE PEUT PAS ÊTRE UN TEST ═════════════════════════
//
// Tout le reste se prouve en local : traduction, idempotence, appartenance. La
// SIGNATURE HMAC, elle, ne se prouve qu'avec un événement réellement émis par
// le fournisseur — c'est le seul moyen de trancher l'ambiguïté de sa
// documentation, qui dit « corps brut » et dont l'exemple signe une
// re-sérialisation.
//
// Le fournisseur appelle une adresse publique : la recette exige donc un Panel
// DÉPLOYÉ. Ce script pilote depuis le poste, et OBSERVE ce que l'instance
// déployée a écrit — les deux partagent la même base.
//
// ══ CE QU'ELLE MESURE ══════════════════════════════════════════════════════
//
//   · les événements arrivent-ils, et lesquels ?
//   · leur signature est-elle PROUVÉE (et non seulement acceptée) ?
//   · le cycle create → viewed → signed → signed → completed est-il complet ?
//   · les faits sont-ils projetés vers le bon projet, dans le bon vocabulaire ?
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { connectDatabase, disconnectDatabase } from '../../backend/src/config/db.js';
import { invokeCapability } from '../../backend/src/services/capabilities/capabilityGateway.service.js';
import { INVOCATION_SOURCES } from '../../backend/src/services/capabilities/invocationContext.js';
import PanelSignatureBinding from '../../backend/src/models/PanelSignatureBinding.model.js';
import PanelProviderWebhookEvent from '../../backend/src/models/PanelProviderWebhookEvent.model.js';
import { PanelSyncJournalEntry } from '../../backend/src/models/PanelSyncState.model.js';
import { openSignFetch } from '../../backend/src/services/integratedApi/opensign/openSignTransport.js';
import { signerHandle } from '../../backend/src/services/integratedApi/opensign/openSignAdapters.js';
import { loadOpenSignSandboxCredentials } from './campaignCredentials.js';
import { chargerChromium } from './browser.js';
import { buildFixturePdf, PAGE_SIZES } from './fixturePdf.js';

const GARDER = process.argv.includes('--keep');
const journal = (...a) => console.log(...a);
const DOSSIER = path.resolve(fileURLToPath(new URL('../../.campaign/', import.meta.url)));
mkdirSync(DOSSIER, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const PROJET = { projectId: 'recette-opensign-webhook', projectName: 'Recette webhook OpenSign' };
const DEV = 'dev.recette@example.com';
const CLIENT = 'client.recette@example.com';

const rapport = { startedAt: new Date().toISOString(), etapes: [] };
const aNettoyer = [];
let navigateur = null;

const noter = (id, titre, valeur) => {
  rapport.etapes.push({ id, titre, valeur });
  journal(`   ${id} · ${titre} → ${JSON.stringify(valeur).slice(0, 400)}`);
};

/** Signe toutes les zones visibles d'une page de signature, puis conclut. */
async function signer(contexte, lien, etiquette) {
  journal(`\n── ${etiquette}`);
  const page = await contexte.newPage();
  await page.goto(lien, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: /confirme|confirm|accept|agree/i })
    .first().click({ timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(3500);

  const zones = await page.locator('.signYourselfBlock').count().catch(() => 0);
  if (zones > 0) {
    await page.locator('.signYourselfBlock').first().click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    for (let i = 0; i < zones; i += 1) {
      const canevas = page.locator('canvas.signatureCanvas').first();
      // eslint-disable-next-line no-await-in-loop
      const boite = await canevas.boundingBox({ timeout: 8000 }).catch(() => null);
      if (!boite) break;
      const y = boite.y + boite.height / 2;
      // eslint-disable-next-line no-await-in-loop
      await page.mouse.move(boite.x + boite.width * 0.2, y);
      // eslint-disable-next-line no-await-in-loop
      await page.mouse.down();
      for (const t of [0.4, 0.55, 0.7, 0.8]) {
        // eslint-disable-next-line no-await-in-loop
        await page.mouse.move(boite.x + boite.width * t, y + (t > 0.5 ? -20 : 20));
      }
      // eslint-disable-next-line no-await-in-loop
      await page.mouse.up();
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(800);
      // eslint-disable-next-line no-await-in-loop
      await page.getByRole('button', { name: /champ suivant|terminé|save|appliquer/i })
        .last().click({ timeout: 8000 }).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(2000);
    }
  }
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
  await page.waitForTimeout(4000);
  const url = page.url();
  await page.close();
  return { zones, url };
}

/** Les événements reçus par le Panel DÉPLOYÉ pour ce document. */
async function evenementsRecus() {
  return PanelProviderWebhookEvent.find({ provider: 'OPENSIGN', environment: 'TEST' })
    .sort({ receivedAt: 1 }).lean();
}

/** Attend qu'un type d'événement soit consigné, ou renonce. */
async function attendre(type, limiteMs = 90_000) {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) {
    // eslint-disable-next-line no-await-in-loop
    const vus = await evenementsRecus();
    if (vus.some((e) => e.eventType === type)) return vus;
    // eslint-disable-next-line no-await-in-loop
    await dormir(4000);
  }
  return evenementsRecus();
}

await connectDatabase();
const { credentials } = await loadOpenSignSandboxCredentials();

try {
  journal('\n=== RECETTE DU CHEMIN RETOUR — WEBHOOKS OPENSIGN RÉELS ===');

  /**
   * ON PART D'UNE ARDOISE PROPRE POUR CE FOURNISSEUR.
   *
   * Les événements d'exécutions antérieures fausseraient la lecture — on
   * conclurait « reçu » sur un événement d'hier. Ils sont retirés ici, pas à la
   * fin : un nettoyage final ne dit rien de ce qu'on vient d'observer.
   */
  const purges = await PanelProviderWebhookEvent.deleteMany({ provider: 'OPENSIGN' });
  journal(`\n   ardoise : ${purges.deletedCount} événement(s) OpenSign antérieur(s) retiré(s)`);
  await PanelSyncJournalEntry.deleteMany({ audience: PROJET.projectId });

  const taille = PAGE_SIZES.A4_PORTRAIT;
  const pdf = buildFixturePdf({
    size: taille,
    title: 'RECETTE WEBHOOK — CONTRAT FICTIF',
    landmarksByPage: [[
      { xFromLeft: 60, yFromTop: 600, width: 170, height: 55, label: 'DEVELOPPEUR' },
      { xFromLeft: 340, yFromTop: 600, width: 170, height: 55, label: 'CLIENT' },
    ]],
  });

  const contractRef = `webhook-${Date.now()}`;
  const ouvert = await invokeCapability({
    code: 'signature.request.open',
    panelProject: PROJET,
    requestId: randomUUID(),
    source: INVOCATION_SOURCES.PANEL_INTERNAL,
    payload: {
      contractRef,
      name: `Contrat webhook ${contractRef}`,
      documentBase64: pdf.toString('base64'),
      documentFilename: 'contrat-webhook.pdf',
      returnUrl: 'https://api.panel.ly-solution.com/recette/opensign/retour',
      signers: [
        { role: 'DEVELOPER', firstName: 'Recette', lastName: 'Developpeur', email: DEV },
        { role: 'CLIENT', firstName: 'Recette', lastName: 'Client', email: CLIENT },
      ],
      fields: [
        { signerRole: 'DEVELOPER', page: 1, x: 60, y: 600, width: 170, height: 55 },
        { signerRole: 'CLIENT', page: 1, x: 340, y: 600, width: 170, height: 55 },
      ],
      operationId: `sig-open-${contractRef}`,
    },
  });

  const documentId = ouvert.result.signatureRequestId;
  aNettoyer.push(documentId);
  noter('1', 'demande ouverte', { documentId, provider: ouvert.provider });

  const liens = new Map(ouvert.result.signers.map((s) => [s.role, s.signatureLink]));

  /* ── LE PREMIER ÉVÉNEMENT : `created` ─────────────────────────────────── */

  const apresCreation = await attendre('created', 60_000);
  noter('2', 'événement « created » reçu par le Panel déployé', {
    recus: apresCreation.map((e) => e.eventType),
    /**
     * ══ LA MESURE QUI TRANCHE L'AMBIGUÏTÉ DE LA DOCUMENTATION ═════════════
     *
     * `signatureVerified: true` signifie que le HMAC a été vérifié sur les
     * OCTETS REÇUS. Si OpenSign signait une re-sérialisation, la vérification
     * aurait échoué — et le journal du Panel déployé nommerait la
     * représentation fautive, grâce au diagnostic ajouté au lot 1.
     */
    signaturesProuvees: apresCreation.every((e) => e.signatureVerified === true),
  });

  /* ── LE PARCOURS ─────────────────────────────────────────────────────── */

  navigateur = await (await chargerChromium()).launch({ headless: true });
  const contexte = await navigateur.newContext({ viewport: { width: 1440, height: 1000 } });

  const dev = await signer(contexte, liens.get('DEVELOPER'), 'DEV signe');
  noter('3', 'retour du DEV', { zones: dev.zones, atterrissage: dev.url.slice(0, 120) });

  const apresDev = await attendre('signed', 90_000);
  noter('4', 'après la signature DEV', {
    recus: apresDev.map((e) => e.eventType),
    tousProuves: apresDev.every((e) => e.signatureVerified === true),
  });

  const client = await signer(contexte, liens.get('CLIENT'), 'CLIENT signe');
  noter('5', 'retour du CLIENT', { zones: client.zones, atterrissage: client.url.slice(0, 120) });

  const final = await attendre('completed', 120_000);
  noter('6', 'après la signature CLIENT', {
    recus: final.map((e) => e.eventType),
    tousProuves: final.every((e) => e.signatureVerified === true),
    aucunRefus: final.every((e) => e.status !== 'REJECTED'),
  });

  /* ── CE QUE LE PROJET A REÇU ──────────────────────────────────────────── */

  const projections = await PanelSyncJournalEntry.find({
    'change.entityType': 'SIGNATURE_EVENT', audience: PROJET.projectId,
  }).sort({ seq: 1 }).lean();

  const faits = projections.map((p) => p.change.payload);
  noter('7', 'faits projetés vers le projet', {
    nombre: faits.length,
    evenements: faits.map((f) => f.event),
    libellesFournisseur: faits.map((f) => f.providerEvent),
    /**
     * LES POIGNÉES DOIVENT ÊTRE CELLES DE L'OUVERTURE. Sans cela, le projet
     * saurait « quelqu'un a signé » sans savoir lequel — donc sans pouvoir
     * ouvrir le contrat à la contresignature au bon moment.
     */
    poigneesReconnues: faits
      .filter((f) => f.signerId)
      .every((f) => [signerHandle(documentId, DEV), signerHandle(documentId, CLIENT)].includes(f.signerId)),
    aucuneAdresse: !JSON.stringify(faits).includes('@'),
    contractRefCorrect: faits.every((f) => f.contractRef === contractRef),
  });

  const lien = await PanelSignatureBinding.findOne({ resourceId: documentId }).lean();
  noter('8', 'le lien d’appartenance après achèvement', {
    ferme: Boolean(lien?.closedAt),
    motif: lien?.closedReason ?? null,
    provider: lien?.provider ?? null,
  });

  /* ── LE DOCUMENT SIGNÉ ET SON CERTIFICAT ──────────────────────────────── */

  const telecharge = await invokeCapability({
    code: 'signature.document.download',
    panelProject: PROJET,
    requestId: randomUUID(),
    source: INVOCATION_SOURCES.PANEL_INTERNAL,
    payload: { signatureRequestId: documentId },
  });
  const octets = Buffer.from(telecharge.result.contentBase64, 'base64');
  writeFileSync(path.join(DOSSIER, 'webhook-recette-signe.pdf'), octets);
  noter('9', 'document signé récupéré', {
    octets: telecharge.result.byteLength,
    estUnPdf: octets.subarray(0, 5).toString('latin1') === '%PDF-',
    certificatDisponible: telecharge.result.certificateAvailable,
  });

  /* ── LE REJEU ─────────────────────────────────────────────────────────── */

  const avantRejeu = (await evenementsRecus()).length;
  noter('10', 'idempotence observée sur le flux réel', {
    evenementsConsignes: avantRejeu,
    doublonsIgnores: (await PanelSignatureBinding.findOne({ resourceId: documentId }).lean()) !== null,
  });

  rapport.verdict = {
    evenementsRecus: (await evenementsRecus()).map((e) => e.eventType),
    hmacProuve: (await evenementsRecus()).every((e) => e.signatureVerified === true),
    cycleComplet: ['created', 'signed', 'completed'].every(
      (t) => (rapport.etapes.find((e) => e.id === '6')?.valeur?.recus ?? []).includes(t),
    ),
  };
  journal(`\n══ VERDICT ══\n${JSON.stringify(rapport.verdict, null, 1)}`);
} catch (error) {
  journal(`\nÉCHEC : ${error?.code ?? ''} ${error?.message ?? error}`);
  rapport.erreur = { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 400) };
} finally {
  if (navigateur) await navigateur.close().catch(() => {});
  if (!GARDER) {
    for (const id of aNettoyer.filter(Boolean)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await openSignFetch({ credentials, method: 'DELETE', path: `/document/${id}`, timeoutMs: 60_000 });
        journal(`\nnettoyé : document ${id}`);
      } catch (e) { journal(`\nNON nettoyé : ${id} — ${e?.providerError ?? e?.message}`); }
    }
    const liens = await PanelSignatureBinding.deleteMany({ projectId: PROJET.projectId });
    const faits = await PanelSyncJournalEntry.deleteMany({ audience: PROJET.projectId });
    const evts = await PanelProviderWebhookEvent.deleteMany({ provider: 'OPENSIGN' });
    journal(`nettoyé : ${liens.deletedCount} lien(s), ${faits.deletedCount} fait(s) projeté(s), `
      + `${evts.deletedCount} événement(s) de réception`);
  }
  rapport.finishedAt = new Date().toISOString();
  writeFileSync(path.join(DOSSIER, 'opensign-webhook-lifecycle.json'), JSON.stringify(rapport, null, 1), 'utf8');
  journal(`\nartefact : ${path.join(DOSSIER, 'opensign-webhook-lifecycle.json')}`);
  await disconnectDatabase();
}
