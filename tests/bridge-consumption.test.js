/**
 * LE PONT QUI NE CONSOMME PLUS — détection, seuils, alerte, rétablissement.
 *
 * ══ LE DÉFAUT QUE CETTE SUITE VERROUILLE ════════════════════════════════════
 *
 * Un projet du parc a tourné 91 cycles consécutifs avec :
 *
 *     applied: 0        aucune écriture appliquée
 *     lastError: null   aucune erreur
 *     state: DEGRADED   un état que personne ne lisait
 *
 * Le tirage était mort depuis la deuxième écriture du journal. Tout ce qui
 * arrivait encore du Panel passait par la livraison immédiate — un
 * accélérateur, pas une garantie. Le seul mécanisme DURABLE de propagation
 * Panel → projet était hors service, en silence, pendant des jours.
 *
 * Rien n'en parvenait au Panel, et pour une raison parfaitement logique : le
 * battement prouvait que le projet RÉPONDAIT, sa file sortante était vide, et
 * aucun champ ne décrivait la DESCENTE.
 *
 * ══ CE QUI EST ÉPROUVÉ, ET DANS QUEL ORDRE ══════════════════════════════════
 *
 *   1. LE SIGNAL       « le curseur n'avance pas » ne suffit PAS — c'est l'état
 *                      normal d'un projet à jour. C'est l'ÂGE DU RETARD qui
 *                      distingue « rien à recevoir » de « plus rien n'arrive ».
 *   2. LES SEUILS      une panne doit DURER pour être une panne.
 *   3. L'ALERTE        une fois, pas 1 440 par jour. Et une seule fois par
 *                      période de calme.
 *   4. LE RETOUR       un rétablissement se dit — sinon le dernier message
 *                      conservé reste une panne déjà réparée.
 */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const { PanelEvent } = await import('../backend/src/models/PanelSupervision.model.js');
const { emitChange, resetSyncCore, currentCursor } = await import(
  '../backend/src/services/sync/syncCore.service.js'
);
const consommation = await import('../backend/src/services/supervision/bridgeConsumption.service.js');
const alerting = await import('../backend/src/services/supervision/bridgeAlerting.service.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');

await resetSyncCore();

const PROJET = 'garage-silencieux';
const AUTRE = 'garage-bavard';

async function declarer(projectId, projectName) {
  const now = new Date().toISOString();
  await PanelProject.create({
    projectId, projectKey: projectId, projectName,
    createdAt: now, updatedAt: now,
    pairing: { status: 'PAIRED' }, runtime: { environment: 'TEST' },
  });
}
await declarer(PROJET, 'Garage silencieux');
await declarer(AUTRE, 'Garage bavard');

/** Une déclaration de consommation, telle qu'un projet 1.10 l'envoie. */
const declaration = (patch = {}) => ({
  cursor: null,
  lastCursorAdvanceAt: null,
  lastSuccessfulApplyAt: null,
  consecutivePullFailures: 0,
  consecutiveUnreadableChanges: 0,
  appliedTotal: 0,
  state: 'CONNECTED',
  ...patch,
});

