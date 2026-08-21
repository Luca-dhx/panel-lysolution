// RECETTE DE BASCULE SUR LA PILE DÉPLOYÉE — le dernier maillon.
//
// Campagne de migration Yousign → OpenSign, lot 11.
//
//   node tools/opensign/cutoverRecipe.js [--keep] [--headed]
//
// ══ CE QUE CETTE RECETTE PROUVE, ET QU'AUCUNE AUTRE NE POUVAIT ══════════════
//
// Toutes les précédentes s'exécutaient en local. Elles prouvent que le CODE
// fonctionne ; aucune ne prouve que le code DÉPLOYÉ fonctionne — et c'est une
// question différente, parce que le chemin des webhooks ne passe pas par le
// poste de travail.
//
// Le fournisseur n'appelle pas une machine de développement : il appelle
// `https://api.panel.ly-solution.com/webhooks/providers/opensign`. Ce qui reçoit
// l'événement, vérifie sa signature HMAC, le normalise et le consigne, c'est le
// Panel DÉPLOYÉ — un autre processus, une autre release, un autre réseau.
//
// Cette recette mène donc une signature réelle jusqu'à son achèvement, puis va
// lire ce que le Panel déployé en a fait. Si le déploiement avait cassé la
// vérification de signature, la normalisation ou l'idempotence, c'est ici — et
// seulement ici — que ça se verrait.
//
// ══ POURQUOI LES CAPACITÉS SONT APPELÉES EN LOCAL ═══════════════════════════
//
// Elles exigent un projet APPAIRÉ, avec son jeton de pont. Les appeler depuis
// le poste, sur la même base et le même commit que la release, éprouve la même
// chaîne — et laisse la partie qu'on ne peut PAS simuler (la livraison du
// fournisseur vers l'hôte public) suivre son vrai chemin.
//
// ══ SÛRETÉ ═════════════════════════════════════════════════════════════════
//
// PDF généré, identités sur `example.com` (RFC 2606), aucun envoi d'e-mail,
// suppression chez le fournisseur — y compris après échec.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import { connectDatabase, disconnectDatabase } from '../../backend/src/config/db.js';
import { invokeCapability } from '../../backend/src/services/capabilities/capabilityGateway.service.js';
import { INVOCATION_SOURCES } from '../../backend/src/services/capabilities/invocationContext.js';
import PanelSignatureBinding from '../../backend/src/models/PanelSignatureBinding.model.js';
import { openSignFetch } from '../../backend/src/services/integratedApi/opensign/openSignTransport.js';
import { loadOpenSignSandboxCredentials } from './campaignCredentials.js';
import { chargerChromium } from './browser.js';
import { buildFixturePdf, PAGE_SIZES } from './fixturePdf.js';

const requireBackend = createRequire(new URL('../../backend/package.json', import.meta.url));
const mongoose = requireBackend('mongoose');

const GARDER = process.argv.includes('--keep');
const VISIBLE = process.argv.includes('--headed');
const journal = (...a) => console.log(...a);
const DOSSIER = path.resolve(fileURLToPath(new URL('../../.campaign/', import.meta.url)));
mkdirSync(DOSSIER, { recursive: true });

const RACINE_PROJET = path.resolve(
  fileURLToPath(new URL('../../../SB Auto 06/backend/src', import.meta.url)),
);
const sbAuto = async (rel) => import(pathToFileURL(path.join(RACINE_PROJET, rel)).href);

const PROJET = { projectId: 'recette-cutover-deploye', projectName: 'Recette — bascule déployée' };
const appeler = (code, payload) => invokeCapability({
  code, panelProject: PROJET, payload, requestId: randomUUID(), source: INVOCATION_SOURCES.PANEL_INTERNAL,
});

const TAILLE = PAGE_SIZES.A4_PORTRAIT;
const rapport = { startedAt: new Date().toISOString(), etapes: [] };
const aNettoyer = [];
let navigateur = null;

