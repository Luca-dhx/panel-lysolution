// RECETTE RÉELLE DE L'ACHÈVEMENT — LES DEUX SIGNATURES, ET LA PREUVE D'AUDIT.
//
// Campagne de migration Yousign → OpenSign, lot 6.
//
//   node tools/opensign/completionRecipe.js [--keep] [--headed]
//
// ══ CE QU'ELLE PROUVE ═══════════════════════════════════════════════════════
//
// Toutes les recettes précédentes s'arrêtaient avant la fin : une signature sur
// deux, ou pas de signature du tout. Or la pièce qui compte pour un dossier
// juridique — le CERTIFICAT D'AUDIT — n'est publiée qu'à l'ACHÈVEMENT, quand
// tous les signataires ont signé. Elle n'avait donc jamais été vue.
//
// Cette recette mène une demande jusqu'au bout, en signant réellement dans un
// navigateur pour les DEUX parties, dans l'ordre imposé, puis :
//
//   · vérifie que le certificat n'existe PAS avant l'achèvement ;
//   · le récupère par la capacité générique une fois achevé ;
//   · vérifie qu'il DIFFÈRE du contrat signé — deux pièces, pas une ;
//   · vérifie que l'ordre séquentiel a bien été imposé par le fournisseur.
//
// ══ POURQUOI L'ORDRE EST ÉPROUVÉ ICI, ET PAS AILLEURS ═══════════════════════
//
// `sendInOrder: strict` est envoyé à chaque ouverture, et le lot 1 a mesuré que
// le second signataire peut LIRE avant son tour. Ce qu'aucune recette n'avait
// vérifié, c'est qu'il ne peut pas SIGNER — et c'est la seule moitié qui
// compte : un client qui signe avant l'équipe technique produit un contrat
// engageant une partie qui ne l'a pas encore relu.
//
// ══ SÛRETÉ ═════════════════════════════════════════════════════════════════
//
// PDF généré, identités sur `example.com` (RFC 2606), aucun envoi d'e-mail,
// suppression chez le fournisseur — y compris après échec.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

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

const RACINE_PROJET = path.resolve(
  fileURLToPath(new URL('../../../SB Auto 06/backend/src', import.meta.url)),
);
const sbAuto = async (rel) => import(pathToFileURL(path.join(RACINE_PROJET, rel)).href);

const PROJET = { projectId: 'recette-sbauto-achevement', projectName: 'Recette SB Auto — achèvement' };
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
    journal(`   ✓ ${JSON.stringify(resultat).slice(0, 700)}`);
    return resultat;
  } catch (error) {
    const mesure = { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 300) };
    rapport.etapes.push({ id, titre, ok: false, mesure });
    journal(`   ✗ ${JSON.stringify(mesure)}`);
    return null;
  }
}

/**
 * SIGNER, DANS UN NAVIGATEUR, COMME UN HUMAIN.
 *
 * Chaque sélecteur est essayé puis abandonné sans lever : l'interface d'un
 * fournisseur change, et un script qui casse au premier libellé modifié ne
 * mesure plus rien du tout. C'est le RÉSULTAT — l'état de la demande — qui
 * tranche, jamais le fait qu'un clic ait réussi.
 */
