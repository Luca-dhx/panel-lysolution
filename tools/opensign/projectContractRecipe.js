// RECETTE RÉELLE DU CONTRAT SB AUTO — LE PAYLOAD DU PROJET, CHEZ LE VRAI FOURNISSEUR.
//
// Campagne de migration Yousign → OpenSign, lot 4.
//
//   node tools/opensign/projectContractRecipe.js [--keep]
//
// ══ CE QU'ELLE PROUVE, ET QUE `capabilityRecipe.js` NE PROUVE PAS ═══════════
//
// La recette du lot 2 construisait sa charge utile À LA MAIN, taillée pour la
// capacité. Elle prouvait que la chaîne du Panel fonctionne — pas que le
// PROJET sait s'en servir.
//
// Celle-ci importe `buildSignatureOpenPayload` DEPUIS SB AUTO et lui donne un
// contrat de la forme exacte qu'il a au moment du clic sur « Signer » : des
// zones en RATIOS posées par l'éditeur, un instantané de signataires, des
// dimensions de page relevées sur le PDF. Puis elle pousse le résultat dans la
// vraie passerelle, jusqu'au vrai bac à sable.
//
// Autrement dit : les deux dépôts sont éprouvés ENSEMBLE, sur le seul point où
// ils se touchent. C'est là que vit la classe d'incident la plus coûteuse —
// deux moitiés justes, un contrat commun faux — et aucun test unitaire, dans
// l'un ou l'autre dépôt, ne peut l'attraper.
//
// ══ LA CONVERSION DES ZONES EST LE CŒUR DU CONTRÔLE ═════════════════════════
//
// L'éditeur stocke `xRatio/yRatio` depuis le HAUT de la page ; le fournisseur
// veut des points depuis le haut lui aussi, mais rien ne l'imposait, et une
// inversion d'axe se lit « la signature est en bas au lieu du haut » — c'est-à-
// dire un contrat signé au mauvais endroit, qu'on ne découvre qu'à la lecture.
//
// La recette recalcule donc la position attendue INDÉPENDAMMENT de
// `mapZoneToField`, et compare. Une conversion qui se vérifierait elle-même ne
// vérifierait rien.
//
// ══ SÛRETÉ ═════════════════════════════════════════════════════════════════
//
// PDF généré, identités sur `example.com` (RFC 2606), aucun envoi d'e-mail,
// suppression systématique chez le fournisseur — y compris après échec.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { connectDatabase, disconnectDatabase } from '../../backend/src/config/db.js';
import { invokeCapability } from '../../backend/src/services/capabilities/capabilityGateway.service.js';
import { INVOCATION_SOURCES } from '../../backend/src/services/capabilities/invocationContext.js';
import PanelSignatureBinding from '../../backend/src/models/PanelSignatureBinding.model.js';
import { getCapabilityDefinition } from '../../backend/src/services/capabilities/capabilityRegistry.js';
import { openSignFetch } from '../../backend/src/services/integratedApi/opensign/openSignTransport.js';
import { loadOpenSignSandboxCredentials } from './campaignCredentials.js';
import { buildFixturePdf, PAGE_SIZES } from './fixturePdf.js';

const GARDER = process.argv.includes('--keep');
const journal = (...a) => console.log(...a);
const DOSSIER = path.resolve(fileURLToPath(new URL('../../.campaign/', import.meta.url)));
mkdirSync(DOSSIER, { recursive: true });

/**
 * LE PROJET EST CHARGÉ DEPUIS SON PROPRE DÉPÔT.
 *
 * On importe le module RÉEL, pas une copie. Si SB Auto change sa construction
 * de charge utile, cette recette le voit à la prochaine exécution ; une copie
 * l'aurait masqué exactement le jour où ça compte.
 */
