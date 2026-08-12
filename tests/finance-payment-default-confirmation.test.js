/**
 * L10.6A — INSTANTANÉ DES CAUSES ET BOUCLE DE CONFIRMATION.
 *
 * Ce que ces contrôles verrouillent, et rien d'autre :
 *
 *   · que le Panel confirme sa cause financière SANS jamais la confondre avec
 *     la cause DOMINANTE — le cas `TECHNICAL + PAYMENT_DEFAULT` est celui qui
 *     justifie tout ce lot ;
 *   · que la confirmation de RETRAIT n'exige pas une réactivation ;
 *   · qu'un snapshot sans instantané de causes ne fasse conclure à rien ;
 *   · qu'une confirmation acquise ne rajeunisse pas à chaque livraison ;
 *   · qu'aucune formule d'accessibilité ne soit dupliquée côté Panel.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const PanelPaymentDefault = (await import('../backend/src/models/PanelPaymentDefault.model.js')).default;
const { PAYMENT_DEFAULT_STATUS } = await import('../backend/src/models/PanelPaymentDefault.model.js');
const defauts = await import('../backend/src/services/finance/paymentDefaults/paymentDefaults.service.js');
const { siteStatusPayloadSchema } = await import('../backend/src/bridge/bridgeContract.js');

await PanelPaymentDefault.init();

/**
 * LE PROJET DOIT EXISTER AU REGISTRE — le cœur de synchronisation refuse
 * d'appliquer une écriture pour un projet qu'il ne connaît pas, et c'est
 * correct : une projection sans fiche n'aurait ni monde, ni génération.
 */
const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
{
  const now = new Date().toISOString();
  await PanelProject.create({
    projectId: 'atelier-nord', projectKey: 'atelier-nord', projectName: 'Atelier du Nord',
    createdAt: now, updatedAt: now,
    pairing: { status: 'PAIRED' }, runtime: { environment: 'TEST' },
  });
}

const PROJET = 'atelier-nord';
let sequence = 0;

/** Un incident arrivé à expiration, prêt à être confirmé. */
async function incidentExpire() {
  sequence += 1;
  const id = `pd-${sequence}`;
  await PanelPaymentDefault.create({
    paymentDefaultId: id,
    projectId: PROJET,
    environment: 'TEST',
    invoiceId: `in_${sequence}`,
    graceDaysSnapshot: 7,
    graceDeadlineAt: new Date('2026-08-08T10:00:00Z'),
    firstFailedAt: new Date('2026-08-01T10:00:00Z'),
    status: PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED,
    suspensionRequestedAt: new Date('2026-08-08T10:00:00Z'),
  });
  return id;
}

