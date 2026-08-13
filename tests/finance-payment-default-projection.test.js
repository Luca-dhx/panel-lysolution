/**
 * L10.6B-3 — L'INCIDENT VOYAGE AVANT LA SANCTION.
 *
 * ══ LE DÉFAUT QUE CE LOT CORRIGE ═══════════════════════════════════════════
 *
 * Jusqu'ici, le Panel ne publiait vers le projet qu'aux transitions où la CAUSE
 * de suspension devenait pertinente — expiration de la grâce, puis retrait. Un
 * client dont la carte venait d'être refusée n'apprenait donc rien : son espace
 * de facturation restait serein pendant les sept jours de grâce, et l'impayé
 * apparaissait le jour où son site fermait. Il découvrait l'incident et la
 * sanction dans le même écran, après avoir eu une semaine pour l'éviter.
 *
 * ══ CE QUE CES CONTRÔLES VERROUILLENT ══════════════════════════════════════
 *
 *   · qu'un incident parte dès le PREMIER échec, sans activer aucune cause ;
 *   · que `PAYMENT_DEFAULT_CAUSE.active` garde EXACTEMENT sa sémantique — la
 *     cause appliquée au moteur de suspension, jamais « il y a un incident » ;
 *   · que les deux types restent orthogonaux et ne se recouvrent jamais ;
 *   · que `null` traverse le pont comme `null`, et `0` comme `0` ;
 *   · que la charge utile porte un ÉTAT COMPLET, jamais un delta ;
 *   · qu'une LECTURE ne déclenche ni Stripe, ni e-mail, ni écriture ;
 *   · qu'aucun code du lot ne sache retenter un prélèvement.
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
const { PanelSyncJournalEntry } = await import('../backend/src/models/PanelSyncState.model.js');
const {
  PanelProjectContract, PanelProjectSiteStatus,
} = await import('../backend/src/models/PanelProjectProjection.model.js');
const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const defauts = await import('../backend/src/services/finance/paymentDefaults/paymentDefaults.service.js');
const contrat = await import('../backend/src/bridge/bridgeContract.js');

await PanelPaymentDefault.init();

const PROJET = 'atelier-nord';
{
  const now = new Date().toISOString();
  await PanelProject.create({
    projectId: PROJET, projectKey: PROJET, projectName: 'Atelier du Nord',
    createdAt: now, updatedAt: now,
    pairing: { status: 'PAIRED' }, runtime: { environment: 'TEST' },
  });
}

/** Ce que le pont a réellement émis, pour un type donné. */
const emissions = async (entityType, entityId = null) => {
  const filtre = { 'change.entityType': entityType };
  if (entityId) filtre['change.entityId'] = entityId;
  return PanelSyncJournalEntry.find(filtre).sort({ seq: 1 }).lean();
};

/** La DERNIÈRE charge utile émise pour un incident. */
const dernier = async (entityType, entityId) => {
  const tout = await emissions(entityType, entityId);
  return tout.length ? tout[tout.length - 1].change : null;
};

/** Un fait Stripe normalisé, tel que le normalisateur le rend. */
let sequence = 0;
const echec = (patch = {}) => ({
  environment: 'TEST',
  projectId: PROJET,
  invoiceId: `in_${sequence}`,
  subscriptionId: `sub_${sequence}`,
  amountDueCents: 24_900,
  currency: 'EUR',
  invoiceNumber: `F-2026-00${sequence}`,
  hostedInvoiceUrl: `https://invoice.stripe.com/i/${sequence}`,
  invoicePdfUrl: `https://invoice.stripe.com/i/${sequence}/pdf`,
  attemptCount: 1,
  nextPaymentAttemptAt: new Date('2026-08-04T10:00:00Z'),
  failedAt: new Date('2026-08-01T10:00:00Z'),
  ...patch,
});

