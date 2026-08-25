// QUAND UN PONT DÉGRADÉ DEVIENT UNE NOUVELLE QU'ON REÇOIT.
//
// ══ CE QUE CE MODULE AJOUTE À `bridgeConsumption.service.js` ════════════════
//
// Celui-là CONSTATE ; celui-ci DÉCIDE d'en parler. La séparation n'est pas
// cosmétique : un constat qui alerterait ne pourrait plus servir à peindre un
// écran, et le premier écran ouvert enverrait un e-mail.
//
// ══ TROIS RÈGLES, ET AUCUNE N'EST NÉGOCIABLE ════════════════════════════════
//
//   1. ON N'ALERTE PAS SUR UN INSTANT. La dégradation doit DURER : le seuil est
//      dans `bridgeConsumption` (âge du retard, échecs consécutifs), et il est
//      franchi par le TEMPS, pas par un tirage malheureux.
//
//   2. ON N'ALERTE QU'UNE FOIS. Le battement arrive toutes les minutes ; une
//      alerte par battement, c'est 1 440 messages par jour pour une panne, et
//      la certitude qu'on filtrera l'expéditeur avant le lendemain. L'état est
//      MÉMORISÉ sur la fiche, et le refroidissement est explicite.
//
//   3. ON ANNONCE LE RÉTABLISSEMENT — mais seulement si l'on a alerté. Un
//      rétablissement sans panne préalable est un message qui ne veut rien
//      dire ; une panne sans rétablissement laisse un exploitant vérifier à la
//      main, à chaque fois, si l'alerte est encore vraie.
//
// ══ CE MODULE NE FAIT JAMAIS ÉCHOUER UN BATTEMENT ═══════════════════════════
//
// Ni exception, ni retour d'erreur vers l'appelant. Un projet qui bat
// correctement ne doit pas être déclaré hors ligne parce qu'un fournisseur
// d'e-mails était à terre. Même discipline que l'annonce d'encaissement.
import logger from '../../utils/logger.js';
import config from '../../config/env.js';
import PanelProject from '../../models/PanelProject.model.js';
import { EVENT_TYPES } from '../../models/PanelSupervision.model.js';
import { recordEvent } from './timeline.service.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import { resolveFrontendUrl } from '../network/networkConfig.service.js';
import { invokeCapability } from '../capabilities/capabilityGateway.service.js';
import { INVOCATION_SOURCES } from '../capabilities/invocationContext.js';
import { resolvePanelSuperAdmins } from '../finance/providerRevenue/paymentConfirmationAnnouncements.js';
import {
  CONSUMPTION_STATUS,
  describeConsumptionHealth,
  explainConsumptionReasons,
} from './bridgeConsumption.service.js';

const CAPABILITY = 'email.send_template';

export const BRIDGE_DEGRADED_TEMPLATE = 'PROJECT_BRIDGE_DEGRADED_SUPER_ADMIN';
export const BRIDGE_RECOVERED_TEMPLATE = 'PROJECT_BRIDGE_RECOVERED_SUPER_ADMIN';

/**
 * LE REFROIDISSEMENT — six heures.
 *
 * ══ POURQUOI SIX, ET NON UNE OU VINGT-QUATRE ════════════════════════════════
 *
 * Une heure produirait, sur une panne d'un week-end, une quarantaine de
 * messages identiques — assez pour qu'on crée une règle de boîte aux lettres,
 * ce qui est la pire issue possible.
 *
 * Vingt-quatre heures laisseraient une panne survenue en fin de journée
 * n'être rappelée que le lendemain soir : un exploitant qui a manqué le premier
 * message ne le retrouverait jamais dans le flot.
 *
 * Six heures rappellent une panne persistante quatre fois par jour, ce qui
 * reste lisible, et couvrent une journée de travail sans jamais saturer.
 */
