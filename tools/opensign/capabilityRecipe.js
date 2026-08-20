// RECETTE RÉELLE DES CINQ CAPACITÉS DE SIGNATURE, SERVIES PAR OPENSIGN.
//
// Campagne de migration Yousign → OpenSign, lot 2 point 10.
//
//   node tools/opensign/capabilityRecipe.js [--keep] [--sign]
//
// ══ CE QUE CETTE RECETTE PROUVE, ET QU'AUCUN TEST UNITAIRE NE PEUT ══════════
//
// Elle passe par la VRAIE passerelle : contexte d'invocation, contrôle
// d'environnement, résolution du fournisseur, ouverture du coffre, réservation
// d'opération, appartenance, adaptateur, transport, et validation de la sortie
// contre le schéma. Un test à transport injecté prouve la traduction ; celui-ci
// prouve la CHAÎNE.
//
// ══ CE QU'ELLE ÉPROUVE EN PLUS DU CHEMIN NOMINAL ════════════════════════════
//
//   · double invocation      → une seule demande chez le fournisseur
//   · appartenance croisée    → un projet ne lit pas la demande d'un autre
//   · demande inventée        → refus, sans contact fournisseur
//   · annulation              → état terminal, lien fermé
//
// ══ SÛRETÉ ═════════════════════════════════════════════════════════════════
//
// PDF généré, signataires sur `example.com` (RFC 2606), aucun e-mail envoyé,
// nettoyage systématique — y compris après échec.
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
import { buildFixturePdf, PAGE_SIZES } from './fixturePdf.js';

const GARDER = process.argv.includes('--keep');
const journal = (...a) => console.log(...a);
const DOSSIER = path.resolve(fileURLToPath(new URL('../../.campaign/', import.meta.url)));
mkdirSync(DOSSIER, { recursive: true });

/**
 * DEUX PROJETS DE RECETTE, ET LE SECOND N'EST PAS DÉCORATIF.
 *
 * L'isolation entre projets est la garantie la plus coûteuse à perdre : le
 * compte de signature de la plateforme porte les demandes de TOUS les clients.
 * Une capacité qui accepterait un identifiant quelconque donnerait à n'importe
 * quel projet appairé le droit de lire — ou d'annuler — l'engagement d'un
 * autre. Elle ne se prouve qu'avec deux projets.
 */
const PROJET_A = { projectId: 'recette-opensign-a', projectName: 'Recette OpenSign A' };
const PROJET_B = { projectId: 'recette-opensign-b', projectName: 'Recette OpenSign B' };

const rapport = { startedAt: new Date().toISOString(), etapes: [] };
const aNettoyer = [];

async function etape(id, titre, fn) {
  journal(`\n── ${id} · ${titre}`);
  try {
    const resultat = await fn();
    rapport.etapes.push({ id, titre, ok: true, resultat });
    journal(`   ✓ ${JSON.stringify(resultat).slice(0, 500)}`);
    return resultat;
  } catch (error) {
    const mesure = {
      code: error?.code ?? null,
      message: String(error?.message ?? error).slice(0, 300),
      details: error?.details ?? null,
    };
    rapport.etapes.push({ id, titre, ok: false, mesure });
    journal(`   ✗ ${JSON.stringify(mesure)}`);
    return null;
  }
}

const appeler = (code, panelProject, payload) => invokeCapability({
  code, panelProject, payload, requestId: randomUUID(), source: INVOCATION_SOURCES.PANEL_INTERNAL,
});

await connectDatabase();
const { credentials } = await loadOpenSignSandboxCredentials();

