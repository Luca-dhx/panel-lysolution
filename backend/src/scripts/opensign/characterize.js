// CARACTÉRISATION DU BAC À SABLE OPENSIGN — remplacer les hypothèses par des mesures.
//
// Campagne de migration Yousign → OpenSign, lot 1.
//
//   node src/scripts/opensign/characterize.js [--keep] [--skip-size]
//
// ══ CE QUE CE SCRIPT EST ════════════════════════════════════════════════════
//
// Un instrument de MESURE, pas une suite de tests. Il ne juge presque rien : il
// appelle le vrai bac à sable, enregistre ce qui revient, et rend un artefact
// JSON dont les lots suivants tireront leurs constantes. Un test vert qui
// repose sur une hypothèse fausse coûte plus cher qu'une absence de test.
//
// ══ CE QU'IL NE FAIT JAMAIS ═════════════════════════════════════════════════
//
//  · aucun document réel : la mire est GÉNÉRÉE (voir `fixturePdf.js`) ;
//  · aucune adresse réelle : les signataires vivent sur `example.com`, réservé
//    par la RFC 2606, où aucune boîte ne peut exister ;
//  · aucune valeur secrète dans l'artefact ni dans la sortie ;
//  · aucun document laissé derrière lui — le nettoyage est la dernière étape,
//    et il tourne même après un échec.
//
// ══ POURQUOI IL N'ABANDONNE PAS AU PREMIER REFUS ════════════════════════════
//
// Chaque étape est isolée. Une mesure qui échoue est une MESURE, pas une panne
// du script : « OpenSign refuse ceci » est exactement le genre de fait qu'on
// vient chercher. Seuls les prérequis (identifiants, jeton accepté) arrêtent.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { connectDatabase, disconnectDatabase } from '../../config/db.js';
import { openSignFetch, OpenSignTransportError } from '../../services/integratedApi/opensign/openSignTransport.js';
import { resolveWebhookCallback } from '../../services/webhooks/webhookCallback.js';
import { loadOpenSignSandboxCredentials } from './campaignCredentials.js';
import { buildFixturePdf, coordinateProbeLandmarks, PAGE_SIZES } from './fixturePdf.js';

const GARDER = process.argv.includes('--keep');
const SANS_TAILLE = process.argv.includes('--skip-size');

/**
 * DES ADRESSES QUI NE PEUVENT ATTEINDRE PERSONNE.
 *
 * `example.com` est réservé par la RFC 2606 : le domaine existe, il résout, et
 * aucune boîte n'y est livrable. C'est ce qui permet d'éprouver l'acceptation
 * d'un signataire EXTERNE à l'organisation — la limitation exacte qui rendait
 * le bac à sable Yousign inutilisable — sans risquer d'écrire à quiconque.
 */
const SIGNATAIRES = Object.freeze({
  DEVELOPER: { email: 'dev.recette@example.com', name: 'Recette Developpeur' },
  CLIENT: { email: 'client.recette@example.com', name: 'Recette Client' },
});

const rapport = {
  startedAt: new Date().toISOString(),
  environment: 'TEST',
  steps: [],
  createdDocuments: [],
  cleanup: [],
};

const journal = (...args) => console.log(...args);

/** Enregistre une étape — son issue fait partie de la mesure. */
async function step(id, titre, fn) {
  journal(`\n── ${id} · ${titre}`);
  const debut = Date.now();
  try {
    const resultat = await fn();
    rapport.steps.push({ id, titre, ok: true, durationMs: Date.now() - debut, resultat });
    journal(`   ✓ ${JSON.stringify(resultat).slice(0, 600)}`);
    return resultat;
  } catch (error) {
    const mesure = {
      code: error?.code ?? null,
      httpStatus: error?.httpStatus ?? null,
      providerError: error?.providerError ?? null,
      outcome: error?.outcome ?? null,
      message: error?.message ?? String(error),
    };
    rapport.steps.push({ id, titre, ok: false, durationMs: Date.now() - debut, mesure });
    journal(`   ✗ ${JSON.stringify(mesure)}`);
    return null;
  }
}

/** Un appel brut, pour les verbes que le transport ne porte pas encore. */
const appel = (credentials, method, chemin, json) =>
  openSignFetch({ credentials, method, path: chemin, json, timeoutMs: 60_000 });

/* -------------------------------------------------------------------------- */

await connectDatabase();

const { credentials, webhookSecret, describe } = await loadOpenSignSandboxCredentials();
rapport.credentials = describe();
journal('\n=== CARACTÉRISATION OPENSIGN SANDBOX ===');
journal(JSON.stringify(rapport.credentials));