export const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * LA FENÊTRE DE CONFIRMATION D'UN RÉTABLISSEMENT — dix minutes.
 *
 * ══ L'INCIDENT QUI A CRÉÉ CETTE CONSTANTE ═══════════════════════════════════
 *
 * Un projet du parc a expédié UN COURRIEL DE RÉTABLISSEMENT PAR MINUTE pendant
 * une demi-heure. Il n'était pas tombé trente fois : deux runtimes du même
 * projet battaient en alternance, et l'un des deux décrivait une consommation
 * qui n'était plus la sienne (voir, côté projet,
 * `consumptionIsAuthoritative`). Un battement sur deux disait DEGRADED,
 * l'autre HEALTHY.
 *
 * Le refroidissement de six heures ne protégeait pas de ça : il borne les
 * RAPPELS d'une alerte OUVERTE. Or ici l'alerte était refermée à chaque
 * bascule — et une alerte refermée se rouvre sans délai, puis s'annonce
 * immédiatement puisque plus rien ne se souvient du dernier envoi.
 *
 * ══ CE QUE LA FENÊTRE CHANGE ════════════════════════════════════════════════
 *
 * Un retour à la santé n'est plus une FERMETURE, c'est une PROMESSE : l'état
 * passe à `RECOVERING`, et il faut qu'il tienne dix minutes pour que le
 * rétablissement soit annoncé et l'alerte refermée. Une dégradation qui revient
 * entre-temps annule la promesse SANS rien expédier — l'alerte n'a jamais été
 * refermée, donc son refroidissement continue de courir.
 *
 * Un battement de pont arrive chaque minute : dix minutes valent dix constats
 * concordants. Assez pour qu'un battement isolé ne décide de rien, assez peu
 * pour qu'un exploitant qui vient de réparer voie la confirmation arriver
 * pendant qu'il regarde encore.
 *
 * La cause première est corrigée côté projet ; cette fenêtre est ce qui
 * IMMUNISE le Panel — elle vaut pour tout le parc, y compris les runtimes qui
 * n'ont pas encore été redéployés, et pour les causes de battement qu'on n'a
 * pas encore rencontrées.
 */
export const RECOVERY_CONFIRMATION_MS = 10 * 60 * 1000;

/**
 * L'IDENTITÉ DURABLE D'UN ENVOI — sans horloge, sans compteur.
 *
 * ══ POURQUOI ELLE PORTE L'INSTANT D'OUVERTURE ET NON L'INSTANT D'ENVOI ══════
 *
 * `since` est la date à laquelle la dégradation a COMMENCÉ. Elle ne bouge pas
 * tant que la panne dure : deux rappels du même incident portent donc des
 * clés distinctes par leur seul index de rappel, et un REJEU du même rappel —
 * après un crash, une reprise — retombe sur la même clé et n'expédie rien.
 *
 * Un `Date.now()` aurait produit un acte neuf à chaque passage, et un
 * redémarrage malheureux aurait réexpédié tout le parc.
 */
export function bridgeAlertOperationId({ projectId, since, index = 0, kind = 'down' }) {
  return `bridge-${kind}-${projectId}-${since}-${index}`.slice(0, 64);
}

/** L'adresse de la fiche de supervision — le seul lien de ces messages. */
async function supervisionUrl(projectId) {
  const { url } = await resolveFrontendUrl();
  if (!url) return null;
  return `${String(url).replace(/\/+$/, '')}/supervision/${encodeURIComponent(projectId)}`;
}

/** Un envoi, et ce qu'on en retient. Ne lève pas. */
async function envoyer({ templateRef, recipient, variables, operationId }) {
  try {
    await invokeCapability({
      code: CAPABILITY,
      /**
       * `PANEL_SELF` — la portée résolue est `PANEL`, l'expéditeur est celui de
       * L.Y Solution, et le modèle lu est l'unique instance de portée
       * plateforme. Passer par `PANEL_INTERNAL` avec la fiche du projet ferait
       * chercher une instance PROJET de ce code — laquelle n'existe pas et ne
       * doit pas exister.
       */
      source: INVOCATION_SOURCES.PANEL_SELF,
      payload: { templateRef, recipient, variables, operationId },
    });
    return { ok: true, recipient: recipient.email };
  } catch (err) {
    return { ok: false, recipient: recipient.email, errorCode: err?.code ?? 'UNKNOWN_ERROR' };
  }
}