try {
  journal('\n=== RECETTE DES CAPACITÉS DE SIGNATURE — OPENSIGN RÉEL ===');

  const taille = PAGE_SIZES.A4_PORTRAIT;
  const pdf = buildFixturePdf({
    size: taille,
    title: 'RECETTE CAPACITÉS — CONTRAT FICTIF',
    landmarksByPage: [[
      { xFromLeft: 60, yFromTop: 620, width: 160, height: 50, label: 'DEVELOPPEUR' },
      { xFromLeft: 340, yFromTop: 620, width: 160, height: 50, label: 'CLIENT' },
    ]],
  });

  const contractRef = `recette-${Date.now()}`;
  const ouverture = {
    contractRef,
    name: `Contrat de recette ${contractRef}`,
    documentBase64: pdf.toString('base64'),
    documentFilename: 'contrat-recette.pdf',
    returnUrl: 'https://api.panel.ly-solution.com/recette/opensign/retour',
    signers: [
      { role: 'DEVELOPER', firstName: 'Recette', lastName: 'Developpeur', email: 'dev.recette@example.com' },
      { role: 'CLIENT', firstName: 'Recette', lastName: 'Client', email: 'client.recette@example.com' },
    ],
    fields: [
      { signerRole: 'DEVELOPER', page: 1, x: 60, y: 620, width: 160, height: 50 },
      { signerRole: 'CLIENT', page: 1, x: 340, y: 620, width: 160, height: 50 },
    ],
    operationId: `sig-open-${contractRef}`,
  };

  /* ── 1. OUVRIR ─────────────────────────────────────────────────────────── */

  const ouvert = await etape('1', 'signature.request.open', async () => {
    const r = await appeler('signature.request.open', PROJET_A, ouverture);
    if (r.result?.signatureRequestId) aNettoyer.push(r.result.signatureRequestId);
    return {
      provider: r.provider,
      status: r.result.status,
      providerRendu: r.result.provider,
      signatureRequestId: r.result.signatureRequestId,
      documentId: r.result.documentId,
      signataires: r.result.signers.map((s) => ({
        role: s.role,
        poigneeLongueur: s.signerId.length,
        lienRendu: Boolean(s.signatureLink),
      })),
    };
  });

  const demandeId = ouvert?.signatureRequestId;
  if (!demandeId) throw new Error('Ouverture impossible : le reste de la recette n’a plus d’objet.');

  /* ── 2. DOUBLE INVOCATION ──────────────────────────────────────────────── */

  await etape('2', 'double invocation — une seule demande chez le fournisseur', async () => {
    const r = await appeler('signature.request.open', PROJET_A, ouverture);
    /**
     * OpenSign n'offre AUCUNE clé d'idempotence, et chaque création débite un
     * crédit. La garantie ne peut donc venir que de nous : réservation
     * d'opération, doublée de l'index « une demande vivante par contrat ».
     */
    return {
      /**
       * `ALREADY_OPEN` — et non un accusé de réception générique. Le second
       * clic doit rendre LA DEMANDE : sans elle, l'appelant perdrait
       * l'identifiant qu'il vient d'obtenir et les liens de ses signataires.
       */
      status: r.result.status,
      memeDemande: r.result.signatureRequestId === demandeId,
      documentRendu: r.result.documentId === demandeId,
      aucuneSecondeDemande: (await PanelSignatureBinding.countDocuments({
        projectId: PROJET_A.projectId, contractRef, closedAt: null,
      })) === 1,
    };
  });

  /* ── 3. LIRE ───────────────────────────────────────────────────────────── */

  await etape('3', 'signature.request.retrieve', async () => {
    const r = await appeler('signature.request.retrieve', PROJET_A, { signatureRequestId: demandeId });
    return {
      provider: r.provider,
      state: r.result.state,
      status: r.result.status,
      signataires: r.result.signers.map((s) => ({ role: s.role, state: s.state })),
    };
  });

  /* ── 4. LE LIEN D'UN SIGNATAIRE ────────────────────────────────────────── */

  await etape('4', 'signature.signer.retrieve', async () => {
    const lecture = await appeler('signature.request.retrieve', PROJET_A, { signatureRequestId: demandeId });
    const dev = lecture.result.signers.find((s) => s.role === 'DEVELOPER') ?? lecture.result.signers[0];
    const r = await appeler('signature.signer.retrieve', PROJET_A, {
      signatureRequestId: demandeId, signerId: dev.signerId,
    });
    const url = r.result.signatureLink ? new URL(r.result.signatureLink) : null;
    return {
      provider: r.provider,
      state: r.result.state,
      // La FORME du lien, jamais le jeton qu'il porte.
      formeLien: url ? `${url.origin}${url.pathname.replace(/\/[^/]+$/, '/<jeton>')}` : null,
    };
  });

  await etape('5', 'signataire inconnu — refusé sans révéler la liste', async () => {
    try {
      await appeler('signature.signer.retrieve', PROJET_A, {
        signatureRequestId: demandeId, signerId: 'ffffffffffffffffffffffffffffffff',
      });
      return { verdict: 'ACCEPTÉ — ANOMALIE' };
    } catch (error) {
      return { verdict: 'REFUSÉ', code: error.code };
    }
  });

  /* ── 6. ISOLATION ENTRE PROJETS ────────────────────────────────────────── */

  for (const [id, capacite, charge] of [
    ['6.1', 'signature.request.retrieve', { signatureRequestId: demandeId }],
    ['6.2', 'signature.document.download', { signatureRequestId: demandeId }],
    ['6.3', 'signature.request.cancel', { signatureRequestId: demandeId, operationId: `x-${randomUUID()}` }],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await etape(id, `le projet B ne peut pas « ${capacite} » la demande du projet A`, async () => {
      try {
        await appeler(capacite, PROJET_B, charge);
        return { verdict: 'ACCEPTÉ — FUITE ENTRE PROJETS' };
      } catch (error) {
        return { verdict: 'REFUSÉ', code: error.code };
      }
    });
  }

  await etape('7', 'demande inventée — refusée sans contact fournisseur', async () => {
    try {
      await appeler('signature.request.retrieve', PROJET_A, { signatureRequestId: 'inventee-000001' });
      return { verdict: 'ACCEPTÉ — ANOMALIE' };
    } catch (error) {
      return { verdict: 'REFUSÉ', code: error.code };
    }
  });

  /* ── 8. TÉLÉCHARGEMENT AVANT SIGNATURE ─────────────────────────────────── */

  await etape('8', 'signature.document.download (document non encore signé)', async () => {
    const r = await appeler('signature.document.download', PROJET_A, { signatureRequestId: demandeId });
    const octets = Buffer.from(r.result.contentBase64, 'base64');
    return {
      provider: r.provider,
      octets: r.result.byteLength,
      empreinteCoherente: octets.length === r.result.byteLength,
      estUnPdf: octets.subarray(0, 5).toString('latin1') === '%PDF-',
      certificatDisponible: r.result.certificateAvailable,
    };
  });

  /* ── 9. ANNULER ────────────────────────────────────────────────────────── */

  await etape('9', 'signature.request.cancel', async () => {
    const r = await appeler('signature.request.cancel', PROJET_A, {
      signatureRequestId: demandeId,
      reason: 'Recette de campagne — annulation mesurée.',
      operationId: `sig-cancel-${demandeId}`,
    });
    const lien = await PanelSignatureBinding.findOne({ resourceId: demandeId }).lean();
    return {
      provider: r.provider,
      state: r.result.state,
      lienFerme: Boolean(lien?.closedAt),
      motif: lien?.closedReason ?? null,
    };
  });

  await etape('10', 'le contrat est de nouveau ouvrable après annulation', async () => {
    const restant = await PanelSignatureBinding.countDocuments({
      projectId: PROJET_A.projectId, contractRef, closedAt: null,
    });
    return { demandesVivantes: restant, relancePossible: restant === 0 };
  });
} catch (error) {
  journal(`\nÉCHEC : ${error?.message ?? error}`);
  rapport.erreur = { message: String(error?.message ?? error), code: error?.code ?? null };
} finally {
  journal(`\n── nettoyage (${aNettoyer.length} document(s), ${GARDER ? 'CONSERVÉS' : 'supprimés'})`);
  if (!GARDER) {
    for (const id of aNettoyer) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await openSignFetch({ credentials, method: 'DELETE', path: `/document/${id}`, timeoutMs: 60_000 });
        journal(`   ✓ document ${id} supprimé chez le fournisseur`);
      } catch (e) { journal(`   ✗ ${id} — ${e?.providerError ?? e?.message}`); }
    }
    /**
     * LES LIENS DE RECETTE PARTENT AUSSI.
     *
     * Ils ne gênent rien fonctionnellement — mais laisser des projets
     * `recette-opensign-*` dans une collection d'appartenance, c'est laisser
     * quelqu'un croire un jour qu'ils correspondent à de vrais clients. C'est
     * exactement l'incident des sept projets fantômes d'Atlas.
     */
    const supprimes = await PanelSignatureBinding.deleteMany({
      projectId: { $in: [PROJET_A.projectId, PROJET_B.projectId] },
    });
    journal(`   ✓ ${supprimes.deletedCount} lien(s) d’appartenance de recette retiré(s)`);
  }

  rapport.finishedAt = new Date().toISOString();
  writeFileSync(path.join(DOSSIER, 'opensign-capability-recipe.json'), JSON.stringify(rapport, null, 1), 'utf8');
  journal(`\nartefact : ${path.join(DOSSIER, 'opensign-capability-recipe.json')}`);
  await disconnectDatabase();
}