/** Un snapshot d'état de site, tel que le projet le publie. */
const snapshot = ({ accessible, source, technical = false, contract = false, paymentDefault = false, at = '2026-08-08T10:05:00Z' }) => ({
  accessible,
  status: accessible ? 'ACTIVE' : 'SUSPENDED',
  suspensionSource: source,
  contractProtectionEnabled: true,
  technicalSuspension: technical,
  causes: { technical, contract, paymentDefault },
  sourceModifiedAt: at,
});

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. Le contrat de pont accepte l\'instantané des causes');
{
  const complet = siteStatusPayloadSchema.safeParse({
    accessible: false, status: 'SUSPENDED', suspensionSource: 'TECHNICAL',
    contractProtectionEnabled: true, technicalSuspension: true,
    causes: { technical: true, contract: false, paymentDefault: true },
  });
  check('un snapshot avec les trois causes est accepté', complet.success === true);

  const ancien = siteStatusPayloadSchema.safeParse({
    accessible: true, status: 'ACTIVE', suspensionSource: 'NONE',
    contractProtectionEnabled: false, technicalSuspension: false,
  });
  check('…et une projection ANTÉRIEURE au lot reste valide', ancien.success === true);

  const nouvelleSource = siteStatusPayloadSchema.safeParse({
    accessible: false, status: 'SUSPENDED', suspensionSource: 'PAYMENT_DEFAULT',
    contractProtectionEnabled: true, technicalSuspension: false,
    causes: { technical: false, contract: false, paymentDefault: true },
  });
  check('PAYMENT_DEFAULT est une source dominante recevable', nouvelleSource.success === true);

  const partiel = siteStatusPayloadSchema.safeParse({
    accessible: false, status: 'SUSPENDED', suspensionSource: 'TECHNICAL',
    contractProtectionEnabled: true, technicalSuspension: true,
    causes: { technical: true },
  });
  check('un instantané INCOMPLET est refusé — trois causes ou aucune',
    partiel.success === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('2. Confirmation simple — la cause financière ferme le site');
{
  const id = await incidentExpire();
  const r = await defauts.confirmFromSiteStatus({
    projectId: PROJET,
    snapshot: snapshot({ accessible: false, source: 'PAYMENT_DEFAULT', paymentDefault: true }),
  });
  check('une fermeture est confirmée', r.confirmed === 1);

  const apres = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('la date de confirmation est écrite', apres.suspensionConfirmedAt !== null);
  check('…et elle est DISTINCTE de la demande',
    apres.suspensionConfirmedAt.getTime() !== apres.suspensionRequestedAt.getTime());
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3. LE CAS QUI JUSTIFIE LE LOT — TECHNICAL prime, la cause s\'applique');
{
  const id = await incidentExpire();

  /**
   * Le site est fermé, notre cause EST appliquée, et pourtant la source
   * dominante affiche TECHNICAL. Une confirmation fondée sur `suspensionSource`
   * conclurait ici que le projet nous a ignorés — et relancerait indéfiniment
   * une demande déjà honorée.
   */
  const vue = snapshot({
    accessible: false, source: 'TECHNICAL', technical: true, paymentDefault: true,
  });
  check('la source dominante n\'est PAS la nôtre', vue.suspensionSource === 'TECHNICAL');

  const r = await defauts.confirmFromSiteStatus({ projectId: PROJET, snapshot: vue });
  check('LA CONFIRMATION A QUAND MÊME LIEU', r.confirmed === 1);

  const apres = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('…et l\'incident porte sa confirmation', apres.suspensionConfirmedAt !== null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4. Un site accessible ne confirme AUCUNE fermeture');
{
  const id = await incidentExpire();
  const r = await defauts.confirmFromSiteStatus({
    projectId: PROJET,
    snapshot: snapshot({ accessible: true, source: 'NONE' }),
  });
  check('rien n\'est confirmé', r.confirmed === 0);

  const apres = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('l\'incident reste en attente de confirmation', apres.suspensionConfirmedAt === null);
  check('…et sa demande, elle, tient toujours', apres.suspensionRequestedAt !== null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5. Le retrait de cause n\'exige PAS une réactivation');
{
  const id = await incidentExpire();
  await PanelPaymentDefault.updateOne(
    { paymentDefaultId: id },
    { $set: { status: PAYMENT_DEFAULT_STATUS.RESOLVED, resolvedAt: new Date() } },
  );

  /**
   * Le paiement est régularisé, notre cause est retirée — et le site reste
   * fermé pour maintenance. Exiger `accessible === true` refuserait de
   * constater un retrait parfaitement réel.
   */
  const r = await defauts.confirmFromSiteStatus({
    projectId: PROJET,
    snapshot: snapshot({
      accessible: false, source: 'TECHNICAL', technical: true, paymentDefault: false,
    }),
  });
  check('LE RETRAIT EST CONFIRMÉ malgré un site toujours fermé', r.removed >= 1);

  const apres = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('la date de retrait est écrite', apres.causeRemovalConfirmedAt !== null);
  check('…et AUCUNE fermeture n\'a été confirmée au passage',
    apres.suspensionConfirmedAt === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('6. Sans instantané de causes, on refuse de conclure');
{
  const id = await incidentExpire();
  const r = await defauts.confirmFromSiteStatus({
    projectId: PROJET,
    snapshot: {
      accessible: false, status: 'SUSPENDED', suspensionSource: 'TECHNICAL',
      contractProtectionEnabled: true, technicalSuspension: true,
      sourceModifiedAt: '2026-08-08T10:05:00Z',
    },
  });
  check('aucune confirmation n\'est déduite', r.confirmed === 0 && r.removed === 0);
  check('…et le motif est nommé', r.reason === 'NO_CAUSE_SNAPSHOT');

  const apres = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('l\'incident reste intact', apres.suspensionConfirmedAt === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('7. Idempotence — la PREMIÈRE confirmation fait foi');
{
  const id = await incidentExpire();
  const vue = snapshot({
    accessible: false, source: 'PAYMENT_DEFAULT', paymentDefault: true,
    at: '2026-08-08T10:05:00Z',
  });

  const un = await defauts.confirmFromSiteStatus({ projectId: PROJET, snapshot: vue });
  const premier = (await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean())
    .suspensionConfirmedAt;

  /** Le même snapshot rejoué, puis un plus récent : la date ne bouge pas. */
  const deux = await defauts.confirmFromSiteStatus({ projectId: PROJET, snapshot: vue });
  await defauts.confirmFromSiteStatus({
    projectId: PROJET,
    snapshot: { ...vue, sourceModifiedAt: '2026-08-09T12:00:00Z' },
  });
  const apres = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();

  /**
   * `confirmed` compte TOUS les incidents en attente du projet, pas seulement
   * le nôtre — les sections précédentes en ont laissé plusieurs. C'est le
   * comportement voulu : un snapshot vaut pour l'ensemble du projet.
   */
  check('la première livraison confirme', un.confirmed >= 1);
  check('…dont le nôtre', premier !== null);
  check('la seconde ne confirme rien de neuf', deux.confirmed === 0);
  check('LA DATE NE RAJEUNIT PAS',
    apres.suspensionConfirmedAt.getTime() === premier.getTime());
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('8. Un incident RÉSOLU n\'est jamais rouvert par un snapshot');
{
  const id = await incidentExpire();
  await PanelPaymentDefault.updateOne(
    { paymentDefaultId: id },
    { $set: { status: PAYMENT_DEFAULT_STATUS.RESOLVED, resolvedAt: new Date() } },
  );

  /** Un snapshot retardataire annonçant la cause encore active. */
  await defauts.confirmFromSiteStatus({
    projectId: PROJET,
    snapshot: snapshot({
      accessible: false, source: 'PAYMENT_DEFAULT', paymentDefault: true,
      at: '2026-08-07T10:00:00Z',
    }),
  });

  const apres = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('l\'incident reste RÉSOLU', apres.status === PAYMENT_DEFAULT_STATUS.RESOLVED);
  check('…et aucune fermeture ne lui est attribuée', apres.suspensionConfirmedAt === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('9. Garde-fous — ce qui ne doit jamais revenir');
{
  const ici = path.dirname(fileURLToPath(import.meta.url));
  const racine = path.resolve(ici, '..');
  const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');
  const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');

  const service = code(lire('backend/src/services/finance/paymentDefaults/paymentDefaults.service.js'));

  /**
   * LA RÉGRESSION LA PLUS PROBABLE : confondre cause dominante et cause
   * financière. Elle passerait toute recette où une seule cause est active.
   */
  check('la confirmation ne s\'appuie JAMAIS sur suspensionSource',
    !/suspensionSource\s*===\s*['"]PAYMENT_DEFAULT/.test(service));

  check('…ni ne force un site actif',
    !/status\s*=\s*['"]ACTIVE|accessible\s*=\s*true/.test(service));

  /**
   * LA FORMULE D'ACCESSIBILITÉ VIT DANS UN SEUL MOTEUR, côté projet. La
   * dupliquer ici créerait une seconde vérité qui divergerait au premier ajout
   * de cause.
   */
  check('…et ne recalcule pas l\'accessibilité',
    !/!technicalActive\s*&&|contractHonoured\s*&&/.test(service));

  check('aucun intervalle de tentative n\'existe', !/retryInterval/.test(service));
  check('aucun paiement de facture n\'est tenté', !/invoices\/[^'"]*\/pay|invoice\.pay/.test(service));

  const modele = code(lire('backend/src/models/PanelPaymentDefault.model.js'));
  check('le modèle distingue demande et confirmation',
    /suspensionRequestedAt/.test(modele) && /suspensionConfirmedAt/.test(modele));

  const projecteur = code(lire('backend/src/services/sync/projectors.js'));
  check('la confirmation part du projecteur — voie UNIQUE push et pull',
    /confirmFromSiteStatus/.test(projecteur));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('10. LE RATTRAPAGE OFFLINE — par la voie réelle du pont');
{
  /**
   * ══ CE QUE CETTE SECTION PROUVE, ET POURQUOI ELLE MANQUAIT ═══════════════
   *
   * Les sections précédentes appellent la confirmation directement. Elles
   * prouvent la LOGIQUE, pas le CHEMIN — et le chemin est justement ce qui
   * distingue un projet en ligne d'un projet qui revient après une absence.
   *
   * `applyIncoming` est le point d'entrée que le cœur de synchronisation
   * emprunte dans LES DEUX CAS : livraison immédiate quand le Panel pousse, et
   * rattrapage quand il tire après une absence. En passant par lui, on éprouve
   * la voie réelle plutôt qu'une reconstitution.
   */
  const { applyIncoming } = await import('../backend/src/services/sync/syncCore.service.js');
  const { PanelProjectSiteStatus } = await import('../backend/src/models/PanelProjectProjection.model.js');

  const id = await incidentExpire();

  /* ── A. AVANT LE RATTRAPAGE — le Panel n'invente rien ─────────────────── */
  const avant = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('la fermeture est DEMANDÉE', avant.suspensionRequestedAt !== null);
  check('…mais AUCUNE confirmation n’est fabriquée localement',
    avant.suspensionConfirmedAt === null);

  /* ── B. LE PROJET REVIENT ET LIVRE SON ÉTAT ───────────────────────────── */
  const ecriture = (payload, at) => ([{
    writeId: `w-${Math.random().toString(36).slice(2, 10)}`,
    entityType: 'PROJECT_SITE_STATUS',
    entityId: `site-${PROJET}`,
    deleted: false,
    payload,
    modifiedAt: at,
    emitter: 'PROJECT',
  }]);

  /**
   * L'ÉTAT RÉEL DU PROJET PENDANT SON ABSENCE : il a appliqué notre cause, et
   * une maintenance technique était déjà en cours. La cause DOMINANTE n'est
   * donc pas la nôtre — c'est exactement le piège que ce lot ferme.
   */
  const vueOffline = {
    accessible: false,
    status: 'SUSPENDED',
    suspensionSource: 'TECHNICAL',
    contractProtectionEnabled: true,
    technicalSuspension: true,
    causes: { technical: true, contract: false, paymentDefault: true },
  };

  const { results: accuses } = await applyIncoming(PROJET, ecriture(vueOffline, '2026-08-09T08:00:00Z'));
  check('l’écriture est APPLIQUÉE par le cœur', accuses[0]?.status === 'APPLIED');

  const projete = await PanelProjectSiteStatus.findOne({ projectId: PROJET }).lean();
  check('la projection porte l’instantané des causes',
    projete?.causes?.paymentDefault === true);

  /* ── C. LA CONFIRMATION A CONVERGÉ, MALGRÉ UNE SOURCE DIFFÉRENTE ──────── */
  const apres = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('LA FERMETURE EST CONFIRMÉE APRÈS RATTRAPAGE',
    apres.suspensionConfirmedAt !== null);
  check('…alors que la cause dominante est TECHNICAL',
    projete.suspensionSource === 'TECHNICAL');

  /* ── D. REJEU DU MÊME SNAPSHOT ───────────────────────────────────────── */
  const premier = apres.suspensionConfirmedAt;
  const { results: rejeu } = await applyIncoming(PROJET, ecriture(vueOffline, '2026-08-09T08:00:00Z'));
  check('un snapshot identique plus ancien ou égal est ÉCARTÉ par le cœur',
    ['IGNORED', 'APPLIED', 'DUPLICATE'].includes(rejeu[0]?.status));

  /* Puis un snapshot RÉELLEMENT plus récent, au contenu identique. */
  await applyIncoming(PROJET, ecriture(vueOffline, '2026-08-10T09:00:00Z'));
  const apresRejeu = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('LA DATE DE PREMIÈRE CONFIRMATION NE BOUGE PAS',
    apresRejeu.suspensionConfirmedAt.getTime() === premier.getTime());

  /* ── E. RETRAIT DE LA CAUSE, MAINTENANCE TOUJOURS ACTIVE ─────────────── */
  await PanelPaymentDefault.updateOne(
    { paymentDefaultId: id },
    { $set: { status: PAYMENT_DEFAULT_STATUS.RESOLVED, resolvedAt: new Date() } },
  );

  await applyIncoming(PROJET, ecriture({
    ...vueOffline,
    causes: { technical: true, contract: false, paymentDefault: false },
  }, '2026-08-11T10:00:00Z'));

  const solde = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('LE RETRAIT EST CONFIRMÉ', solde.causeRemovalConfirmedAt !== null);

  const siteApres = await PanelProjectSiteStatus.findOne({ projectId: PROJET }).lean();
  check('…alors que le site reste INACCESSIBLE', siteApres.accessible === false);
  check('…pour la maintenance, qui a survécu', siteApres.causes.technical === true);

  /* ── F. UNE SEULE VOIE POUR LES DEUX CHEMINS ─────────────────────────── */
  const projecteur = fs.readFileSync(
    path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      'backend/src/services/sync/projectors.js'), 'utf8',
  );
  check('aucune branche « si hors ligne » dans la confirmation',
    !/if\s*\(\s*offline|isOffline|catchUp\s*\?/.test(projecteur));
}

await stopMemoryMongo();
finish();