const santeDe = (patch, { now = Date.now(), projectId = PROJET } = {}) =>
  consommation.describeConsumptionHealth({
    projectId,
    runtime: { bridgeStats: patch === null ? {} : { consumption: declaration(patch) } },
    now,
  });

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. « Ne sait pas » n’est JAMAIS « tout va bien »');
{
  const muet = await santeDe(null);
  check('un projet qui ne déclare rien est INCONNU', muet.status === 'UNKNOWN');
  check('…jamais SAIN', muet.status !== 'HEALTHY');
  check('…et l’on sait dire qu’il ne déclare pas', muet.detail.declares === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('2. Un curseur qui n’avance pas est l’état NORMAL');
{
  /**
   * C'EST LE PIÈGE DU LOT. Le réflexe est d'alerter sur « le curseur n'a pas
   * bougé depuis une heure ». C'est l'état de TOUS les projets à jour dont
   * rien n'a changé — un signal permanent, que tout le monde apprendrait à
   * ignorer, et le jour où le tirage mourrait vraiment personne ne le lirait.
   */
  const ajour = await santeDe({
    cursor: await currentCursor(),
    lastCursorAdvanceAt: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
  });
  check('curseur figé depuis un mois, rien en attente → SAIN', ajour.status === 'HEALTHY');
  check('…aucun motif', ajour.reasons.length === 0);
  check('…et le retard est nul', ajour.detail.pendingChanges === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3. L’ÂGE DU RETARD — le seul signal qui distingue les deux cas');
{
  /* Le Panel publie quelque chose pour CE projet. */
  await emitChange({
    entityType: 'CLIENT_COMPANY',
    entityId: 'cc-test',
    payload: { legalName: 'X' },
    modifiedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    audience: PROJET,
  });

  const curseurAvant = null;
  const recent = await santeDe({ cursor: curseurAvant });
  check('un retard RÉCENT ne déclenche rien', recent.status === 'HEALTHY');
  check('…mais il est COMPTÉ', recent.detail.pendingChanges >= 1);

  /**
   * Le même retard, vu une heure plus tard. Aucun autre changement : c'est
   * bien l'ÂGE, et lui seul, qui fait basculer le verdict.
   */
  const vieux = await santeDe(
    { cursor: curseurAvant },
    { now: Date.now() + 60 * 60_000 },
  );
  check('le MÊME retard, une heure plus tard → DÉGRADÉ', vieux.status === 'DEGRADED');
  check('…et le motif nomme le retard', vieux.reasons.includes('BACKLOG_STALE'));
  check('…avec son âge en minutes', vieux.detail.backlogAgeMinutes >= 60);

  /** Le retard d'un projet ne compte pas dans celui d'un autre. */
  const voisin = await santeDe(
    { cursor: null },
    { now: Date.now() + 60 * 60_000, projectId: AUTRE },
  );
  check('l’écriture NOMINATIVE ne pèse pas sur le voisin', voisin.detail.pendingChanges === 0);
  check('…et son pont reste sain', voisin.status === 'HEALTHY');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4. Les deux autres signaux — transport, et écritures ÉCARTÉES');
{
  const transport = await santeDe({
    cursor: await currentCursor(),
    consecutivePullFailures: consommation.CONSUMPTION_THRESHOLDS.PULL_FAILURES,
  });
  check('assez d’échecs de tirage consécutifs → DÉGRADÉ', transport.status === 'DEGRADED');
  check('…motif nommé', transport.reasons.includes('PULL_FAILING'));

  const sousLeSeuil = await santeDe({
    cursor: await currentCursor(),
    consecutivePullFailures: consommation.CONSUMPTION_THRESHOLDS.PULL_FAILURES - 1,
  });
  check('un échec de moins → RIEN (une coupure brève n’est pas une panne)',
    sousLeSeuil.status === 'HEALTHY');

  /**
   * LE SEUIL DES ÉCRITURES ILLISIBLES EST BAS, ET C'EST VOULU : chacune est une
   * PERTE DÉFINITIVE. Le curseur avance, le Panel ne les relivrera pas.
   */
  const illisibles = await santeDe({
    cursor: await currentCursor(),
    consecutiveUnreadableChanges: consommation.CONSUMPTION_THRESHOLDS.UNREADABLE_CHANGES,
  });
  check('des écritures ÉCARTÉES en série → DÉGRADÉ', illisibles.status === 'DEGRADED');
  check('…et ce motif est DISTINCT d’un échec de transport',
    illisibles.reasons.includes('CHANGES_UNREADABLE')
    && !illisibles.reasons.includes('PULL_FAILING'));

  const phrases = consommation.explainConsumptionReasons(illisibles.reasons, illisibles.detail);
  check('le motif se dit en français, et parle de PERTE',
    phrases.some((p) => /perdue/i.test(p)));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5. L’alerte — une fois, puis silence');
{
  /**
   * AUCUN DESTINATAIRE NI URL PUBLIQUE dans cette suite : l'envoi ne part donc
   * pas, et c'est très bien — ce qu'on éprouve ici est la MÉMOIRE, le
   * refroidissement et la chronologie, pas le transport d'e-mail.
   */
  const fiche = await PanelProject.findOne({ projectId: PROJET });
  fiche.runtime.bridgeStats = {
    consumption: declaration({ cursor: null, consecutivePullFailures: 9 }),
  };
  await fiche.save();

  const premier = await alerting.evaluateBridgeConsumption(fiche.toObject());
  check('la dégradation est CONSTATÉE', premier.status === 'DEGRADED');

  const ouverture = await PanelEvent.find({
    projectId: PROJET, type: 'PROJECT_BRIDGE_DEGRADED',
  }).lean();
  check('…et écrite UNE fois dans la chronologie', ouverture.length === 1);
  check('…au niveau AVERTISSEMENT', ouverture[0].severity === 'WARNING');
  check('…avec les motifs constatés', Array.isArray(ouverture[0].data?.reasons));

  const memoire = await PanelProject.findOne({ projectId: PROJET }).lean();
  check('l’état d’alerte est MÉMORISÉ sur la fiche', memoire.runtime.bridgeAlert?.state === 'DEGRADED');
  check('…avec l’instant d’OUVERTURE', typeof memoire.runtime.bridgeAlert.since === 'string');

  /**
   * LE BATTEMENT SUIVANT NE RÉPÈTE RIEN. Sans cette garde, une panne d'un
   * week-end produirait des milliers de messages identiques — et l'on filtrerait
   * l'expéditeur avant le lundi.
   */
  const second = await alerting.evaluateBridgeConsumption(
    await PanelProject.findOne({ projectId: PROJET }).lean(),
  );
  check('le battement suivant ne rouvre RIEN', second.status === 'DEGRADED');
  const apres = await PanelEvent.find({
    projectId: PROJET, type: 'PROJECT_BRIDGE_DEGRADED',
  }).lean();
  check('…et la chronologie ne se répète pas', apres.length === 1);

  const memoire2 = await PanelProject.findOne({ projectId: PROJET }).lean();
  check('l’instant d’ouverture ne BOUGE PAS',
    memoire2.runtime.bridgeAlert.since === memoire.runtime.bridgeAlert.since);

  /**
   * L'IDENTITÉ D'UN ENVOI EST REPRODUCTIBLE — sans horloge. Un rejeu après
   * crash retombe sur la même clé et n'expédie rien.
   */
  const cle1 = alerting.bridgeAlertOperationId({ projectId: PROJET, since: '2026-01-01T00:00:00.000Z', index: 0 });
  const cle2 = alerting.bridgeAlertOperationId({ projectId: PROJET, since: '2026-01-01T00:00:00.000Z', index: 0 });
  check('deux dérivations de la même panne rendent la MÊME clé', cle1 === cle2);
  check('…et le rétablissement en a une AUTRE',
    cle1 !== alerting.bridgeAlertOperationId({
      projectId: PROJET, since: '2026-01-01T00:00:00.000Z', index: 0, kind: 'up',
    }));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('6. Le rétablissement — il se dit, et il referme');
{
  const fiche = await PanelProject.findOne({ projectId: PROJET });
  /* Le projet rattrape : son curseur passe la tête du journal. */
  fiche.runtime.bridgeStats = {
    consumption: declaration({
      cursor: await currentCursor(),
      consecutivePullFailures: 0,
      lastSuccessfulApplyAt: new Date().toISOString(),
      appliedTotal: 3,
    }),
  };
  await fiche.save();

  const retour = await alerting.evaluateBridgeConsumption(
    await PanelProject.findOne({ projectId: PROJET }).lean(),
  );
  check('le pont est de nouveau SAIN', retour.status === 'HEALTHY');

  const evenement = await PanelEvent.find({
    projectId: PROJET, type: 'PROJECT_BRIDGE_RECOVERED',
  }).lean();
  check('le rétablissement est inscrit dans la chronologie', evenement.length === 1);
  check('…et il rappelle DEPUIS QUAND la panne durait',
    typeof evenement[0].data?.degradedSince === 'string');

  const memoire = await PanelProject.findOne({ projectId: PROJET }).lean();
  check('l’état d’alerte est REFERMÉ', memoire.runtime.bridgeAlert === null);

  /** Un second passage sain n'annonce pas un second rétablissement. */
  await alerting.evaluateBridgeConsumption(
    await PanelProject.findOne({ projectId: PROJET }).lean(),
  );
  const encore = await PanelEvent.find({
    projectId: PROJET, type: 'PROJECT_BRIDGE_RECOVERED',
  }).lean();
  check('…et un pont sain ne se « rétablit » pas deux fois', encore.length === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('7. Ce que le Panel EXPOSE — le verdict, pas un recalcul');
{
  const fiche = await PanelProject.findOne({ projectId: PROJET }).lean();
  const vue = registre.describeConsumptionDeclaration(fiche.runtime);
  check('la fiche publique dit que le projet DÉCLARE', vue.declares === true);
  check('…rend le curseur, pour qu’on puisse le COMPARER', typeof vue.cursor === 'string');
  check('…et le verdict est SAIN', vue.status === 'HEALTHY');

  const muet = registre.describeConsumptionDeclaration({});
  check('un projet antérieur rend INCONNU', muet.status === 'UNKNOWN');
  check('…jamais SAIN par défaut', muet.status !== 'HEALTHY');
}

await stopMemoryMongo();
finish();