const RACINE_PROJET = path.resolve(
  fileURLToPath(new URL('../../../SB Auto 06/backend/src', import.meta.url)),
);
const sbAuto = async (rel) => import(pathToFileURL(path.join(RACINE_PROJET, rel)).href);

const PROJET = { projectId: 'recette-sbauto-contrat', projectName: 'Recette SB Auto — contrat' };

const rapport = { startedAt: new Date().toISOString(), etapes: [] };
const aNettoyer = [];

async function etape(id, titre, fn) {
  journal(`\n── ${id} · ${titre}`);
  try {
    const resultat = await fn();
    rapport.etapes.push({ id, titre, ok: true, resultat });
    journal(`   ✓ ${JSON.stringify(resultat).slice(0, 600)}`);
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

const appeler = (code, payload) => invokeCapability({
  code, panelProject: PROJET, payload, requestId: randomUUID(), source: INVOCATION_SOURCES.PANEL_INTERNAL,
});

await connectDatabase();
const { credentials } = await loadOpenSignSandboxCredentials();

try {
  journal('\n=== RECETTE — LE CONTRAT SB AUTO CHEZ OPENSIGN RÉEL ===');

  const { buildSignatureOpenPayload, MAX_DOCUMENT_BYTES, mapRequestStatus } =
    await sbAuto('services/signature/signature.service.js');
  const { validateZones } = await sbAuto('services/signature/signatureCoordinates.js');

  /* ── 0. LE CONTRAT, TEL QU'IL EST AU MOMENT DU CLIC ────────────────────── */

  const taille = PAGE_SIZES.A4_PORTRAIT;
  const pdf = buildFixturePdf({
    size: taille,
    title: 'RECETTE LOT 4 — CONTRAT SB AUTO FICTIF',
    landmarksByPage: [[
      { xFromLeft: 70, yFromTop: 600, width: 170, height: 55, label: 'DEVELOPPEUR' },
      { xFromLeft: 330, yFromTop: 600, width: 170, height: 55, label: 'CLIENT' },
    ]],
  });

  /**
   * LES ZONES SONT EN RATIOS, comme l'éditeur les enregistre.
   *
   * Elles sont DÉDUITES des repères dessinés dans le PDF : c'est ce qui permet
   * de comparer, à la fin, ce que le fournisseur a placé avec ce que le
   * document annonce. Poser des ratios ronds aurait été plus lisible et n'aurait
   * rien prouvé.
   */
  const enRatio = (l) => ({
    xRatio: l.xFromLeft / taille.width,
    yRatio: l.yFromTop / taille.height,
    widthRatio: l.width / taille.width,
    heightRatio: l.height / taille.height,
  });
  const reperes = [
    { xFromLeft: 70, yFromTop: 600, width: 170, height: 55, signerRole: 'DEVELOPER' },
    { xFromLeft: 330, yFromTop: 600, width: 170, height: 55, signerRole: 'CLIENT' },
  ];

  const contractRef = `sbauto-lot4-${Date.now()}`;
  const contrat = {
    _id: contractRef,
    reference: `CTR-RECETTE-${contractRef.slice(-6)}`,
    document: { pageSizes: [{ page: 1, width: taille.width, height: taille.height }], pageCount: 1 },
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
    signatureConfiguration: {
      locked: true,
      zones: reperes.map((l, i) => ({
        id: `z-${i}`, name: `Signature ${l.signerRole}`, signerRole: l.signerRole,
        page: 1, type: 'SIGNATURE', ...enRatio(l),
      })),
    },
  };

  await etape('0', 'les zones du contrat sont valides pour le projet', async () => {
    const erreurs = validateZones(contrat.signatureConfiguration.zones, { pageCount: 1 });
    if (erreurs.length) throw new Error(`zones refusées : ${erreurs.join(' | ')}`);
    return { zones: contrat.signatureConfiguration.zones.length, erreurs: 0 };
  });

  /* ── 1. LE PROJET CONSTRUIT SA CHARGE UTILE ────────────────────────────── */

  const RETOUR = 'https://manager.recette.example.com/retour-signature';
  const payload = await etape('1', 'SB Auto construit la charge utile (aucun réseau)', async () => {
    const p = buildSignatureOpenPayload(
      contrat, { buffer: pdf, filename: 'contrat-recette.pdf' }, RETOUR,
    );
    return {
      cles: Object.keys(p).sort(),
      octetsDocument: pdf.length,
      sousLaLimiteLocale: pdf.length <= MAX_DOCUMENT_BYTES,
      signataires: p.signers.map((s) => s.role),
      champs: p.fields.map((f) => ({ role: f.signerRole, page: f.page, x: f.x, y: f.y, w: f.width, h: f.height })),
      adresseDeRetour: p.returnUrl,
      /** Un seul retour pour tout le document : aucun signataire n'en porte. */
      aucunRetourParSignataire: p.signers.every((s) => s.returnUrl === undefined && s.redirectUrls === undefined),
    };
  }).then(() => buildSignatureOpenPayload(
    contrat, { buffer: pdf, filename: 'contrat-recette.pdf' }, RETOUR,
  ));

  /* ── 2. LE CONTRAT DE CAPACITÉ ACCEPTE CETTE CHARGE ────────────────────── */

  await etape('2', 'le schéma d’entrée du Panel accepte la charge du projet', async () => {
    const def = getCapabilityDefinition('signature.request.open');
    const verdict = def.inputSchema.safeParse(payload);
    if (!verdict.success) {
      throw new Error(verdict.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | '));
    }
    return { capacite: def.code, fournisseur: def.provider, valide: true };
  });

  /**
   * LA CONVERSION, REFAITE À LA MAIN.
   *
   * On ne relit pas `mapZoneToField` : on recalcule depuis le repère dessiné,
   * et on compare. Une tolérance d'un point absorbe l'arrondi, pas une
   * inversion d'axe — qui vaudrait ici plus de 500 points.
   */
  await etape('3', 'les zones tombent où le document les annonce', async () => {
    const ecarts = reperes.map((l) => {
      const f = payload.fields.find((c) => c.signerRole === l.signerRole);
      return {
        role: l.signerRole,
        dx: Math.abs(f.x - l.xFromLeft),
        dy: Math.abs(f.y - l.yFromTop),
        dw: Math.abs(f.width - l.width),
        dh: Math.abs(f.height - l.height),
      };
    });
    const pire = Math.max(...ecarts.flatMap((e) => [e.dx, e.dy, e.dw, e.dh]));
    if (pire > 1) throw new Error(`écart de ${pire} point(s) — la conversion ne tombe pas juste`);
    return { ecarts, ecartMaximalEnPoints: pire, origine: 'coin HAUT-GAUCHE, confirmée' };
  });

  /* ── 4. OUVRIR CHEZ LE VRAI FOURNISSEUR ────────────────────────────────── */

  const ouvert = await etape('4', 'signature.request.open — OpenSign réel', async () => {
    const r = await appeler('signature.request.open', payload);
    if (r.result?.signatureRequestId) aNettoyer.push(r.result.signatureRequestId);
    return {
      fournisseur: r.result.provider,
      status: r.result.status,
      signatureRequestId: r.result.signatureRequestId,
      documentId: r.result.documentId,
      signataires: r.result.signers.map((s) => ({
        role: s.role, poigneeLongueur: s.signerId.length, lienRendu: Boolean(s.signatureLink),
      })),
    };
  });

  const demandeId = ouvert?.signatureRequestId;
  if (!demandeId) throw new Error('Ouverture impossible : le reste de la recette n’a plus d’objet.');

  /* ── 5. LE PROJET SAIT RELIRE CE QU'IL A OUVERT ────────────────────────── */

  await etape('5', 'le projet traduit l’état rendu en statut contractuel', async () => {
    const r = await appeler('signature.request.retrieve', { signatureRequestId: demandeId });
    const traduit = mapRequestStatus(r.result.state);
    if (traduit === 'NONE') {
      throw new Error(`état « ${r.result.state} » non traduit par le projet — il retomberait à NONE`);
    }
    return {
      etatRenduParLePanel: r.result.state,
      statutContractuel: traduit,
      signataires: r.result.signers.map((s) => ({ role: s.role, state: s.state })),
    };
  });

  /* ── 6. LE DOCUMENT DÉPOSÉ EST BIEN CELUI DU CONTRAT ───────────────────── */

  await etape('6', 'le document chez le fournisseur est celui que le projet a envoyé', async () => {
    const r = await appeler('signature.document.download', { signatureRequestId: demandeId });
    const octets = Buffer.from(r.result.contentBase64, 'base64');
    return {
      estUnPdf: octets.subarray(0, 5).toString('latin1') === '%PDF-',
      octetsRendus: r.result.byteLength,
      octetsEnvoyes: pdf.length,
      certificatDisponible: r.result.certificateAvailable,
    };
  });

  /* ── 7. LA RÈGLE D'IDEMPOTENCE DU PROJET TIENT CHEZ LE FOURNISSEUR ─────── */

  await etape('7', 'deux clics « Signer » — une seule demande, un seul crédit', async () => {
    const r = await appeler('signature.request.open', payload);
    return {
      status: r.result.status,
      memeDemande: r.result.signatureRequestId === demandeId,
      demandesVivantes: await PanelSignatureBinding.countDocuments({
        projectId: PROJET.projectId, contractRef: String(contrat._id), closedAt: null,
      }),
    };
  });

  /* ── 8. RELANCE APRÈS ANNULATION ───────────────────────────────────────── */

  await etape('8', 'annuler puis rouvrir — le parcours de relance du projet', async () => {
    await appeler('signature.request.cancel', {
      signatureRequestId: demandeId,
      reason: 'Recette de campagne — annulation mesurée.',
      operationId: `sig-cancel-${demandeId}`,
    });
    const vivantesApresAnnulation = await PanelSignatureBinding.countDocuments({
      projectId: PROJET.projectId, contractRef: String(contrat._id), closedAt: null,
    });

    /**
     * LA RELANCE RÉUTILISE LA MÊME CLÉ D'OPÉRATION — ET C'EST LE POINT.
     *
     * SB Auto dérive sa clé du contrat (`sig-open-<id>`) : elle est stable
     * exprès, pour que deux clics convergent. Après une annulation, il RENVOIE
     * LA MÊME. Si la réservation d'opération rendait alors le résultat
     * mémorisé, le projet recevrait l'identifiant d'une demande révoquée, et
     * le contrat serait bloqué pour toujours — sans erreur, avec un lien mort.
     *
     * Lui en donner une autre ici aurait éprouvé un parcours que personne ne
     * suit. On envoie donc EXACTEMENT ce que le projet envoie.
     */
    const relance = await appeler('signature.request.open', payload);
    if (relance.result?.signatureRequestId) aNettoyer.push(relance.result.signatureRequestId);
    return {
      vivantesApresAnnulation,
      relanceOuverte: relance.result.status,
      autreDemande: relance.result.signatureRequestId !== demandeId,
    };
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
    const supprimes = await PanelSignatureBinding.deleteMany({ projectId: PROJET.projectId });
    journal(`   ✓ ${supprimes.deletedCount} lien(s) d’appartenance de recette retiré(s)`);
  }

  rapport.finishedAt = new Date().toISOString();
  writeFileSync(path.join(DOSSIER, 'opensign-project-contract-recipe.json'), JSON.stringify(rapport, null, 1), 'utf8');
  journal(`\nartefact : ${path.join(DOSSIER, 'opensign-project-contract-recipe.json')}`);
  await disconnectDatabase();
}