async function etape(id, titre, fn) {
  journal(`\n── ${id} · ${titre}`);
  try {
    const resultat = await fn();
    rapport.etapes.push({ id, titre, ok: true, resultat });
    journal(`   ✓ ${JSON.stringify(resultat).slice(0, 800)}`);
    return resultat;
  } catch (error) {
    const mesure = { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 300) };
    rapport.etapes.push({ id, titre, ok: false, mesure });
    journal(`   ✗ ${JSON.stringify(mesure)}`);
    return null;
  }
}

/** Signer dans un vrai navigateur — le seul geste qu'on ne peut pas simuler. */
async function signer(page, lien, etiquette) {
  const essayer = async (quoi, action) => {
    try { await action(); journal(`   ✓ ${etiquette} · ${quoi}`); }
    catch (e) { journal(`   – ${etiquette} · ${quoi} (${String(e.message).split('\n')[0].slice(0, 60)})`); }
  };
  await page.goto(lien, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: /confirme|confirm|accept|agree/i })
    .first().click({ timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(4000);
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
    try {
      // eslint-disable-next-line no-await-in-loop
      await page.getByRole('button', { name: /oui|yes|confirm|ok|signer|^sign$|^terminé$/i })
        .last().click({ timeout: 6000 });
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(8000);
    } catch { break; }
  }
}

const lienDe = async (demandeId, role) => {
  const lecture = await appeler('signature.request.retrieve', { signatureRequestId: demandeId });
  const cible = lecture.result.signers.find((s) => s.role === role);
  const l = await appeler('signature.signer.retrieve', {
    signatureRequestId: demandeId, signerId: cible.signerId,
  });
  return l.result.signatureLink;
};

await connectDatabase();
const { credentials } = await loadOpenSignSandboxCredentials();
const evenements = mongoose.connection.db.collection('panelproviderwebhookevents');
const liaisons = mongoose.connection.db.collection('panelintegratedapiwebhookbindings');