/** Fixe la politique de grâce du contrat projeté. */
async function poserGrace(jours) {
  await PanelProjectContract.updateOne(
    { projectId: PROJET },
    { $set: { projectId: PROJET, paymentGraceDays: jours } },
    { upsert: true },
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('A. Premier échec — l’incident part, AUCUNE cause n’est activée');
{
  sequence = 1;
  await poserGrace(7);
  const r = await defauts.recordInvoiceFailure(echec());
  check('l’incident est ouvert', r.recorded === true && r.opened === true);

  const incident = await PanelPaymentDefault.findOne({ invoiceId: 'in_1' }).lean();
  const id = incident.paymentDefaultId;

  const inc = await dernier('PAYMENT_DEFAULT_INCIDENT', id);
  check('UN INCIDENT A ÉTÉ PUBLIÉ dès le premier échec', inc !== null);
  check('…avec le statut OPEN', inc.payload.status === PAYMENT_DEFAULT_STATUS.OPEN);
  /**
   * LE CŒUR DU LOT. Pendant la grâce, l'incident existe et la cause NON.
   * Publier `causeActive: true` ici fermerait le site pendant sa grâce.
   */
  check('LA CAUSE N’EST PAS ACTIVE pendant la grâce', inc.payload.causeActive === false);
  check('…et aucune suspension n’a été demandée', inc.payload.suspensionRequestedAt === null);
  check('…ni confirmée', inc.payload.suspensionConfirmedAt === null);

  /** La CAUSE, elle, n'a rien émis : il n'y a rien à appliquer au moteur. */
  const causes = await emissions('PAYMENT_DEFAULT_CAUSE', id);
  check('AUCUNE cause n’a été émise au premier échec', causes.length === 0);

  check('l’écriture est NOMMÉE (audience = le projet)',
    (await emissions('PAYMENT_DEFAULT_INCIDENT', id))[0].audience === PROJET);
  check('l’identité de projection est le paymentDefaultId', inc.entityId === id);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('B. Grâce active — le délai FIGÉ et son échéance voyagent');
{
  const incident = await PanelPaymentDefault.findOne({ invoiceId: 'in_1' }).lean();
  const inc = await dernier('PAYMENT_DEFAULT_INCIDENT', incident.paymentDefaultId);

  check('le délai figé est publié', inc.payload.graceDaysSnapshot === 7);
  check('l’échéance est celle de l’incident, telle quelle',
    inc.payload.graceDeadlineAt === incident.graceDeadlineAt.toISOString());
  check('…ancrée sur le PREMIER échec, pas sur le dernier',
    inc.payload.firstFailedAt === '2026-08-01T10:00:00.000Z');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('C+U. Second échec — les observations Stripe évoluent, le figé ne bouge pas');
{
  const avant = await PanelPaymentDefault.findOne({ invoiceId: 'in_1' }).lean();

  await defauts.recordInvoiceFailure(echec({
    invoiceId: 'in_1',
    attemptCount: 2,
    nextPaymentAttemptAt: new Date('2026-08-06T10:00:00Z'),
    failedAt: new Date('2026-08-04T10:00:00Z'),
  }));

  const inc = await dernier('PAYMENT_DEFAULT_INCIDENT', avant.paymentDefaultId);
  check('attemptCount a suivi Stripe', inc.payload.attemptCount === 2);
  check('nextPaymentAttemptAt a suivi Stripe',
    inc.payload.nextPaymentAttemptAt === '2026-08-06T10:00:00.000Z');

  /** Le piège le plus naturel du lot : ancrer la grâce sur le dernier échec. */
  check('L’ÉCHÉANCE N’A PAS BOUGÉ',
    inc.payload.graceDeadlineAt === avant.graceDeadlineAt.toISOString());
  check('…ni le premier échec', inc.payload.firstFailedAt === '2026-08-01T10:00:00.000Z');
  check('…ni le délai figé', inc.payload.graceDaysSnapshot === 7);
  check('la cause reste inactive', inc.payload.causeActive === false);

  const toutes = await emissions('PAYMENT_DEFAULT_INCIDENT', avant.paymentDefaultId);
  check('DEUX publications, une par échec observé', toutes.length === 2);
  check('…sur la MÊME entité (identité stable)',
    toutes.every((e) => e.change.entityId === avant.paymentDefaultId));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('D. Retry inconnu — aucune date n’est inventée');
{
  sequence = 2;
  await defauts.recordInvoiceFailure(echec({ nextPaymentAttemptAt: null }));
  const incident = await PanelPaymentDefault.findOne({ invoiceId: 'in_2' }).lean();
  const inc = await dernier('PAYMENT_DEFAULT_INCIDENT', incident.paymentDefaultId);

  check('la date absente reste NULLE', inc.payload.nextPaymentAttemptAt === null);
  check('…et n’est pas remplacée par « maintenant »',
    inc.payload.nextPaymentAttemptAt !== undefined);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('K. Aucune politique de grâce — `null` traverse le pont comme `null`');
{
  sequence = 3;
  await poserGrace(null);
  await defauts.recordInvoiceFailure(echec());
  const incident = await PanelPaymentDefault.findOne({ invoiceId: 'in_3' }).lean();
  const inc = await dernier('PAYMENT_DEFAULT_INCIDENT', incident.paymentDefaultId);

  /**
   * `null` ET `0` SONT DEUX DÉCISIONS OPPOSÉES. Un `?? 0` quelque part sur le
   * chemin transformerait « aucune politique » en « aucune clémence », et
   * fermerait le site au premier prélèvement refusé.
   */
  check('graceDaysSnapshot vaut NULL, pas zéro', inc.payload.graceDaysSnapshot === null);
  check('…et il n’y a AUCUNE échéance', inc.payload.graceDeadlineAt === null);
  check('l’incident existe quand même', inc.payload.status === PAYMENT_DEFAULT_STATUS.OPEN);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('L. Grâce de ZÉRO jour — le zéro est conservé, jamais lu comme absent');
{
  sequence = 4;
  await poserGrace(0);
  await defauts.recordInvoiceFailure(echec());
  const incident = await PanelPaymentDefault.findOne({ invoiceId: 'in_4' }).lean();
  const inc = await dernier('PAYMENT_DEFAULT_INCIDENT', incident.paymentDefaultId);

  check('graceDaysSnapshot vaut ZÉRO', inc.payload.graceDaysSnapshot === 0);
  check('…et ce n’est PAS null', inc.payload.graceDaysSnapshot !== null);
  check('l’échéance existe — elle tombe dès l’échec',
    inc.payload.graceDeadlineAt === '2026-08-01T10:00:00.000Z');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('E. Expiration — demandée, PAS confirmée. Et la cause s’active alors.');
{
  sequence = 5;
  await poserGrace(7);
  await defauts.recordInvoiceFailure(echec());
  const ouvert = await PanelPaymentDefault.findOne({ invoiceId: 'in_5' }).lean();
  const id = ouvert.paymentDefaultId;

  const r = await defauts.expireDueGracePeriods({ now: new Date('2026-08-09T10:00:00Z') });
  check('la grâce a expiré', r.expired >= 1);

  const inc = await dernier('PAYMENT_DEFAULT_INCIDENT', id);
  check('l’incident est GRACE_EXPIRED', inc.payload.status === PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED);
  check('LA SUSPENSION EST DEMANDÉE', inc.payload.suspensionRequestedAt !== null);
  /**
   * LA DISTINCTION QUI PORTE LE LOT. Le projet peut être hors ligne : la
   * demande n'est pas la fermeture, et l'écran doit écrire « en cours
   * d'application », jamais « site suspendu ».
   */
  check('…mais PAS confirmée', inc.payload.suspensionConfirmedAt === null);
  check('la cause devient active À CET INSTANT, pas avant',
    inc.payload.causeActive === true);

  /** ET LA CAUSE, elle, part enfin vers le moteur. */
  const cause = await dernier('PAYMENT_DEFAULT_CAUSE', id);
  check('la CAUSE a été émise à l’expiration', cause !== null);
  check('…avec active = true', cause.payload.active === true);
  check('LES DEUX VALEURS SONT IDENTIQUES — dérivées de la même fonction',
    cause.payload.active === inc.payload.causeActive);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('F+X. Confirmation — republiée, et prouvée par causes.paymentDefault');
{
  const incident = await PanelPaymentDefault.findOne({ invoiceId: 'in_5' }).lean();
  const id = incident.paymentDefaultId;
  const avant = (await emissions('PAYMENT_DEFAULT_INCIDENT', id)).length;

  /**
   * SOUS MAINTENANCE TECHNIQUE : la cause DOMINANTE est `TECHNICAL`, et
   * pourtant la nôtre est bel et bien appliquée. La preuve est
   * `causes.paymentDefault`, jamais `suspensionSource`.
   */
  await defauts.confirmFromSiteStatus({
    projectId: PROJET,
    snapshot: {
      accessible: false,
      status: 'SUSPENDED',
      suspensionSource: 'TECHNICAL',
      causes: { technical: true, contract: false, paymentDefault: true },
      sourceModifiedAt: '2026-08-09T11:00:00Z',
    },
  });

  /**
   * On vérifie CET incident, pas un compteur : plusieurs grâces ont pu expirer
   * au même tour d'ordonnanceur, et un total ne dirait pas lequel a basculé.
   */
  const confirme = await PanelPaymentDefault.findOne({ invoiceId: 'in_5' }).lean();
  check('la fermeture est confirmée malgré une dominante TECHNICAL',
    confirme.suspensionConfirmedAt !== null);

  const apres = await emissions('PAYMENT_DEFAULT_INCIDENT', id);
  check('L’INCIDENT A ÉTÉ REPUBLIÉ avec sa confirmation', apres.length === avant + 1);

  const inc = apres[apres.length - 1].change;
  check('suspensionConfirmedAt voyage désormais',
    inc.payload.suspensionConfirmedAt === '2026-08-09T11:00:00.000Z');
  check('…à côté de la demande, qui n’a pas bougé',
    inc.payload.suspensionRequestedAt !== null);
  check('la cause reste active', inc.payload.causeActive === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('H+I+Y. Résolution — l’incident repart RESOLVED, cause inactive');
{
  const incident = await PanelPaymentDefault.findOne({ invoiceId: 'in_5' }).lean();
  const id = incident.paymentDefaultId;

  await defauts.resolveInvoiceDefault({
    environment: 'TEST', invoiceId: 'in_5',
    transactionId: 'tx-1', paidAt: new Date('2026-08-10T09:00:00Z'),
  });

  const inc = await dernier('PAYMENT_DEFAULT_INCIDENT', id);
  check('l’incident est RESOLVED', inc.payload.status === PAYMENT_DEFAULT_STATUS.RESOLVED);
  check('la cause n’est plus active', inc.payload.causeActive === false);
  check('la date de régularisation voyage',
    inc.payload.resolvedAt === '2026-08-10T09:00:00.000Z');
  check('…et l’issue est NOMMÉE, pas déduite d’un statut',
    inc.payload.resolution === 'PAID_AFTER_GRACE');

  /**
   * ══ « RÉSOLU » N'EST PAS « SITE ACCESSIBLE » ═══════════════════════════
   *
   * Le retrait de cause est publié, et RIEN de plus. Aucune charge utile ne
   * dit « rouvre le site » : le projet recombine ses causes et tranche. Une
   * maintenance technique lui survivra.
   */
  const cause = await dernier('PAYMENT_DEFAULT_CAUSE', id);
  check('la cause est retirée', cause.payload.active === false);
  const texte = JSON.stringify(inc.payload) + JSON.stringify(cause.payload);
  check('AUCUNE charge utile ne parle d’état de site',
    !/"status"\s*:\s*"(ACTIVE|SUSPENDED)"/.test(texte));
  check('…ni d’accessibilité', !/accessible/i.test(texte));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Y (suite). Retrait constaté sous maintenance — republié, site fermé');
{
  const incident = await PanelPaymentDefault.findOne({ invoiceId: 'in_5' }).lean();
  const id = incident.paymentDefaultId;
  const avant = (await emissions('PAYMENT_DEFAULT_INCIDENT', id)).length;

  /** Le projet a retiré notre cause, mais reste fermé pour maintenance. */
  const res = await defauts.confirmFromSiteStatus({
    projectId: PROJET,
    snapshot: {
      accessible: false,
      status: 'SUSPENDED',
      suspensionSource: 'TECHNICAL',
      causes: { technical: true, contract: false, paymentDefault: false },
      sourceModifiedAt: '2026-08-10T10:00:00Z',
    },
  });
  /** Le site reste FERMÉ pour maintenance, et le retrait est constaté quand même. */
  check('le RETRAIT est constaté sans exiger de réactivation', res.removed >= 1);

  const apres = await emissions('PAYMENT_DEFAULT_INCIDENT', id);
  check('l’incident est republié avec le retrait', apres.length === avant + 1);
  check('causeRemovalConfirmedAt voyage',
    apres[apres.length - 1].change.payload.causeRemovalConfirmedAt === '2026-08-10T10:00:00.000Z');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('V. Duplication ×8 — une projection répétée n’ajoute aucun EFFET');
{
  const incident = await PanelPaymentDefault.findOne({ invoiceId: 'in_5' }).lean();
  const id = incident.paymentDefaultId;
  const avant = await dernier('PAYMENT_DEFAULT_INCIDENT', id);

  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await defauts.confirmFromSiteStatus({
      projectId: PROJET,
      snapshot: {
        accessible: false, status: 'SUSPENDED', suspensionSource: 'TECHNICAL',
        causes: { technical: true, contract: false, paymentDefault: false },
        sourceModifiedAt: '2026-08-10T10:00:00Z',
      },
    });
  }

  const apres = await dernier('PAYMENT_DEFAULT_INCIDENT', id);
  /**
   * Le nombre d'écritures peut être n'importe quoi — le pont est libre de
   * republier. Ce qui compte est que l'ÉTAT transporté soit inchangé : c'est
   * lui que l'applicateur remplace, et huit remplacements identiques valent
   * un seul.
   */
  check('L’ÉTAT PUBLIÉ EST INCHANGÉ après huit rejeux',
    JSON.stringify(apres.payload) === JSON.stringify(avant.payload));

  const document = await PanelPaymentDefault.findOne({ invoiceId: 'in_5' }).lean();
  check('…et la confirmation n’a pas rajeuni',
    document.causeRemovalConfirmedAt.toISOString() === '2026-08-10T10:00:00.000Z');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('W. Échec tardif après résolution — aucune réouverture');
{
  const incident = await PanelPaymentDefault.findOne({ invoiceId: 'in_5' }).lean();
  const id = incident.paymentDefaultId;

  /** Stripe livre dans le désordre : un échec de la 3e tentative arrive après. */
  await defauts.recordInvoiceFailure(echec({
    invoiceId: 'in_5', attemptCount: 3, failedAt: new Date('2026-08-08T10:00:00Z'),
  }));

  const document = await PanelPaymentDefault.findOne({ invoiceId: 'in_5' }).lean();
  check('L’INCIDENT RESTE RÉSOLU', document.status === PAYMENT_DEFAULT_STATUS.RESOLVED);

  const inc = await dernier('PAYMENT_DEFAULT_INCIDENT', id);
  check('…et la projection publie toujours RESOLVED',
    inc.payload.status === PAYMENT_DEFAULT_STATUS.RESOLVED);
  check('…avec la cause inactive', inc.payload.causeActive === false);
  check('la résolution n’a pas été effacée', inc.payload.resolvedAt !== null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('O. Incidents successifs — deux factures, DEUX entités distinctes');
{
  sequence = 6;
  await defauts.recordInvoiceFailure(echec());
  sequence = 7;
  await defauts.recordInvoiceFailure(echec());

  const a = await PanelPaymentDefault.findOne({ invoiceId: 'in_6' }).lean();
  const b = await PanelPaymentDefault.findOne({ invoiceId: 'in_7' }).lean();

  check('deux incidents distincts', a.paymentDefaultId !== b.paymentDefaultId);
  check('…sur le MÊME projet', a.projectId === b.projectId);

  const ia = await dernier('PAYMENT_DEFAULT_INCIDENT', a.paymentDefaultId);
  const ib = await dernier('PAYMENT_DEFAULT_INCIDENT', b.paymentDefaultId);
  check('chacun a sa propre entité de projection', ia.entityId !== ib.entityId);
  /**
   * JAMAIS FUSIONNÉS PAR CONTRAT. L'identité est celle du PaymentDefault ;
   * regrouper par `contractId` en effacerait un de l'historique du client.
   */
  check('…et l’identité n’est PAS le contrat',
    ia.entityId !== ia.payload.contractId && ib.entityId !== ib.payload.contractId);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('T. Rattrapage — les incidents VIVANTS sont republiés, OPEN compris');
{
  const avant = (await emissions('PAYMENT_DEFAULT_INCIDENT')).length;
  const r = await defauts.republishPaymentDefaultCauses(PROJET);

  /**
   * LE CAS QUI COMPTE : un projet éteint pendant la grâce doit retrouver son
   * incident au retour. Republier les seules causes `GRACE_EXPIRED` — ce que
   * faisait le rattrapage avant ce lot — laisserait le client devant un espace
   * de facturation serein sur un prélèvement refusé.
   */
  check('des incidents OPEN ont été republiés', r.incidents >= 2);
  check('…et le rattrapage a bien émis', (await emissions('PAYMENT_DEFAULT_INCIDENT')).length > avant);

  const vivants = await PanelPaymentDefault.countDocuments({
    projectId: PROJET,
    status: { $in: [PAYMENT_DEFAULT_STATUS.OPEN, PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED] },
  });
  check('tous les vivants sont couverts, pas seulement les expirés',
    r.incidents === vivants);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('L’ÉTAT EST COMPLET — jamais un delta');
{
  const incident = await PanelPaymentDefault.findOne({ invoiceId: 'in_1' }).lean();
  const inc = await dernier('PAYMENT_DEFAULT_INCIDENT', incident.paymentDefaultId);

  /**
   * Un « passe à… » supposerait que le projet ait déjà la ligne et dans le bon
   * état. Deux livraisons dans le désordre le laisseraient faux, en silence.
   */
  const attendus = [
    'paymentDefaultId', 'projectId', 'contractId', 'invoiceId', 'status',
    'attemptCount', 'nextPaymentAttemptAt', 'firstFailedAt', 'lastFailedAt',
    'graceDaysSnapshot', 'graceDeadlineAt',
    'amountDueCents', 'currency', 'invoiceNumber', 'hostedInvoiceUrl', 'invoicePdfUrl',
    'suspensionRequestedAt', 'suspensionConfirmedAt', 'causeRemovalConfirmedAt',
    'resolvedAt', 'resolution', 'causeActive', 'reason',
  ];
  for (const champ of attendus) {
    check(`la charge porte « ${champ} »`, Object.hasOwn(inc.payload, champ));
  }
  check('aucun champ ne dit « incrémente »',
    !/\+\+|increment|delta/i.test(JSON.stringify(inc.payload)));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Le contrat de pont déclare les DEUX types, et ils sont distincts');
{
  check('PAYMENT_DEFAULT_CAUSE est déclaré',
    contrat.SYNC_ENTITY_TYPES.includes('PAYMENT_DEFAULT_CAUSE'));
  check('PAYMENT_DEFAULT_INCIDENT est déclaré',
    contrat.SYNC_ENTITY_TYPES.includes('PAYMENT_DEFAULT_INCIDENT'));
  check('…ce sont bien DEUX types', new Set(contrat.SYNC_ENTITY_TYPES).size
    === contrat.SYNC_ENTITY_TYPES.length);

  /**
   * NI L'UN NI L'AUTRE N'EST APPLIQUÉ PAR LE PANEL : ce sont des écritures qui
   * PARTENT vers le projet. Les inscrire ici en ferait des entrées, donc une
   * porte par laquelle un projet dicterait ses propres impayés.
   */
  check('la CAUSE n’est pas appliquée par le Panel',
    !contrat.APPLIED_ENTITY_TYPES.includes('PAYMENT_DEFAULT_CAUSE'));
  check('l’INCIDENT non plus',
    !contrat.APPLIED_ENTITY_TYPES.includes('PAYMENT_DEFAULT_INCIDENT'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('R. Une LECTURE ne déclenche rien — ni Stripe, ni e-mail, ni écriture');
{
  await PanelProjectSiteStatus.updateOne(
    { projectId: PROJET },
    {
      $set: {
        projectId: PROJET, accessible: false, status: 'SUSPENDED',
        suspensionSource: 'TECHNICAL', contractProtectionEnabled: true,
        technicalSuspension: true,
        causes: { technical: true, contract: false, paymentDefault: false },
      },
    },
    { upsert: true },
  );
  await poserGrace(15);

  const emisAvant = await PanelSyncJournalEntry.countDocuments({});
  const documentsAvant = await PanelPaymentDefault.find({ projectId: PROJET })
    .sort({ paymentDefaultId: 1 }).lean();

  /** HUIT lectures d'affilée — un client anxieux qui rafraîchit. */
  let vue = null;
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    vue = await defauts.describeProjectPaymentDefaults(PROJET, { now: '2026-08-20T00:00:00Z' });
  }

  const emisApres = await PanelSyncJournalEntry.countDocuments({});
  const documentsApres = await PanelPaymentDefault.find({ projectId: PROJET })
    .sort({ paymentDefaultId: 1 }).lean();

  check('AUCUNE écriture n’est partie vers le projet', emisApres === emisAvant);
  check('AUCUN incident n’a été muté',
    JSON.stringify(documentsAvant) === JSON.stringify(documentsApres));
  /**
   * Y COMPRIS AUCUNE EXPIRATION DE GRÂCE. Un GET qui ferait basculer les
   * incidents échus fermerait un site parce que quelqu'un a ouvert un écran :
   * l'ordonnanceur financier est le seul à décider, et il a son propre rythme.
   */
  check('…et aucune grâce n’a expiré du fait de la lecture',
    documentsApres.filter((d) => d.status === PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED).length
    === documentsAvant.filter((d) => d.status === PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED).length);

  check('la lecture rend bien quelque chose', vue.items.length >= 5);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('N+Q. La lecture — historique, incident actif, et UNKNOWN honnête');
{
  const vue = await defauts.describeProjectPaymentDefaults(PROJET, { now: '2026-08-20T00:00:00Z' });

  check('l’incident ACTIF est désigné', vue.active !== null);
  check('…et il est VIVANT',
    [PAYMENT_DEFAULT_STATUS.OPEN, PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED]
      .includes(vue.active.incident.status));

  const resolus = vue.items.filter((i) => i.incident.status === PAYMENT_DEFAULT_STATUS.RESOLVED);
  check('LES INCIDENTS RÉSOLUS RESTENT CONSULTABLES', resolus.length >= 1);

  /** J. La politique a changé : snapshot 7, contrat 15. Les deux s'affichent. */
  const avecSnapshot = vue.items.find((i) => i.incident.graceDaysSnapshot === 7);
  check('la DÉRIVE de politique est signalée', avecSnapshot.display.policy.drifted === true);
  check('…le snapshot de l’incident est 7', avecSnapshot.display.policy.snapshot === 7);
  check('…la politique courante est 15', avecSnapshot.display.policy.current === 15);
  check('…et l’échéance n’a PAS été recalculée',
    avecSnapshot.display.grace.graceDeadlineAt === avecSnapshot.incident.graceDeadlineAt);

  /** L'accessibilité vient de l'instantané du projet, jamais d'un calcul local. */
  check('l’état du site est reflété, pas déduit',
    vue.active.display.site.state === 'SUSPENDED');
  check('…avec l’autre cause NOMMÉE',
    vue.active.display.site.otherCauses.some((c) => c.key === 'technical'));
  check('l’instantané du projet est connu', vue.siteStatusKnown === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Q. Sans instantané du projet — UNKNOWN, jamais « tout va bien »');
{
  await PanelProjectSiteStatus.deleteOne({ projectId: PROJET });
  const vue = await defauts.describeProjectPaymentDefaults(PROJET, { now: '2026-08-20T00:00:00Z' });

  check('l’absence d’instantané est DITE', vue.siteStatusKnown === false);
  check('…et l’accessibilité vaut UNKNOWN', vue.active.display.site.state === 'UNKNOWN');
  check('…pas ACCESSIBLE', vue.active.display.site.state !== 'ACCESSIBLE');
  check('…et rien n’est affirmé', vue.active.display.site.accessible === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('GARDE-FOUS STATIQUES — aucun ordonnanceur local, aucun secret');
{
  const ici = path.dirname(fileURLToPath(import.meta.url));
  const racine = path.resolve(ici, '..');

  /**
   * ══ LA GARDE LIT LE CODE, PAS LA PROSE ═══════════════════════════════════
   *
   * Ces fichiers EXPLIQUENT longuement pourquoi ils n'appellent jamais
   * `POST /v1/invoices/{id}/pay`. Une garde naïve lirait cette phrase et
   * rougirait sur la documentation de l'interdit qu'elle défend — puis
   * quelqu'un supprimerait le commentaire pour faire passer le test, et l'on
   * aurait échangé une explication contre un silence.
   *
   * On retire donc les commentaires avant d'inspecter. Ce qui reste est ce que
   * la machine exécute, et c'est la seule chose qui puisse débiter une carte.
   */
  const codeSeul = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

  const FICHIERS_B3 = [
    'backend/src/services/finance/paymentDefaults/paymentDefaults.service.js',
    'backend/src/services/finance/paymentDefaults/paymentDefaultPresentation.js',
    'backend/src/controllers/finances.controller.js',
    'backend/src/routes/finances.routes.js',
    'frontend/src/components/finance/PaymentDefaultPanel.tsx',
  ];

  /**
   * ══ STRIPE EST L'UNIQUE ORDONNANCEUR DES TENTATIVES ═══════════════════════
   *
   * Un `POST /v1/invoices/{id}/pay` émis d'ici entrerait en course avec la
   * tentative que Stripe a déjà programmée sur la même facture — c'est-à-dire
   * produirait le double débit. Il n'existe donc AUCUN chemin local vers une
   * tentative de collecte, et cette liste le garde.
   */
  const INTERDITS = [
    { motif: /getStripeProvider/, quoi: 'un accès direct au fournisseur' },
    { motif: /\bsecretKey\b/, quoi: 'une clé secrète' },
    { motif: /sk_(test|live)_/, quoi: 'une clé Stripe en clair' },
    { motif: /invoices?\.pay\b|invoices\/[^'"]*\/pay/, quoi: 'un ordre de paiement de facture' },
    { motif: /retryNow|retryInterval|scheduleRetry/, quoi: 'un ordonnanceur local de tentatives' },
    { motif: /require\(['"]stripe['"]\)|from ['"]stripe['"]/, quoi: 'le SDK Stripe' },
  ];

  for (const relatif of FICHIERS_B3) {
    const source = codeSeul(fs.readFileSync(path.join(racine, relatif), 'utf8'));
    for (const { motif, quoi } of INTERDITS) {
      check(`${path.basename(relatif)} ne contient pas ${quoi}`, !motif.test(source));
    }
  }

  /**
   * ══ LE FRONTEND NE RECONSTRUIT AUCUN ÉTAT MÉTIER ══════════════════════════
   *
   * Trois interdits, et chacun a son bogue :
   *
   *   `suspensionSource === 'PAYMENT_DEFAULT'` comme preuve — faux sous
   *     maintenance, où la dominante reste TECHNICAL alors que notre cause EST
   *     appliquée ;
   *
   *   une échéance recalculée — afficherait la politique courante sur un
   *     incident qui en a figé une autre ;
   *
   *   une accessibilité recalculée — une seconde formule finirait par diverger
   *     de `reconcileSiteStatus`, et l'écran annoncerait un site fermé qui
   *     répond.
   */
  const brutUi = fs.readFileSync(
    path.join(racine, 'frontend/src/components/finance/PaymentDefaultPanel.tsx'), 'utf8',
  );
  const ui = codeSeul(brutUi);
  check('l’UI n’utilise PAS suspensionSource comme preuve',
    !/suspensionSource\s*===/.test(ui));
  check('l’UI ne recalcule aucune échéance de grâce',
    !/graceDays[\s\S]{0,40}\*\s*(24|86400|JOUR)/.test(ui));
  check('l’UI ne recalcule aucune accessibilité',
    !/!\s*technical\s*&&|accessible\s*=\s*!/.test(ui));
  check('l’UI ne recalcule pas causeActive',
    !/causeActive\s*=[^=]/.test(ui));
  /**
   * `null` ET `0` : le test doit être une comparaison EXPLICITE. Un test de
   * vérité afficherait « aucun délai configuré » à un client qui en a zéro.
   */
  check('l’UI distingue null de zéro par une comparaison explicite',
    /graceDaysSnapshot\s*===\s*null/.test(ui));

  /**
   * AUCUNE MUTATION DEPUIS LA SURFACE DE LECTURE.
   *
   * L'absence de verbe d'écriture est ce qui rend la règle STRUCTURELLE plutôt
   * que respectée : il n'y a pas de route à appeler par mégarde, donc pas de
   * route à sécuriser.
   */
  const routes = codeSeul(
    fs.readFileSync(path.join(racine, 'backend/src/routes/finances.routes.js'), 'utf8'),
  );
  check('la surface des impayés est montée en lecture',
    /router\.get\(\s*'\/payment-defaults'/.test(routes));
  check('…et n’expose AUCUN verbe d’écriture',
    !/router\.(post|patch|delete|put)\([^)]*payment-defaults/.test(routes));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('L’INCIDENT N’EST PAS LA CAUSE — les deux charges ne se recouvrent pas');
{
  const incident = await PanelPaymentDefault.findOne({ invoiceId: 'in_5' }).lean();
  const id = incident.paymentDefaultId;
  const inc = await dernier('PAYMENT_DEFAULT_INCIDENT', id);
  const cause = await dernier('PAYMENT_DEFAULT_CAUSE', id);

  /**
   * `active` reste le mot de la CAUSE, et il ne franchit pas la frontière.
   * L'incident dit `causeActive`, qui est une OBSERVATION. Deux mots parce que
   * ce sont deux choses : l'un pilote un moteur, l'autre explique un écran.
   */
  check('la CAUSE porte « active »', Object.hasOwn(cause.payload, 'active'));
  check('l’INCIDENT ne porte PAS « active »', !Object.hasOwn(inc.payload, 'active'));
  check('l’INCIDENT porte « causeActive »', Object.hasOwn(inc.payload, 'causeActive'));
  check('la CAUSE ne porte PAS « causeActive »', !Object.hasOwn(cause.payload, 'causeActive'));

  /** L'incident porte l'observation Stripe ; la cause n'en a jamais eu besoin. */
  check('seul l’INCIDENT porte les observations Stripe',
    Object.hasOwn(inc.payload, 'attemptCount') && !Object.hasOwn(cause.payload, 'attemptCount'));
  check('seul l’INCIDENT porte les dates de confirmation',
    Object.hasOwn(inc.payload, 'suspensionConfirmedAt')
    && !Object.hasOwn(cause.payload, 'suspensionConfirmedAt'));
}

await stopMemoryMongo();
finish();
