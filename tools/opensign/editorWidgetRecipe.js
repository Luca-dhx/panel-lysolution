// PREUVE VISUELLE DE BOUT EN BOUT — DE L'ÉDITEUR DE ZONES AU PDF SIGNÉ.
//
// Campagne de migration Yousign → OpenSign, lot 5.
//
//   node tools/opensign/editorWidgetRecipe.js [--keep] [--headed]
//
// ══ CE QU'ELLE AJOUTE AUX DEUX PREUVES DÉJÀ FAITES ══════════════════════════
//
// `signInBrowser.js` (lot 1) a prouvé que le fournisseur pose une signature
// EXACTEMENT où l'API la demande, en points PDF, origine coin supérieur gauche.
// Il envoyait ses coordonnées à la main, en appelant `/createdocument`.
//
// `projectContractRecipe.js` (lot 4) a prouvé que la conversion RATIO → POINT
// de SB Auto tombe juste, et que la charge utile du projet est acceptée par la
// vraie passerelle. Il s'arrêtait à l'ouverture.
//
// Il restait un maillon jamais éprouvé ensemble : entre « l'éditeur enregistre
// 0,1183 » et « l'encre est sur la ligne », il y a une conversion, un schéma,
// une passerelle, un adaptateur, un fournisseur et un navigateur. Chacun est
// juste. Cette recette vérifie que leur COMPOSITION l'est.
//
// Elle part donc de RATIOS D'ÉDITEUR, passe par la capacité générique, fait
// signer dans un vrai navigateur, et mesure le PDF signé en recalculant
// l'attendu DEPUIS LES RATIOS — jamais depuis les points intermédiaires. Une
// erreur commise dans la conversion se propagerait à l'attendu si on partait
// des points : la mesure se donnerait raison toute seule.
//
// ══ POURQUOI DEUX PAGES ET DES RATIOS NON RONDS ═════════════════════════════
//
// Une seule page ne distingue pas une page 1-indexée d'une page 0-indexée : la
// zone atterrit au bon endroit dans les deux cas, puisqu'il n'y a qu'une page.
// Un décalage d'indice se lit alors « toutes les signatures sont sur la
// première page » — ce qu'on ne découvre qu'avec un contrat de plusieurs pages,
// c'est-à-dire tous les vrais.
//
// Des ratios ronds (0,1 ; 0,25) donnent des points ronds : ils masqueraient un
// arrondi systématique. Ceux-ci sont ceux qu'un humain produit en déposant une
// zone à la souris.
//
// ══ SÛRETÉ ═════════════════════════════════════════════════════════════════
//
// PDF généré, identités sur `example.com` (RFC 2606), aucun envoi d'e-mail,
// suppression chez le fournisseur et retrait des liens d'appartenance — y
// compris après échec.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { connectDatabase, disconnectDatabase } from '../../backend/src/config/db.js';
import { invokeCapability } from '../../backend/src/services/capabilities/capabilityGateway.service.js';
import { INVOCATION_SOURCES } from '../../backend/src/services/capabilities/invocationContext.js';
import PanelSignatureBinding from '../../backend/src/models/PanelSignatureBinding.model.js';
import { openSignFetch } from '../../backend/src/services/integratedApi/opensign/openSignTransport.js';
import { loadOpenSignSandboxCredentials } from './campaignCredentials.js';
import { chargerChromium } from './browser.js';
import { buildFixturePdf, PAGE_SIZES } from './fixturePdf.js';
import { imagesPositionnees } from './pdfImages.js';

const GARDER = process.argv.includes('--keep');
const VISIBLE = process.argv.includes('--headed');
const journal = (...a) => console.log(...a);

const DOSSIER = path.resolve(fileURLToPath(new URL('../../.campaign/', import.meta.url)));
mkdirSync(DOSSIER, { recursive: true });

const RACINE_PROJET = path.resolve(
  fileURLToPath(new URL('../../../SB Auto 06/backend/src', import.meta.url)),
);
const sbAuto = async (rel) => import(pathToFileURL(path.join(RACINE_PROJET, rel)).href);

const PROJET = { projectId: 'recette-sbauto-editeur', projectName: 'Recette SB Auto — éditeur' };
const appeler = (code, payload) => invokeCapability({
  code, panelProject: PROJET, payload, requestId: randomUUID(), source: INVOCATION_SOURCES.PANEL_INTERNAL,
});

const TAILLE = PAGE_SIZES.A4_PORTRAIT;