/**
 * ÉVALUE la consommation d'un projet et alerte SI c'est une nouvelle.
 *
 * Appelée depuis l'enregistrement d'un battement — le seul instant où le Panel
 * apprend quelque chose de neuf sur la consommation d'un projet. L'appeler
 * ailleurs (un écran, une liste) enverrait un message parce que quelqu'un a
 * regardé.
 *
 * NE LÈVE JAMAIS.
 *
 * @param {object} record  la fiche du registre, DÉJÀ mise à jour par le battement
 * @returns {Promise<{evaluated: boolean, status?: string, notified?: boolean, reason?: string}>}
 */
export async function evaluateBridgeConsumption(record, { now = Date.now() } = {}) {
  try {
    const projectId = record?.projectId;
    if (!projectId) return { evaluated: false, reason: 'NO_PROJECT' };

    const sante = await describeConsumptionHealth({ projectId, runtime: record.runtime ?? {}, now });

    /**
     * `UNKNOWN` NE DÉCLENCHE RIEN, ET NE REFERME RIEN.
     *
     * Un projet qui ne déclare pas sa consommation (contrat < 1.10.0) est
     * INCONNU, pas sain. Le traiter comme sain refermerait une alerte ouverte
     * sur un projet qu'on vient simplement de rétrograder — et l'on annoncerait
     * un rétablissement qui n'a pas eu lieu.
     */
    if (sante.status === CONSUMPTION_STATUS.UNKNOWN) {
      return { evaluated: true, status: sante.status, notified: false };
    }

    const alerte = record.runtime?.bridgeAlert ?? null;
    const maintenant = now;

    if (sante.status === CONSUMPTION_STATUS.DEGRADED) {
      return ouvrirOuRappeler({ record, projectId, sante, alerte, maintenant });
    }
    return refermer({ record, projectId, alerte, maintenant });
  } catch (err) {
    logger.warn(
      `[bridge-alert] évaluation impossible pour ${record?.projectId ?? 'projet inconnu'} : `
      + `${err?.message ?? 'erreur inconnue'}. Le battement, lui, est enregistré.`,
    );
    return { evaluated: false, reason: 'EVALUATION_FAILED' };
  }
}

/** Écrit l'état d'alerte sur la fiche. Une seule écriture, un seul endroit. */
async function memoriser(projectId, bridgeAlert) {
  await PanelProject.updateOne(
    { projectId },
    { $set: { 'runtime.bridgeAlert': bridgeAlert, updatedAt: nowIso() } },
  );
}