const documentsCrees = [];
const suivre = (objectId, pourquoi) => {
  if (objectId) documentsCrees.push({ objectId, pourquoi });
  return objectId;
};

try {
  /* ══ 1. MATRICE D'AUTHENTIFICATION ═════════════════════════════════════ */

  await step('1.1', 'jeton VALIDE → GET /getuser', async () => {
    const user = await appel(credentials, 'GET', '/getuser');
    return {
      httpStatus: 200,
      champs: Object.keys(user),
      compteReconnu: Boolean(user?.email),
      // On garde le NOM du compte, pas son adresse : l'artefact est relu par
      // des humains et archivé.
      company: user?.company ?? null,
    };
  });

  await step('1.2', 'jeton INVALIDE → statut et code attendus', async () => {
    try {
      await appel({ ...credentials, apiToken: 'jeton-inexistant-pour-mesure' }, 'GET', '/getuser');
      return { verdict: 'ACCEPTÉ — ANOMALIE', httpStatus: 200 };
    } catch (error) {
      if (!(error instanceof OpenSignTransportError)) throw error;
      return {
        httpStatus: error.httpStatus,
        classification: error.code,
        providerError: error.providerError,
        // LE POINT DE LA MESURE : 405 doit être classé UNAUTHORIZED.
        quatreCentCinqEstAuth: error.httpStatus === 405 && error.code === 'UNAUTHORIZED',
      };
    }
  });

  await step('1.3', 'jeton ABSENT → refus AVANT le réseau', async () => {
    try {
      await appel({ baseUrl: credentials.baseUrl }, 'GET', '/getuser');
      return { verdict: 'ACCEPTÉ — ANOMALIE' };
    } catch (error) {
      return { classification: error.code, reseau: error.httpStatus !== null };
    }
  });

  await step('1.4', 'jeton de bac à sable envoyé à l’hôte de PRODUCTION', async () => {
    /**
     * LA MESURE QUI JUSTIFIE LA CONTRAINTE D'HÔTE.
     *
     * On n'envoie pas un jeton dans le monde qui n'est pas le sien par
     * distraction : on le fait UNE FOIS, sciemment, pour connaître la forme
     * exacte du refus — parce que c'est cette forme qu'un exploitant verra si
     * la contrainte tombe un jour, et qu'elle ressemble à une clé morte.
     */
    try {
      await appel({ ...credentials, baseUrl: 'https://app.opensignlabs.com/api/v1.2' }, 'GET', '/getuser');
      return { verdict: 'ACCEPTÉ — les deux mondes communiquent (ANOMALIE)' };
    } catch (error) {
      return {
        httpStatus: error.httpStatus,
        classification: error.code,
        providerError: error.providerError,
        indiscernableDUnJetonMort: error.code === 'UNAUTHORIZED',
      };
    }
  });

  /* ══ 2. CRÉDITS — AVANT ════════════════════════════════════════════════ */

  const creditsAvant = await step('2.1', 'crédits AVANT toute création', async () => {
    const c = await appel(credentials, 'GET', '/getcredits');
    return { plan: c.plan_credits, addon: c.addon_credits, total: c.total_credits, renewal: c.renewal_date };
  });

  /* ══ 3. PLAN DE CONTRÔLE DU WEBHOOK ════════════════════════════════════ */

  const callback = await resolveWebhookCallback('OPENSIGN');
  rapport.callback = { url: callback.url, source: callback.source, ready: callback.ready };
  journal(`\n   callback canonique : ${callback.url} (${callback.source})`);

  await step('3.1', 'GET /webhook — l’état de départ', async () => {
    try {
      const w = await appel(credentials, 'GET', '/webhook');
      return { champs: Object.keys(w), posee: Boolean(w?.webhook), estLaNotre: w?.webhook === callback.url };
    } catch (error) {
      return { httpStatus: error.httpStatus, classification: error.code, providerError: error.providerError };
    }
  });

  await step('3.2', 'POST /webhook — poser la callback canonique', async () => {
    const r = await appel(credentials, 'POST', '/webhook', { url: callback.url });
    return { reponse: r };
  });

  await step('3.3', 'GET /webhook — relecture après pose', async () => {
    const w = await appel(credentials, 'GET', '/webhook');
    return { posee: Boolean(w?.webhook), conforme: w?.webhook === callback.url };
  });

  await step('3.4', 'POST /webhook à l’identique — IDEMPOTENCE ou conflit ?', async () => {
    /**
     * LA QUESTION QUI DÉCIDE DE LA RÉCONCILIATION.
     *
     * Si reposer la MÊME url rend un conflit, le réconciliateur doit le lire
     * comme « l'état voulu est atteint » et non comme un échec — sinon chaque
     * passage laisserait le binding en erreur alors que tout va bien.
     */
    try {
      const r = await appel(credentials, 'POST', '/webhook', { url: callback.url });
      return { verdict: 'IDEMPOTENT', reponse: r };
    } catch (error) {
      return {
        verdict: 'CONFLIT',
        httpStatus: error.httpStatus,
        classification: error.code,
        providerError: error.providerError,
      };
    }
  });

  await step('3.5', 'la clé de vérification est-elle rendue par l’API ?', async () => {
    const w = await appel(credentials, 'GET', '/webhook');
    const champs = Object.keys(w);
    const suspects = champs.filter((c) => /secret|key|token|sign/i.test(c));
    return {
      champs,
      champsRessemblantAUnSecret: suspects,
      /** OUT_OF_BAND confirmé si l'API ne rend RIEN qui puisse servir à vérifier. */
      outOfBandConfirme: suspects.length === 0,
      cleEnCoffre: Boolean(webhookSecret),
    };
  });

  /* ══ 4. CRÉATION D'UN DOCUMENT — LA MIRE DE COORDONNÉES ════════════════ */

  const mesuresCoordonnees = [];

  for (const [cle, taille] of [
    ['A4_PORTRAIT', PAGE_SIZES.A4_PORTRAIT],
    ['A4_LANDSCAPE', PAGE_SIZES.A4_LANDSCAPE],
    ['LETTER_PORTRAIT', PAGE_SIZES.LETTER_PORTRAIT],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const mesure = await step(`4.${cle}`, `createdocument — mire ${taille.label}`, async () => {
      const reperes = coordinateProbeLandmarks(taille);
      /**
       * DEUX PAGES, ET LA SECONDE PORTE UN SEUL REPÈRE AU CENTRE.
       *
       * L'indexation des pages ne se prouve pas sur un document d'une page :
       * `page: 1` y est juste quelle que soit la base. Une erreur d'un rang
       * place la signature sur la mauvaise page SANS AUCUNE ERREUR — c'est le
       * mode de défaillance le plus coûteux du lot, parce qu'il est silencieux.
       */
      const centrePage2 = [{
        name: 'PAGE2_CENTRE',
        label: 'PAGE2_CENTRE',
        xFromLeft: Math.round((taille.width - 120) / 2),
        yFromTop: Math.round((taille.height - 40) / 2),
        width: 120,
        height: 40,
      }];
      const pdf = buildFixturePdf({
        size: taille,
        landmarksByPage: [reperes, centrePage2],
        title: `MIRE ${taille.label}`,
      });

      const widgetsDev = reperes.slice(0, 3).map((r) => ({
        type: 'signature', page: 1,
        x: r.xFromLeft, y: r.yFromTop, w: r.width, h: r.height,
        options: { hint: r.name },
      }));
      const widgetsClient = [
        ...reperes.slice(3).map((r) => ({
          type: 'signature', page: 1,
          x: r.xFromLeft, y: r.yFromTop, w: r.width, h: r.height,
          options: { hint: r.name },
        })),
        {
          type: 'signature', page: 2,
          x: centrePage2[0].xFromLeft, y: centrePage2[0].yFromTop,
          w: centrePage2[0].width, h: centrePage2[0].height,
          options: { hint: 'PAGE2_CENTRE' },
        },
      ];

      const reponse = await appel(credentials, 'POST', '/createdocument', {
        file: pdf.toString('base64'),
        title: `RECETTE OPENSIGN — mire ${taille.label}`,
        note: 'Document de recette généré. Aucune donnée réelle.',
        // AUCUN E-MAIL. La mesure porte sur l'API, pas sur la distribution.
        send_email: false,
        sendInOrder: true,
        send_in_order_strict: true,
        redirect_url: 'https://panel.ly-solution.com/recette/opensign/retour',
        signers: [
          { role: 'DEVELOPER', ...SIGNATAIRES.DEVELOPER, signer_role: 'signer', widgets: widgetsDev },
          { role: 'CLIENT', ...SIGNATAIRES.CLIENT, signer_role: 'signer', widgets: widgetsClient },
        ],
      });

      suivre(reponse?.objectId, `mire ${cle}`);

      return {
        champsReponse: Object.keys(reponse),
        objectId: reponse?.objectId ?? null,
        nbSignUrl: Array.isArray(reponse?.signurl) ? reponse.signurl.length : 0,
        signUrlChamps: reponse?.signurl?.[0] ? Object.keys(reponse.signurl[0]) : [],
        message: reponse?.message ?? null,
      };
    });

    if (mesure?.objectId) {
      // eslint-disable-next-line no-await-in-loop
      const relecture = await step(`5.${cle}`, `GET /document — ce qu’OpenSign a STOCKÉ`, async () => {
        const doc = await appel(credentials, 'GET', `/document/${mesure.objectId}`);
        const widgets = (doc?.signers ?? []).flatMap((s) => (s.widgets ?? []).map((w) => ({
          signataire: s.role ?? s.name ?? null,
          ...w,
        })));
        return {
          status: doc?.status ?? null,
          champsDocument: Object.keys(doc),
          nbSignataires: (doc?.signers ?? []).length,
          nbWidgets: widgets.length,
          /** LA MESURE : ce que le fournisseur a retenu de nos coordonnées. */
          widgets,
          aFichier: Boolean(doc?.file),
          aCertificat: Boolean(doc?.certificate),
          auditTrail: doc?.audit_trail ?? null,
          redirectUrl: doc?.redirect_url ?? null,
          sendInOrder: doc?.sendInOrder ?? null,
          sendInOrderStrict: doc?.send_in_order_strict ?? null,
        };
      });
      mesuresCoordonnees.push({ taille: cle, dimensions: taille, envoye: mesure, relu: relecture });
    }
  }
  rapport.coordonnees = mesuresCoordonnees;

  /* ══ 6. LIENS DE SIGNATURE ═════════════════════════════════════════════ */

  const premier = documentsCrees[0]?.objectId ?? null;
  if (premier) {
    await step('6.1', 'GET /signinglinks — un lien par signataire', async () => {
      const r = await appel(credentials, 'GET', `/signinglinks/${premier}`);
      return {
        champs: Object.keys(r),
        nb: Array.isArray(r?.signurl) ? r.signurl.length : 0,
        // On garde la FORME de l'URL, jamais le jeton qu'elle porte.
        formeUrl: r?.signurl?.[0]?.url ? new URL(r.signurl[0].url).origin + new URL(r.signurl[0].url).pathname.replace(/\/[^/]+$/, '/<jeton>') : null,
        champsEntree: r?.signurl?.[0] ? Object.keys(r.signurl[0]) : [],
      };
    });
  }

  /* ══ 7. SIGNATAIRE EXTERNE AVEC ENVOI RÉEL ═════════════════════════════ */

  await step('7.1', 'signataire EXTERNE avec send_email — la limitation Yousign existe-t-elle ici ?', async () => {
    /**
     * ══ LA MESURE LA PLUS IMPORTANTE DU LOT POUR LE PARCOURS MÉTIER ═══════
     *
     * Le bac à sable Yousign n'accepte comme destinataire qu'une adresse de
     * l'organisation du compte. Le payload est alors parfaitement valide — et
     * le refus ne nomme aucun champ, ce qui envoie chercher un défaut qui
     * n'existe pas. Cette limitation rendait tout le parcours DEV → CLIENT
     * intestable en recette.
     *
     * On l'éprouve ici avec l'ENVOI ACTIVÉ, vers des adresses `example.com` où
     * aucune boîte ne peut exister.
     */
    const taille = PAGE_SIZES.A4_PORTRAIT;
    const pdf = buildFixturePdf({ size: taille, title: 'RECETTE — SIGNATAIRE EXTERNE' });
    const reponse = await appel(credentials, 'POST', '/createdocument', {
      file: pdf.toString('base64'),
      title: 'RECETTE OPENSIGN — signataire externe',
      send_email: true,
      sendInOrder: true,
      signers: [
        {
          role: 'DEVELOPER', ...SIGNATAIRES.DEVELOPER, signer_role: 'signer',
          widgets: [{ type: 'signature', page: 1, x: 60, y: 700, w: 140, h: 45 }],
        },
        {
          role: 'CLIENT', ...SIGNATAIRES.CLIENT, signer_role: 'signer',
          widgets: [{ type: 'signature', page: 1, x: 320, y: 700, w: 140, h: 45 }],
        },
      ],
    });
    suivre(reponse?.objectId, 'signataire externe');
    return {
      accepte: Boolean(reponse?.objectId),
      liensRendus: Array.isArray(reponse?.signurl) ? reponse.signurl.length : 0,
      verdict: 'EXTERNE ACCEPTÉ',
    };
  });

  /* ══ 8. RÉVOCATION ET SUPPRESSION ══════════════════════════════════════ */

  const pourRevoquer = documentsCrees.at(-1)?.objectId ?? null;
  if (pourRevoquer) {
    await step('8.1', 'POST /document/{id} — révoquer', async () => {
      const r = await appel(credentials, 'POST', `/document/${pourRevoquer}`, {
        reason: 'Recette de caractérisation — révocation mesurée.',
      });
      return { champs: Object.keys(r), revokedAt: Boolean(r?.revokedAt) };
    });

    await step('8.2', 'GET /document après révocation — quel statut ?', async () => {
      const doc = await appel(credentials, 'GET', `/document/${pourRevoquer}`);
      return { status: doc?.status ?? null, champsAjoutes: Object.keys(doc).filter((c) => /revok|declin|cancel/i.test(c)) };
    });
  }

  /* ══ 9. LIMITE DE TAILLE ═══════════════════════════════════════════════ */

  if (!SANS_TAILLE) {
    /**
     * DICHOTOMIE COURTE, ET DES PALIERS CHOISIS.
     *
     * On ne cherche pas la limite au kilo-octet près : on cherche à savoir de
     * quel côté de nos bornes actuelles elle tombe. Trois paliers suffisent, et
     * chaque essai réussi coûte un crédit et un document à nettoyer — raison de
     * plus pour ne pas balayer aveuglément.
     */
    for (const mo of [4, 9, 12]) {
      // eslint-disable-next-line no-await-in-loop
      await step(`9.${mo}Mo`, `createdocument avec un PDF de ~${mo} Mo`, async () => {
        const pdf = buildFixturePdf({
          size: PAGE_SIZES.A4_PORTRAIT,
          title: `RECETTE — TAILLE ${mo} Mo`,
          padBytes: mo * 1024 * 1024,
        });
        const reponse = await appel(credentials, 'POST', '/createdocument', {
          file: pdf.toString('base64'),
          title: `RECETTE OPENSIGN — taille ${mo} Mo`,
          send_email: false,
          signers: [{
            role: 'DEVELOPER', ...SIGNATAIRES.DEVELOPER, signer_role: 'signer',
            widgets: [{ type: 'signature', page: 1, x: 60, y: 700, w: 140, h: 45 }],
          }],
        });
        suivre(reponse?.objectId, `taille ${mo} Mo`);
        return { octetsPdf: pdf.length, octetsBase64: Math.ceil(pdf.length / 3) * 4, accepte: true };
      });
    }
  }

  /* ══ 10. CRÉDITS — APRÈS ═══════════════════════════════════════════════ */

  await step('10.1', 'crédits APRÈS les créations', async () => {
    const c = await appel(credentials, 'GET', '/getcredits');
    return {
      plan: c.plan_credits,
      total: c.total_credits,
      avant: creditsAvant?.total ?? null,
      consomme: creditsAvant?.total != null ? creditsAvant.total - c.total_credits : null,
      documentsCrees: documentsCrees.length,
    };
  });
} finally {
  /* ══ 11. NETTOYAGE — il tourne même après un échec ═════════════════════ */

  journal(`\n── 11 · nettoyage (${documentsCrees.length} document(s))`);
  if (GARDER) {
    journal('   --keep : les documents sont CONSERVÉS pour inspection manuelle.');
    rapport.cleanup.push({ skipped: true, reason: '--keep' });
  } else {
    for (const { objectId, pourquoi } of documentsCrees) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await appel(credentials, 'DELETE', `/document/${objectId}`);
        rapport.cleanup.push({ objectId, pourquoi, supprime: true });
        journal(`   ✓ supprimé ${objectId} (${pourquoi})`);
      } catch (error) {
        rapport.cleanup.push({
          objectId, pourquoi, supprime: false,
          httpStatus: error?.httpStatus ?? null, providerError: error?.providerError ?? null,
        });
        journal(`   ✗ NON supprimé ${objectId} — ${error?.httpStatus} ${error?.providerError ?? error?.message}`);
      }
    }
  }
  rapport.createdDocuments = documentsCrees;
  rapport.finishedAt = new Date().toISOString();

  const sortie = path.resolve(process.cwd(), '../.campaign/opensign-characterization.json');
  mkdirSync(path.dirname(sortie), { recursive: true });
  writeFileSync(sortie, JSON.stringify(rapport, null, 1), 'utf8');
  journal(`\nartefact : ${sortie}`);

  await disconnectDatabase();
}