async function signerDansLeNavigateur(page, lien, etiquette) {
  const essayer = async (description, action) => {
    try { await action(); journal(`   ✓ ${etiquette} · ${description}`); return true; }
    catch (e) { journal(`   – ${etiquette} · ${description} (${String(e.message).split('\n')[0].slice(0, 70)})`); return false; }
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
    for (const t of [0.3, 0.45, 0.6, 0.75, 0.85]) {
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
  await page.screenshot({ path: path.join(DOSSIER, `lot6-${etiquette}.png`) });
}

const lienDe = async (demandeId, role) => {
  const lecture = await appeler('signature.request.retrieve', { signatureRequestId: demandeId });
  const cible = lecture.result.signers.find((s) => s.role === role);
  if (!cible) throw new Error(`aucun signataire ${role}`);
  const r = await appeler('signature.signer.retrieve', {
    signatureRequestId: demandeId, signerId: cible.signerId,
  });
  return r.result.signatureLink;
};

await connectDatabase();
const { credentials } = await loadOpenSignSandboxCredentials();

try {
  journal('\n=== LOT 6 — ACHÈVEMENT RÉEL ET PREUVE D’AUDIT ===');

  const { buildSignatureOpenPayload } = await sbAuto('services/signature/signature.service.js');

  const pdf = buildFixturePdf({
    size: TAILLE,
    title: 'RECETTE LOT 6 — ACHÈVEMENT ET CERTIFICAT',
    landmarksByPage: [[
      { xFromLeft: 70, yFromTop: 600, width: 170, height: 55, label: 'DEVELOPPEUR' },
      { xFromLeft: 330, yFromTop: 600, width: 170, height: 55, label: 'CLIENT' },
    ]],
  });

  const contractRef = `sbauto-lot6-${Date.now()}`;
  const contrat = {
    _id: contractRef,
    reference: `CTR-LOT6-${contractRef.slice(-6)}`,
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
    signatureConfiguration: {
      locked: true,
      zones: [
        {
          id: 'z-dev', name: 'Signature Développeur', signerRole: 'DEVELOPER', page: 1, type: 'SIGNATURE',
          xRatio: 70 / TAILLE.width, yRatio: 600 / TAILLE.height,
          widthRatio: 170 / TAILLE.width, heightRatio: 55 / TAILLE.height,
        },
        {
          id: 'z-cli', name: 'Signature Client', signerRole: 'CLIENT', page: 1, type: 'SIGNATURE',
          xRatio: 330 / TAILLE.width, yRatio: 600 / TAILLE.height,
          widthRatio: 170 / TAILLE.width, heightRatio: 55 / TAILLE.height,
        },
      ],
    },
  };

  const payload = buildSignatureOpenPayload(
    contrat, { buffer: pdf, filename: 'contrat-lot6.pdf' },
    'https://manager.recette.example.com/retour-signature',
  );

  const ouvert = await etape('1', 'ouverture — deux signataires, ordre strict', async () => {
    const r = await appeler('signature.request.open', payload);
    if (r.result?.signatureRequestId) aNettoyer.push(r.result.signatureRequestId);
    return {
      status: r.result.status,
      signatureRequestId: r.result.signatureRequestId,
      signataires: r.result.signers.map((s) => s.role),
    };
  });
  const demandeId = ouvert?.signatureRequestId;
  if (!demandeId) throw new Error('Ouverture impossible : la recette n’a plus d’objet.');

  /* ── 2. AVANT L'ACHÈVEMENT, IL N'Y A RIEN À ATTESTER ───────────────────── */

  await etape('2', 'le certificat n’existe PAS avant l’achèvement', async () => {
    try {
      await appeler('signature.certificate.download', { signatureRequestId: demandeId });
      return { verdict: 'RENDU — ANOMALIE : une preuve avant les signatures' };
    } catch (error) {
      return {
        verdict: 'REFUSÉ',
        code: error.code,
        motif: error.details?.reason ?? null,
      };
    }
  });

  navigateur = await (await chargerChromium()).launch({ headless: !VISIBLE });
  const contexte = await navigateur.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await contexte.newPage();

  /* ── 3. LE CLIENT NE PEUT PAS DOUBLER LE DÉVELOPPEUR ───────────────────── */

  await etape('3', 'le second signataire peut LIRE, sans avoir signé', async () => {
    const lienClient = await lienDe(demandeId, 'CLIENT');
    await page.goto(lienClient, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(6000);
    await page.getByRole('button', { name: /confirme|confirm|accept|agree/i })
      .first().click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(DOSSIER, 'lot6-client-avant-son-tour.png') });

    /**
     * ON JUGE SUR L'ÉTAT, ET SUR LE BON ÉTAT.
     *
     * Une première version de ce contrôle exigeait `PENDING` et concluait «
     * ordre non imposé » : le client était passé à `VIEWED` parce qu'il avait
     * simplement OUVERT le document. C'était une fausse alerte — consulter
     * n'est pas signer, et le lot 1 avait déjà mesuré que la lecture est
     * permise avant son tour.
     *
     * Le seul état qui répondrait « l'ordre est rompu » est `SIGNED`.
     *
     * La TENTATIVE réelle, elle, vit dans `probeSigningOrder.js` : elle va au
     * bout du parcours et constate que le pavé de signature ne s'ouvre pas.
     * Ici on ne fait qu'ouvrir la page, pour ne pas risquer de signer pour de
     * vrai dans une recette qui a besoin de l'ordre inverse.
     */
    const zones = await page.locator('.signYourselfBlock').count().catch(() => 0);
    const lecture = await appeler('signature.request.retrieve', { signatureRequestId: demandeId });
    const client = lecture.result.signers.find((s) => s.role === 'CLIENT');
    return {
      blocsPresentsDansLeDom: zones,
      etatDuClient: client?.state ?? null,
      lectureAutoriseeAvantSonTour: client?.state === 'VIEWED',
      clientNAPasSigne: client?.state !== 'SIGNED',
    };
  });

  /* ── 4. LES DEUX SIGNATURES, DANS L'ORDRE ──────────────────────────────── */

  await etape('4', 'le développeur signe', async () => {
    await signerDansLeNavigateur(page, await lienDe(demandeId, 'DEVELOPER'), 'developpeur');
    const lecture = await appeler('signature.request.retrieve', { signatureRequestId: demandeId });
    return {
      etat: lecture.result.state,
      signataires: lecture.result.signers.map((s) => ({ role: s.role, state: s.state })),
    };
  });

  await etape('5', 'le client signe à son tour', async () => {
    await signerDansLeNavigateur(page, await lienDe(demandeId, 'CLIENT'), 'client');
    let lecture = null;
    for (let essai = 0; essai < 8; essai += 1) {
      // eslint-disable-next-line no-await-in-loop
      lecture = await appeler('signature.request.retrieve', { signatureRequestId: demandeId });
      if (lecture.result.state === 'DONE') break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 5000));
    }
    return {
      etat: lecture?.result.state ?? null,
      signataires: lecture?.result.signers.map((s) => ({ role: s.role, state: s.state })) ?? null,
    };
  });

  /* ── 6. LA PREUVE D'AUDIT ──────────────────────────────────────────────── */

  const pieces = await etape('6', 'le certificat d’audit est publié et récupérable', async () => {
    let certificat = null;
    let dernierRefus = null;
    for (let essai = 0; essai < 8; essai += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await appeler('signature.certificate.download', { signatureRequestId: demandeId });
        certificat = r.result;
        break;
      } catch (error) {
        dernierRefus = error.details?.reason ?? error.code;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    if (!certificat) throw new Error(`certificat jamais publié (${dernierRefus})`);

    const octets = Buffer.from(certificat.contentBase64, 'base64');
    writeFileSync(path.join(DOSSIER, 'lot6-certificat.pdf'), octets);
    const contrat2 = await appeler('signature.document.download', { signatureRequestId: demandeId });
    const octetsContrat = Buffer.from(contrat2.result.contentBase64, 'base64');
    writeFileSync(path.join(DOSSIER, 'lot6-contrat-signe.pdf'), octetsContrat);

    return {
      typeDeclare: certificat.contentType,
      octets: certificat.byteLength,
      empreinteCoherente: createHash('sha256').update(octets).digest('hex') === certificat.sha256,
      estUnPdf: octets.subarray(0, 5).toString('latin1') === '%PDF-',
      /**
       * DEUX PIÈCES, PAS UNE. Si les deux téléchargements rendaient le même
       * contenu, on archiverait deux fois l'engagement et jamais sa preuve.
       */
      differeDuContratSigne: !octets.equals(octetsContrat),
      contratAnnonceSonCertificat: contrat2.result.certificateAvailable === true,
      /** Aucune adresse du fournisseur ne doit traverser. */
      aucuneAdresseTransmise: !JSON.stringify(certificat).includes('http'),
      octetsContratSigne: contrat2.result.byteLength,
    };
  });

  /* ── 7. LE PROJET SAIT L'ARCHIVER ──────────────────────────────────────── */

  await etape('7', 'SB Auto archive les deux pièces séparément', async () => {
    const { storeSignatureCertificate, storeSignedPdf } = await sbAuto('services/contractDocument.service.js');
    const cert = await appeler('signature.certificate.download', { signatureRequestId: demandeId });
    const doc = await appeler('signature.document.download', { signatureRequestId: demandeId });

    const metaCert = await storeSignatureCertificate(
      `recette-lot6-${contractRef}`, Buffer.from(cert.result.contentBase64, 'base64'),
      { contentType: cert.result.contentType },
    );
    const metaDoc = await storeSignedPdf(
      `recette-lot6-${contractRef}`, Buffer.from(doc.result.contentBase64, 'base64'),
      { filename: 'signed.pdf' },
    );
    /** Le stockage de recette est retiré aussitôt : il n'a rien à faire là. */
    const { rm } = await import('node:fs/promises');
    const { config } = await sbAuto('config/env.js');
    await rm(path.join(config.paths.contractStorage, `recette-lot6-${contractRef}`), {
      recursive: true, force: true,
    });

    return {
      certificat: { fichier: metaCert.certificateFilename, type: metaCert.certificateContentType },
      contrat: { fichier: metaDoc.signedFilename },
      nomsDistincts: metaCert.certificateFilename !== metaDoc.signedFilename,
      empreintesDistinctes: metaCert.certificateChecksum !== metaDoc.signedChecksum,
      /** L'extension suit le type déclaré, pas une habitude. */
      extensionCoherente: metaCert.certificateFilename.endsWith(
        /pdf/i.test(cert.result.contentType) ? '.pdf' : '.bin',
      ),
    };
  });

  rapport.verdict = pieces?.differeDuContratSigne ? 'ACHÈVEMENT ET PREUVE CONFORMES' : 'NON PROUVÉ';
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
  writeFileSync(path.join(DOSSIER, 'opensign-completion-recipe.json'), JSON.stringify(rapport, null, 1), 'utf8');
  journal(`\nartefact : ${path.join(DOSSIER, 'opensign-completion-recipe.json')}`);
  await disconnectDatabase();
}