try {
  journal('\n=== LOT 11 — BASCULE SUR LA PILE DÉPLOYÉE ===');

  /* ── 1. LE PANEL DÉPLOYÉ RÉPOND, ET C'EST LUI QUE LE FOURNISSEUR APPELLE ── */

  const cible = await etape('1', 'la pile déployée est en ligne, et c’est elle qui reçoit', async () => {
    const sante = await fetch('https://panel.ly-solution.com/health', { signal: AbortSignal.timeout(30_000) });
    const corps = await sante.json();
    const liaison = await liaisons.findOne({ provider: 'OPENSIGN', environment: 'TEST' });
    if (!liaison?.desiredUrl?.includes('api.panel.ly-solution.com')) {
      throw new Error(`le webhook ne vise pas la pile déployée : ${liaison?.desiredUrl}`);
    }
    return {
      sante: corps?.data?.status,
      base: corps?.data?.database,
      environnement: corps?.data?.env,
      webhookVise: liaison.desiredUrl,
      etatLiaison: liaison.status,
      dernierEvenementAvant: liaison.lastEventAt ?? null,
    };
  });
  if (!cible) throw new Error('la pile déployée ne répond pas : la recette n’a plus d’objet.');

  const avant = await evenements.countDocuments({ provider: 'OPENSIGN' });
  journal(`   événements OpenSign déjà consignés : ${avant}`);

  /* ── 2. UN CONTRAT SB AUTO, OUVERT PAR LA CAPACITÉ GÉNÉRIQUE ───────────── */

  const { buildSignatureOpenPayload } = await sbAuto('services/signature/signature.service.js');

  const pdf = buildFixturePdf({
    size: TAILLE,
    title: 'RECETTE LOT 11 — BASCULE DÉPLOYÉE',
    landmarksByPage: [[
      { xFromLeft: 70, yFromTop: 600, width: 170, height: 55, label: 'DEVELOPPEUR' },
      { xFromLeft: 330, yFromTop: 600, width: 170, height: 55, label: 'CLIENT' },
    ]],
  });
  const contractRef = `cutover-${Date.now()}`;
  const zone = (x, role) => ({
    id: `z-${role}`, name: `Signature ${role}`, signerRole: role, page: 1, type: 'SIGNATURE',
    xRatio: x / TAILLE.width, yRatio: 600 / TAILLE.height,
    widthRatio: 170 / TAILLE.width, heightRatio: 55 / TAILLE.height,
  });
  const contrat = {
    _id: contractRef,
    reference: `CTR-CUTOVER-${contractRef.slice(-6)}`,
    document: { pageCount: 1, pageSizes: [{ page: 1, width: TAILLE.width, height: TAILLE.height }] },
    signersSnapshot: {
      developer: {
        firstName: 'Recette', lastName: 'Developpeur',
        email: 'dev.recette@example.com', companyName: 'Entreprise de recette',
      },
      client: {
        firstName: 'Recette', lastName: 'Client',
        email: 'client.recette@example.com', companyName: 'Cliente de recette',
      },
    },
    signatureConfiguration: { locked: true, zones: [zone(70, 'DEVELOPER'), zone(330, 'CLIENT')] },
  };
  const payload = buildSignatureOpenPayload(
    contrat, { buffer: pdf, filename: 'contrat-cutover.pdf' },
    'https://manager.recette.example.com/retour-signature',
  );

  const ouvert = await etape('2', 'signature.request.open — charge utile de SB Auto', async () => {
    const r = await appeler('signature.request.open', payload);
    if (r.result?.signatureRequestId) aNettoyer.push(r.result.signatureRequestId);
    return {
      fournisseur: r.result.provider,
      status: r.result.status,
      signatureRequestId: r.result.signatureRequestId,
    };
  });
  const demandeId = ouvert?.signatureRequestId;
  if (!demandeId) throw new Error('ouverture impossible.');

  /* ── 3. LES DEUX SIGNATURES, POUR DE VRAI ──────────────────────────────── */

  navigateur = await (await chargerChromium()).launch({ headless: !VISIBLE });
  const contexte = await navigateur.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await contexte.newPage();

  await etape('3', 'les deux parties signent, dans l’ordre imposé', async () => {
    await signer(page, await lienDe(demandeId, 'DEVELOPER'), 'developpeur');
    await signer(page, await lienDe(demandeId, 'CLIENT'), 'client');
    let lecture = null;
    for (let essai = 0; essai < 10; essai += 1) {
      // eslint-disable-next-line no-await-in-loop
      lecture = await appeler('signature.request.retrieve', { signatureRequestId: demandeId });
      if (lecture.result.state === 'DONE') break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (lecture?.result.state !== 'DONE') throw new Error(`état final ${lecture?.result.state}`);
    return {
      etat: lecture.result.state,
      signataires: lecture.result.signers.map((s) => ({ role: s.role, state: s.state })),
    };
  });

  /* ── 4. LE PANEL DÉPLOYÉ A REÇU, VÉRIFIÉ ET CONSIGNÉ ───────────────────── */

  await etape('4', 'la pile déployée a reçu et vérifié les événements du fournisseur', async () => {
    /**
     * ON ATTEND LA LIVRAISON, ON NE LA PROVOQUE PAS.
     *
     * Rejouer nous-mêmes un événement prouverait que notre code sait traiter ce
     * que NOUS lui donnons. Ce qu'on veut savoir est autre chose : que le
     * fournisseur atteint l'hôte public, que sa signature y est reconnue, et
     * que l'événement y est consigné.
     */
    let recents = [];
    for (let essai = 0; essai < 12; essai += 1) {
      // eslint-disable-next-line no-await-in-loop
      /**
       * `receivedAt` est une CHAÎNE ISO en base, pas une date.
       *
       * Comparé à un objet `Date`, Mongo ne rendrait rien — et l'absence de
       * résultat se lirait « le fournisseur n'a pas atteint la pile déployée »,
       * c'est-à-dire l'inverse exact du fait. Les deux se comparent en ISO,
       * dont l'ordre lexicographique est l'ordre chronologique.
       */
      recents = await evenements.find({
        provider: 'OPENSIGN',
        receivedAt: { $gte: rapport.startedAt },
      }).toArray();
      if (recents.some((e) => /completed/i.test(String(e.eventType ?? e.type ?? '')))) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 10_000));
    }
    if (recents.length === 0) {
      throw new Error('aucun événement consigné : le fournisseur n’a pas atteint la pile déployée');
    }
    const types = recents.map((e) => String(e.eventType ?? e.type ?? '?'));
    return {
      consignes: recents.length,
      types: [...new Set(types)],
      /**
       * `completed` est celui qui compte : c'est lui qui dit « le contrat est
       * signé », et c'est lui qui fait bouger un état métier.
       */
      achevementRecu: types.some((t) => /completed/i.test(t)),
      /** Aucun événement rejeté : la signature HMAC a été reconnue. */
      rejetes: recents.filter((e) => /REJECT/i.test(String(e.outcome ?? ''))).length,
    };
  });

  await etape('5', 'la liaison de webhook porte la trace de cette livraison', async () => {
    const liaison = await liaisons.findOne({ provider: 'OPENSIGN', environment: 'TEST' });
    const avantDate = cible.dernierEvenementAvant ? new Date(cible.dernierEvenementAvant) : null;
    const apresDate = liaison?.lastEventAt ? new Date(liaison.lastEventAt) : null;
    return {
      etat: liaison?.status,
      dernierEvenement: liaison?.lastEventAt ?? null,
      dernierType: liaison?.lastEventType ?? null,
      plusRecentQuAvant: Boolean(apresDate && (!avantDate || apresDate > avantDate)),
      aucuneErreur: !liaison?.lastErrorCode,
    };
  });

  /* ── 6. ET LE FOURNISSEUR RETIRÉ NE SERT TOUJOURS RIEN ─────────────────── */

  await etape('6', 'le fournisseur retiré refuse, même sur la pile à jour', async () => {
    const { RETIRED_SIGNATURE_ADAPTERS } = await import(
      '../../backend/src/services/integratedApi/signature/retiredSignatureProvider.js'
    );
    let refus = null;
    try {
      await RETIRED_SIGNATURE_ADAPTERS['signature.document.download']({
        input: { signatureRequestId: 'ancienne-000001' },
      });
    } catch (e) { refus = e; }
    return {
      motif: refus?.details?.reason ?? null,
      ditOuRegarder: /archivé dans le projet/i.test(String(refus?.message ?? '')),
    };
  });
} catch (error) {
  journal(`\nÉCHEC : ${error?.httpStatus ?? ''} ${error?.providerError ?? error?.message}`);
  rapport.erreur = { message: String(error?.message ?? error), code: error?.code ?? null };
} finally {
  if (navigateur) await navigateur.close().catch(() => {});
  journal(`\n── nettoyage (${aNettoyer.length} document(s), ${GARDER ? 'CONSERVÉS' : 'supprimés'})`);
  if (!GARDER) {
    for (const id of aNettoyer) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await openSignFetch({ credentials, method: 'DELETE', path: `/document/${id}`, timeoutMs: 60_000 });
        journal(`   ✓ document ${id} supprimé chez le fournisseur`);
      } catch (e) { journal(`   ✗ ${id} — ${e?.providerError ?? e?.message}`); }
    }
    const supprimes = await PanelSignatureBinding.deleteMany({ projectId: PROJET.projectId });
    journal(`   ✓ ${supprimes.deletedCount} lien(s) d’appartenance de recette retiré(s)`);
  }

  rapport.finishedAt = new Date().toISOString();
  writeFileSync(path.join(DOSSIER, 'opensign-cutover-recipe.json'), JSON.stringify(rapport, null, 1), 'utf8');
  journal(`\nartefact : ${path.join(DOSSIER, 'opensign-cutover-recipe.json')}`);
  await disconnectDatabase();
}