/**
 * LES ZONES, TELLES QUE L'ÉDITEUR LES ENREGISTRE.
 *
 * `xRatio` / `yRatio` sont des fractions de la page, mesurées depuis le coin
 * SUPÉRIEUR gauche — c'est ce que fait le composant : il pose
 * `left: xRatio*100%` et `top: yRatio*100%` sur l'image de la page.
 *
 * Le développeur signe sur la page 1, le client sur la page 2 : c'est la forme
 * la plus courante d'un vrai contrat, et la seule qui éprouve l'indice de page.
 */
const ZONES = [
  {
    id: 'z-dev', name: 'Signature Développeur', signerRole: 'DEVELOPER', page: 1, type: 'SIGNATURE',
    xRatio: 0.11834, yRatio: 0.71259, widthRatio: 0.28571, heightRatio: 0.06532,
  },
  {
    id: 'z-cli', name: 'Signature Client', signerRole: 'CLIENT', page: 2, type: 'SIGNATURE',
    xRatio: 0.55462, yRatio: 0.18409, widthRatio: 0.28571, heightRatio: 0.06532,
  },
];

/** Ce que les ratios DÉSIGNENT sur le papier — recalculé, jamais relu. */
const attenduDepuisRatios = (z) => ({
  page: z.page,
  xDepuisGauche: z.xRatio * TAILLE.width,
  yDepuisHaut: z.yRatio * TAILLE.height,
  largeur: z.widthRatio * TAILLE.width,
  hauteur: z.heightRatio * TAILLE.height,
});

const rapport = { startedAt: new Date().toISOString(), page: TAILLE, zonesEditeur: ZONES, etapes: [] };
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

await connectDatabase();
const { credentials } = await loadOpenSignSandboxCredentials();