async function ouvrirOuRappeler({ record, projectId, sante, alerte, maintenant }) {
  const phrases = explainConsumptionReasons(sante.reasons, sante.detail);
  const resume = phrases.join(' ; ');
  /**
   * `RECOVERING` N'EST PAS UNE ALERTE FERMÉE — c'est une alerte ouverte dont la
   * réparation n'est pas encore confirmée. Une dégradation qui revient pendant
   * la fenêtre reprend donc son `since`, son `lastNotifiedAt` et son compteur :
   * rien n'est rouvert, rien n'est réexpédié, et le refroidissement continue de
   * courir. C'est très exactement ce qui coupe le battement.
   */
  const nouveau = !alerte?.since;
  const since = nouveau ? nowIso() : alerte.since;

  /**
   * L'ÉVÉNEMENT DE CHRONOLOGIE EST ÉCRIT À L'OUVERTURE, PAS À CHAQUE RAPPEL.
   *
   * Une chronologie qui répéterait le même constat toutes les six heures
   * deviendrait illisible — et c'est exactement là qu'on cherche à retrouver
   * QUAND une panne a commencé.
   */
  if (nouveau) {
    await recordEvent({
      projectId,
      type: EVENT_TYPES.PROJECT_BRIDGE_DEGRADED,
      source: 'PANEL',
      severity: 'WARNING',
      summary: `Le pont ne consomme plus : ${resume}.`,
      data: { reasons: sante.reasons, ...sante.detail },
    });
  }

  const dernier = alerte?.lastNotifiedAt ? new Date(alerte.lastNotifiedAt).getTime() : 0;
  const doitNotifier = maintenant - dernier >= ALERT_COOLDOWN_MS;

  if (!doitNotifier) {
    await memoriser(projectId, {
      ...alerte, since, state: 'DEGRADED', reasons: sante.reasons, healthySince: null,
    });
    return { evaluated: true, status: sante.status, notified: false, reason: 'COOLDOWN' };
  }

  const destinataires = await resolvePanelSuperAdmins();
  const lien = await supervisionUrl(projectId);

  if (destinataires.length === 0 || !lien) {
    /**
     * PAS DE DESTINATAIRE OU PAS D'ADRESSE PUBLIQUE — un état, pas une erreur.
     *
     * On trace, et l'on MÉMORISE quand même l'ouverture : la chronologie et
     * l'écran de supervision, eux, portent déjà l'information. Ce qui manque
     * est le canal, pas le constat.
     */
    logger.warn(
      `[bridge-alert] ${projectId} dégradé, non notifié — `
      + `${destinataires.length === 0 ? 'aucun SUPER_ADMIN joignable' : 'aucune URL publique du Panel'}.`,
    );
    await memoriser(projectId, {
      ...alerte, since, state: 'DEGRADED', reasons: sante.reasons, healthySince: null,
    });
    return { evaluated: true, status: sante.status, notified: false, reason: 'NO_CHANNEL' };
  }

  const rappel = Number(alerte?.notifiedCount ?? 0);
  const variables = {
    'project.name': String(record.projectName ?? projectId),
    'project.id': String(projectId),
    'bridge.environment': String(record.runtime?.environment ?? config.env),
    'bridge.summary': resume,
    'bridge.pendingChanges': String(sante.detail.pendingChanges ?? 0),
    'bridge.backlogAgeMinutes': String(sante.detail.backlogAgeMinutes ?? 0),
    'bridge.since': since,
    'bridge.url': lien,
  };

  const resultats = [];
  for (const [index, recipient] of destinataires.entries()) {
    // eslint-disable-next-line no-await-in-loop
    resultats.push(await envoyer({
      templateRef: BRIDGE_DEGRADED_TEMPLATE,
      recipient,
      variables,
      operationId: bridgeAlertOperationId({
        projectId, since, index: rappel * 100 + index, kind: 'down',
      }),
    }));
  }

  await memoriser(projectId, {
    since,
    state: 'DEGRADED',
    reasons: sante.reasons,
    lastNotifiedAt: nowIso(),
    notifiedCount: rappel + 1,
    healthySince: null,
  });

  const envoyes = resultats.filter((r) => r.ok).length;
  logger.warn(
    `[bridge-alert] ${projectId} dégradé (${resume}) — ${envoyes}/${resultats.length} alerte(s) expédiée(s).`,
  );
  return { evaluated: true, status: CONSUMPTION_STATUS.DEGRADED, notified: envoyes > 0 };
}

/**
 * LE RETOUR À LA SANTÉ — une promesse d'abord, une annonce ensuite.
 *
 * ══ POURQUOI IL NE REFERME PLUS TOUT DE SUITE ═══════════════════════════════
 *
 * Parce qu'un battement isolé ne prouve rien. Deux runtimes du même projet qui
 * alternent, un cycle de tirage qui réussit entre deux échecs, une écriture qui
 * passe puis rebloque : dans les trois cas, le Panel voyait une réparation là
 * où il n'y avait qu'une respiration — et il l'annonçait, à chaque fois.
 *
 * L'état passe donc par `RECOVERING`, et il faut que la santé TIENNE
 * `RECOVERY_CONFIRMATION_MS` pour que le rétablissement soit écrit et expédié.
 * Tant qu'elle n'a pas tenu, l'alerte reste OUVERTE : c'est ce qui fait que la
 * dégradation suivante ne se réannonce pas non plus.
 */