try {
  journal('\n=== LOT 5 — DE L’ÉDITEUR DE ZONES À L’ENCRE SUR LE PAPIER ===');

  const { buildSignatureOpenPayload } = await sbAuto('services/signature/signature.service.js');
  const { validateZones } = await sbAuto('services/signature/signatureCoordinates.js');

  /* ── LE DOCUMENT — deux pages, un repère dessiné là où la zone est posée ── */

  const cibles = ZONES.map((z) => ({ zone: z, ...attenduDepuisRatios(z) }));
  const pdf = buildFixturePdf({
    size: TAILLE,
    pageCount: 2,
    title: 'RECETTE LOT 5 — ÉDITEUR VERS PAPIER',
    landmarksByPage: [1, 2].map((numero) => cibles
      .filter((c) => c.page === numero)
      .map((c) => ({
        xFromLeft: c.xDepuisGauche, yFromTop: c.yDepuisHaut,
        width: c.largeur, height: c.hauteur, label: c.zone.signerRole,
      }))),
  });
  writeFileSync(path.join(DOSSIER, 'lot5-mire.pdf'), pdf);

  const contractRef = `sbauto-lot5-${Date.now()}`;
  const contrat = {
    _id: contractRef,
    reference: `CTR-LOT5-${contractRef.slice(-6)}`,
    document: {
      pageCount: 2,
      pageSizes: [1, 2].map((page) => ({ page, width: TAILLE.width, height: TAILLE.height })),
    },
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
    signatureConfiguration: { locked: true, zones: ZONES },
  };

  await etape('0', 'l’éditeur produirait des zones valides', async () => {
    const erreurs = validateZones(ZONES, { pageCount: 2 });
    if (erreurs.length) throw new Error(erreurs.join(' | '));
    return { zones: ZONES.length, pages: [...new Set(ZONES.map((z) => z.page))], erreurs: 0 };
  });

  /* ── 1. OUVRIR PAR LA CAPACITÉ GÉNÉRIQUE ──────────────────────────────── */

  const payload = buildSignatureOpenPayload(
    contrat,
    { buffer: pdf, filename: 'contrat-lot5.pdf' },
    'https://manager.recette.example.com/retour-signature',
  );

  const ouvert = await etape('1', 'signature.request.open — la chaîne complète', async () => {
    const r = await appeler('signature.request.open', payload);
    if (r.result?.signatureRequestId) aNettoyer.push(r.result.signatureRequestId);
    return {
      fournisseur: r.result.provider,
      status: r.result.status,
      signatureRequestId: r.result.signatureRequestId,
      champsEnvoyes: payload.fields.map((f) => ({ role: f.signerRole, page: f.page, x: f.x, y: f.y })),
      signataires: r.result.signers.map((s) => ({ role: s.role, lien: Boolean(s.signatureLink) })),
    };
  });
  const demandeId = ouvert?.signatureRequestId;
  if (!demandeId) throw new Error('Ouverture impossible : la preuve visuelle n’a plus d’objet.');

  /* ── 2. LE LIEN DU DÉVELOPPEUR, DEMANDÉ COMME LE PROJET LE DEMANDE ─────── */

  const lienDev = await etape('2', 'signature.signer.retrieve — le lien du premier signataire', async () => {
    const lecture = await appeler('signature.request.retrieve', { signatureRequestId: demandeId });
    const dev = lecture.result.signers.find((s) => s.role === 'DEVELOPER');
    if (!dev) throw new Error('aucun signataire DEVELOPER');
    const r = await appeler('signature.signer.retrieve', {
      signatureRequestId: demandeId, signerId: dev.signerId,
    });
    if (!r.result.signatureLink) throw new Error('aucun lien de signature rendu');
    const url = new URL(r.result.signatureLink);
    return { role: 'DEVELOPER', formeLien: `${url.origin}${url.pathname.replace(/\/[^/]+$/, '/<jeton>')}` };
  }).then(async () => {
    const lecture = await appeler('signature.request.retrieve', { signatureRequestId: demandeId });
    const dev = lecture.result.signers.find((s) => s.role === 'DEVELOPER');
    const r = await appeler('signature.signer.retrieve', {
      signatureRequestId: demandeId, signerId: dev.signerId,
    });
    return r.result.signatureLink;
  });

  /* ── 3. LE RENDU DANS LE CLIENT DU FOURNISSEUR ────────────────────────── */

  navigateur = await (await chargerChromium()).launch({ headless: !VISIBLE });
  const contexte = await navigateur.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await contexte.newPage();

  const capture = async (nom) => {
    const fichier = path.join(DOSSIER, `lot5-${nom}.png`);
    await page.screenshot({ path: fichier, fullPage: false });
    journal(`   [capture] ${fichier}`);
  };

  await page.goto(lienDev, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: /confirme|confirm|accept|agree/i })
    .first().click({ timeout: 15_000 }).catch(() => journal('   (pas d’écran de consentement)'));
  await page.waitForTimeout(4000);
  await capture('01-document-ouvert');

  await etape('3', 'le rendu du fournisseur place la zone où l’éditeur l’a posée', async () => {
    const geometrie = await page.evaluate(() => {
      const conteneur = document.querySelector('[data-pdf-transform-target="true"]')
        ?? document.querySelector('.react-pdf__Document');
      const blocs = [...document.querySelectorAll('.signYourselfBlock')].map((el) => {
        const style = el.getAttribute('style') ?? '';
        const t = /translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)/.exec(style);
        const w = /width:\s*([-\d.]+)px/.exec(style);
        const h = /height:\s*([-\d.]+)px/.exec(style);
        return {
          gauche: t ? parseFloat(t[1]) : null,
          haut: t ? parseFloat(t[2]) : null,
          largeur: w ? parseFloat(w[1]) : null,
          hauteur: h ? parseFloat(h[1]) : null,
        };
      });
      return {
        largeurConteneur: conteneur ? parseFloat(getComputedStyle(conteneur).width) : null,
        blocs,
      };
    });

    /**
     * ON COMPARE AU FACTEUR QUE LA PAGE IMPOSE, pas à une constante devinée.
     *
     * Le client rend la page à une largeur qui lui appartient. Si le widget est
     * rendu à `ratio × largeurRendue`, alors le ratio de l'éditeur EST celui du
     * rendu — et rien d'autre ne peut produire cette coïncidence.
     */
    const bloc = geometrie.blocs[0];
    if (!bloc || geometrie.largeurConteneur == null) throw new Error('aucun widget lisible dans le DOM');

    const zoneDev = ZONES.find((z) => z.signerRole === 'DEVELOPER');
    const ratioObserve = +(bloc.gauche / geometrie.largeurConteneur).toFixed(5);
    const ecartRatio = Math.abs(ratioObserve - zoneDev.xRatio);
    if (ecartRatio > 0.001) {
      throw new Error(`ratio rendu ${ratioObserve} contre ${zoneDev.xRatio} posé par l’éditeur`);
    }
    return {
      largeurRendue: geometrie.largeurConteneur,
      ratioPoseParEditeur: zoneDev.xRatio,
      ratioObserveDansLeDOM: ratioObserve,
      ecart: +ecartRatio.toFixed(6),
      facteurPageVersRendu: +(geometrie.largeurConteneur / TAILLE.width).toFixed(5),
    };
  });

  /* ── 4. SIGNER POUR DE VRAI ───────────────────────────────────────────── */

  const essayer = async (description, action) => {
    try { await action(); journal(`   ✓ ${description}`); return true; }
    catch (e) { journal(`   – ${description} (${String(e.message).split('\n')[0].slice(0, 80)})`); return false; }
  };

  journal('\n— parcours de signature du développeur —');
  await essayer('ouverture du pavé', async () => {
    await page.locator('.signYourselfBlock').first().click({ timeout: 10_000 });
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
  await capture('02-zone-signee');
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
  await capture('03-signature-confirmee');

  /* ── 5. MESURER L'ENCRE — depuis les RATIOS, jamais depuis les points ──── */

  await etape('5', 'l’encre tombe où l’éditeur l’avait posée', async () => {
    let telechargement = null;
    for (let essai = 0; essai < 10; essai += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await appeler('signature.document.download', { signatureRequestId: demandeId });
      const octets = Buffer.from(r.result.contentBase64, 'base64');
      const images = imagesPositionnees(octets);
      if (images.length) { telechargement = { octets, images }; break; }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r2) => setTimeout(r2, 5000));
    }
    if (!telechargement) throw new Error('aucune image de signature dans le document relu');
    writeFileSync(path.join(DOSSIER, 'lot5-signe.pdf'), telechargement.octets);

    /**
     * L'ATTENDU EST RECALCULÉ DEPUIS LE RATIO.
     *
     * Le PDF compte ses `y` depuis le BAS ; l'éditeur depuis le HAUT. La
     * conversion est faite ici, une fois, à partir du ratio brut — si on
     * partait des points rendus par `mapZoneToField`, une erreur dans cette
     * fonction se retrouverait des deux côtés de la comparaison, et la mesure
     * se donnerait raison toute seule.
     */
    const zoneDev = ZONES.find((z) => z.signerRole === 'DEVELOPER');
    const a = attenduDepuisRatios(zoneDev);
    const attendu = {
      x: a.xDepuisGauche,
      yBas: TAILLE.height - a.yDepuisHaut - a.hauteur,
      largeur: a.largeur,
      hauteur: a.hauteur,
    };
    const candidat = telechargement.images
      .map((i) => ({ i, d: Math.hypot(i.x - attendu.x, i.yBas - attendu.yBas) }))
      .sort((x, y) => x.d - y.d)[0].i;

    const ecart = {
      x: +(candidat.x - attendu.x).toFixed(2),
      y: +(candidat.yBas - attendu.yBas).toFixed(2),
      largeur: +(candidat.largeur - attendu.largeur).toFixed(2),
      hauteur: +(candidat.hauteur - attendu.hauteur).toFixed(2),
    };
    const pire = Math.max(...Object.values(ecart).map(Math.abs));
    if (pire > 2) throw new Error(`écart de ${pire} point(s) entre le ratio de l’éditeur et l’encre`);
    return {
      ratioEditeur: { x: zoneDev.xRatio, y: zoneDev.yRatio },
      attenduEnPoints: {
        x: +attendu.x.toFixed(2), yBas: +attendu.yBas.toFixed(2),
        largeur: +attendu.largeur.toFixed(2), hauteur: +attendu.hauteur.toFixed(2),
      },
      mesureDansLePdfSigne: candidat,
      ecart,
      ecartMaximalEnPoints: +pire.toFixed(2),
      imagesTrouvees: telechargement.images.length,
    };
  });

  /* ── 6. LA PAGE — l'indice n'a pas glissé ─────────────────────────────── */

  await etape('6', 'la zone du CLIENT est restée sur la page 2', async () => {
    const client = payload.fields.find((f) => f.signerRole === 'CLIENT');
    const dev = payload.fields.find((f) => f.signerRole === 'DEVELOPER');
    if (dev.page !== 1 || client.page !== 2) {
      throw new Error(`pages envoyées : DEV=${dev.page}, CLIENT=${client.page}`);
    }
    const lecture = await appeler('signature.request.retrieve', { signatureRequestId: demandeId });
    return {
      pagesEnvoyees: { DEVELOPER: dev.page, CLIENT: client.page },
      indexation: '1-indexée, comme l’éditeur et comme le fournisseur',
      etatApresSignatureDuDev: lecture.result.state,
      signataires: lecture.result.signers.map((s) => ({ role: s.role, state: s.state })),
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
  writeFileSync(path.join(DOSSIER, 'opensign-editor-widget-recipe.json'), JSON.stringify(rapport, null, 1), 'utf8');
  journal(`\nartefact : ${path.join(DOSSIER, 'opensign-editor-widget-recipe.json')}`);
  await disconnectDatabase();
}