async function refermer({ record, projectId, alerte, maintenant }) {
  /** Rien d'ouvert : il n'y a rien à refermer, et rien à annoncer. */
  if (!alerte?.since) {
    return { evaluated: true, status: CONSUMPTION_STATUS.HEALTHY, notified: false };
  }

  /**
   * PREMIER BATTEMENT SAIN — on note l'instant, et on attend.
   *
   * Aucun événement de chronologie n'est écrit ici : une chronologie qui
   * enregistrerait un rétablissement révoqué la minute suivante deviendrait
   * illisible, et c'est précisément là qu'on vient chercher QUAND une panne a
   * commencé et fini.
   */
  if (alerte.state !== 'RECOVERING') {
    await memoriser(projectId, { ...alerte, state: 'RECOVERING', healthySince: nowIso() });
    return {
      evaluated: true,
      status: CONSUMPTION_STATUS.HEALTHY,
      notified: false,
      reason: 'RECOVERY_PENDING',
    };
  }

  const depuis = alerte.healthySince ? new Date(alerte.healthySince).getTime() : 0;
  if (!depuis || maintenant - depuis < RECOVERY_CONFIRMATION_MS) {
    return {
      evaluated: true,
      status: CONSUMPTION_STATUS.HEALTHY,
      notified: false,
      reason: 'RECOVERY_PENDING',
    };
  }

  /* ── LA SANTÉ A TENU : on annonce, et on referme. ─────────────────────── */

  await recordEvent({
    projectId,
    type: EVENT_TYPES.PROJECT_BRIDGE_RECOVERED,
    source: 'PANEL',
    summary: 'Le pont consomme à nouveau les écritures du Panel.',
    data: {
      degradedSince: alerte.since,
      reasons: alerte.reasons ?? [],
      confirmedAfterMs: RECOVERY_CONFIRMATION_MS,
    },
  });

  /**
   * LE RÉTABLISSEMENT NE S'ANNONCE QUE SI L'ALERTE A ÉTÉ EXPÉDIÉE.
   *
   * Une dégradation ouverte pendant le refroidissement, résolue avant le
   * premier envoi, n'a jamais atteint personne : annoncer sa réparation
   * apprendrait une panne au moment où elle n'existe plus.
   */
  const notifie = Number(alerte.notifiedCount ?? 0) > 0;
  if (!notifie) {
    await memoriser(projectId, null);
    return { evaluated: true, status: CONSUMPTION_STATUS.HEALTHY, notified: false, reason: 'NEVER_ANNOUNCED' };
  }

  const destinataires = await resolvePanelSuperAdmins();
  const lien = await supervisionUrl(projectId);
  if (destinataires.length > 0 && lien) {
    const variables = {
      'project.name': String(record.projectName ?? projectId),
      'project.id': String(projectId),
      'bridge.environment': String(record.runtime?.environment ?? config.env),
      'bridge.degradedSince': alerte.since,
      'bridge.url': lien,
    };
    for (const [index, recipient] of destinataires.entries()) {
      // eslint-disable-next-line no-await-in-loop
      await envoyer({
        templateRef: BRIDGE_RECOVERED_TEMPLATE,
        recipient,
        variables,
        operationId: bridgeAlertOperationId({
          projectId, since: alerte.since, index, kind: 'up',
        }),
      });
    }
  }

  await memoriser(projectId, null);
  logger.info(`[bridge-alert] ${projectId} — le pont consomme à nouveau (confirmé).`);
  return { evaluated: true, status: CONSUMPTION_STATUS.HEALTHY, notified: true };
}

export default {
  ALERT_COOLDOWN_MS,
  RECOVERY_CONFIRMATION_MS,
  BRIDGE_DEGRADED_TEMPLATE,
  BRIDGE_RECOVERED_TEMPLATE,
  bridgeAlertOperationId,
  evaluateBridgeConsumption,
};
