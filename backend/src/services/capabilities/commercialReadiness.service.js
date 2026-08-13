// OUVERTURE COMMERCIALE — le geste qui manquait (lot L3.1).
//
// docs/architecture/INTEGRATED_API_CONTROL_PLANE_ROADMAP.md — L1.75 puis L3.
//
// ── CE QUE CE SERVICE FERME ─────────────────────────────────────────────────
//
// L1.75 a défini la doctrine, L3 a branché la passerelle dessus. Mais personne
// n'écrivait jamais l'état : le champ existait, la passerelle le lisait, et il
// valait éternellement `null` — donc `PREOPENING`, donc refus. Une porte fermée
// dont on n'avait pas fabriqué la clé.
//
// ── QUI EST L'AUTORITÉ, ET POURQUOI CE N'EST PAS L'INSTANCE ─────────────────
//
// La note de cadrage de L1.75 annonçait l'inverse : « stocké côté instance,
// projeté vers le Panel ». Son argument était l'autonomie — que l'application
// survive à une panne du Panel.
//
// Cet argument ne tient plus depuis L3, et il faut le dire précisément :
//
//  1. L'ENFORCEMENT A CHANGÉ DE CAMP. La passerelle de capacités vit dans le
//     Panel. Si le Panel est indisponible, la capacité n'est pas exécutée du
//     tout : il n'y a rien à faire respecter localement.
//
//  2. ET SURTOUT : un projet ne doit pas pouvoir DÉCLARER son propre droit de
//     dépenser. Si l'état vivait dans l'instance et remontait par projection,
//     le Panel arbitrerait sur une valeur envoyée par le projet — exactement la
//     classe de chose que la doctrine d'environnement interdit depuis L2
//     (« jamais un paramètre venu du projet »). Un projet compromis, ou
//     simplement mal déployé, s'ouvrirait lui-même.
//
// L'autorité est donc le PANEL, et l'instance l'observe. C'est une correction
// assumée de la note de L1.75, pas un oubli.
//
// ── CE QUE CE SERVICE N'EST PAS ─────────────────────────────────────────────
//
// Il ne choisit AUCUN environnement fournisseur. Sa signature ne contient ni
// `TEST`, ni `PROD`, ni `credential` — et un test le vérifie. L'ouverture
// commerciale répond à « l'action réelle est-elle autorisée ? », jamais à
// « quel monde ? ».
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import { registryStore } from '../registry/registryStore.js';
import { getProjectOrThrow } from '../registry/projectRegistry.service.js';
import { recordEvent, EVENT_TYPES } from '../supervision/timeline.service.js';
import {
  COMMERCIAL_STATE,
  COMMERCIAL_STATE_VALUES,
  DEFAULT_COMMERCIAL_STATE,
  capabilitiesBlockedInPreopening,
} from '../integratedApi/commercialReadiness.js';

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * L'état EFFECTIF d'une fiche.
 *
 * `null` en base se lit « jamais décidée » et se résout vers le défaut fermé.
 * On distingue les deux dans la vue : « personne n'a tranché » et « quelqu'un a
 * choisi la pré-ouverture » se réparent différemment.
 */
export function effectiveCommercialState(record) {
  const stored = record?.commercialState ?? null;
  return COMMERCIAL_STATE_VALUES.includes(stored) ? stored : DEFAULT_COMMERCIAL_STATE;
}

/* -------------------------------------------------------------------------- */
/*  PRÉREQUIS                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * LES CONTRÔLES AVANT OUVERTURE — et il y en a TROIS.
 *
 * ── POURQUOI SI PEU ─────────────────────────────────────────────────────────
 *
 * L'état n'est pas une liste de courses. Chaque contrôle ajouté ici devient une
 * raison de plus de ne pas pouvoir ouvrir, et la vingtième bloque un jour une
 * ouverture légitime pour un motif que personne ne comprend — après quoi on
 * ajoute une dérogation, et le contrôle ne veut plus rien dire.
 *
 * On ne garde donc que ce qui rendrait l'ouverture ABSURDE :
 *
 *   · une fiche non appairée n'a aucune instance à ouvrir ;
 *   · une instance dont on ignore l'environnement ne peut pas être qualifiée ;
 *   · une instance sans destination active n'est joignable par personne.
 *
 * Tout le reste — un fournisseur mal configuré, un contrat absent — se
 * manifeste au moment de l'action, avec un message précis, par la passerelle.
 * L'anticiper ici dirait « impossible d'ouvrir » là où la vérité est
 * « ouvrable, mais Stripe n'est pas prêt ».
 */
export function describeReadinessChecks(record) {
  const environment = record?.runtime?.environment ?? null;
  const paired = record?.pairing?.status === 'PAIRED';
  const destination = record?.activeNetwork?.backend ?? null;

  const checks = [
    {
      code: 'PAIRED',
      label: 'L’instance est appairée',
      passed: paired,
      detail: paired ? null : 'Aucune instance n’est appairée à cette fiche : il n’y a rien à ouvrir.',
    },
    {
      code: 'ENVIRONMENT_KNOWN',
      label: 'Son environnement est connu',
      passed: Boolean(environment),
      detail: environment ? null : 'L’instance n’a pas encore déclaré son environnement.',
    },
    {
      code: 'REACHABLE_DESTINATION',
      label: 'Elle a une destination active',
      passed: Boolean(destination),
      detail: destination ? null : 'Aucune destination active : l’instance n’est joignable par personne.',
    },
  ];

  return { checks, readyToGoLive: checks.every((c) => c.passed) };
}

/**
 * Vue complète — état, contrôles, et ce que la pré-ouverture interdit.
 *
 * `blockedCapabilities` n'est pas décoratif : c'est la seule façon pour un
 * opérateur de savoir CE QUE l'ouverture changerait, avant de la décider.
 */
export function describeCommercialReadiness(record) {
  const { checks, readyToGoLive } = describeReadinessChecks(record);
  const state = effectiveCommercialState(record);
  return {
    projectId: record?.projectId ?? null,
    projectName: record?.projectName ?? null,
    /** L'environnement TECHNIQUE — affiché à côté, jamais fusionné. */
    environment: record?.runtime?.environment ?? null,
    state,
    /** `true` quand personne n'a jamais tranché : le défaut fermé s'applique. */
    neverDecided: (record?.commercialState ?? null) === null,
    decidedAt: record?.commercialStateUpdatedAt ?? null,
    decidedBy: record?.commercialStateUpdatedBy ?? null,
    decisionReason: record?.commercialStateReason ?? null,
    checks,
    readyToGoLive,
    blockedInPreopening: capabilitiesBlockedInPreopening(),
  };
}

/* -------------------------------------------------------------------------- */
/*  ÉCRITURE                                                                  */
/* -------------------------------------------------------------------------- */

/** Les seules transitions qui existent. Aucune n'est automatique. */
const ALLOWED_TRANSITIONS = Object.freeze({
  [COMMERCIAL_STATE.PREOPENING]: [COMMERCIAL_STATE.LIVE],
  [COMMERCIAL_STATE.LIVE]: [COMMERCIAL_STATE.PREOPENING],
});

/**
 * Change l'ouverture commerciale d'une instance.
 *
 * ── AUCUNE TRANSITION AUTOMATIQUE ───────────────────────────────────────────
 *
 * Rien dans le système ne doit ouvrir une instance tout seul : ni un contrat
 * signé, ni un déploiement réussi, ni un fournisseur validé. Une ouverture est
 * une décision commerciale, prise par quelqu'un, qui en répond — d'où l'acteur
 * obligatoire et la trace.
 *
 * ── LES CONTRÔLES NE GARDENT QUE L'OUVERTURE ────────────────────────────────
 *
 * Refermer (LIVE → PREOPENING) n'exige RIEN. C'est un frein d'urgence : exiger
 * qu'une instance soit en bonne santé pour cesser de facturer serait
 * exactement le mauvais sens.
 *
 * @param {string} projectId
 * @param {'PREOPENING'|'LIVE'} nextState
 * @param {{actor?: object, reason?: string}} [options]
 */
export async function setCommercialReadiness(projectId, nextState, { actor = {}, reason = null } = {}) {
  if (!COMMERCIAL_STATE_VALUES.includes(nextState)) {
    throw ApiError.badRequest(
      'PANEL_COMMERCIAL_STATE_INVALID',
      `Ouverture refusée : « ${nextState} » n’est pas un état d’ouverture (PREOPENING ou LIVE).`,
    );
  }

  const record = await getProjectOrThrow(projectId);
  const previous = effectiveCommercialState(record);
  /**
   * L'état STOCKÉ, distinct de l'état EFFECTIF ci-dessus.
   *
   * `null` (« jamais décidé ») se résout vers `PREOPENING` pour la politique,
   * mais reste `null` en base. C'est cette valeur-là — celle qu'on a
   * réellement lue — que l'écriture conditionnelle devra retrouver.
   */
  const storedBefore = record?.commercialState ?? null;

  if (previous === nextState) {
    /**
     * Idempotent : réaffirmer un état n'est pas une erreur, et ne produit
     * aucune trace — une chronologie remplie de « toujours ouvert » se lit
     * moins bien qu'une chronologie qui ne montre que les changements.
     *
     * On RELIT quand même avant de répondre. `record` date de quelques
     * instructions plus haut ; si un autre geste a basculé la fiche entre
     * temps, rendre l'instantané périmé annoncerait un état que l'appelant ne
     * retrouverait pas en rechargeant. La relecture ne supprime pas la course
     * — rien ne le peut — mais elle rend la réponse aussi fraîche que celle du
     * chemin qui écrit, qui relit lui aussi avant de rendre.
     */
    return describeCommercialReadiness(await getProjectOrThrow(projectId));
  }

  if (!(ALLOWED_TRANSITIONS[previous] ?? []).includes(nextState)) {
    throw ApiError.conflict(
      'PANEL_COMMERCIAL_STATE_TRANSITION_INVALID',
      `Transition refusée : ${previous} → ${nextState} n’existe pas.`,
    );
  }

  if (nextState === COMMERCIAL_STATE.LIVE) {
    const { checks, readyToGoLive } = describeReadinessChecks(record);
    if (!readyToGoLive) {
      const manquants = checks.filter((c) => !c.passed);
      throw ApiError.conflict(
        'PANEL_COMMERCIAL_READINESS_INCOMPLETE',
        `Ouverture refusée : ${manquants.map((c) => c.detail ?? c.label).join(' ')}`,
        { checks: manquants.map((c) => ({ code: c.code, label: c.label })) },
      );
    }
  }

  const at = nowIso();
  /**
   * ── LE GESTE EST RÉCLAMÉ, PAS SEULEMENT ÉCRIT ─────────────────────────────
   *
   * Tout ce qui précède — lecture, transition, prérequis — a été décidé sur un
   * instantané. Deux requêtes simultanées le franchissent toutes les deux :
   * deux clics sur le bouton, deux onglets ouverts, un rejeu de la requête.
   *
   * L'écriture conditionnelle départage. Une seule retrouve l'état qu'elle
   * avait lu ; les autres n'écrivent rien, et surtout n'émettent PAS un second
   * `COMMERCIAL_OPENED`. Une chronologie qui montre deux ouvertures pour un
   * seul geste ferait chercher un incident qui n'a pas eu lieu — et rendrait
   * indécidable la question « combien de fois cette instance a-t-elle été
   * ouverte ? », qui est précisément celle qu'on vient y lire.
   */
  const claimed = await registryStore.setCommercialState(projectId, {
    state: nextState,
    at,
    by: actor.userId ?? null,
    reason: reason ? String(reason).slice(0, 500) : null,
    expected: storedBefore,
  });

  if (!claimed) {
    /**
     * Quelqu'un d'autre a bougé l'état entre notre lecture et notre écriture.
     *
     * S'il a visé le MÊME état, il n'y a pas de conflit : les deux voulaient la
     * même chose, l'une d'elles l'a fait, et nous rendons le résultat commun
     * sans rien réécrire ni rien journaliser. C'est ce qui rend le double clic
     * inoffensif.
     *
     * S'il a visé l'état INVERSE, refuser est la seule réponse honnête : rendre
     * « ouvert » à qui vient de fermer — ou l'inverse — ferait afficher un état
     * que personne ne retrouverait en rechargeant.
     */
    const actuel = await getProjectOrThrow(projectId);
    if (effectiveCommercialState(actuel) === nextState) {
      return describeCommercialReadiness(actuel);
    }
    throw ApiError.conflict(
      'PANEL_COMMERCIAL_STATE_CONCURRENT_CHANGE',
      'Changement refusé : l’ouverture commerciale a été modifiée pendant cette décision. '
      + 'Rechargez l’écran pour lire l’état courant.',
    );
  }

  const ouverture = nextState === COMMERCIAL_STATE.LIVE;
  logger.info(
    `[commercial-readiness] ${record.projectName} (${record.runtime?.environment ?? 'env. inconnu'}) : `
    + `${previous} → ${nextState}${actor.userEmail ? ` par ${actor.userEmail}` : ''}.`,
  );

  await recordEvent({
    projectId,
    type: ouverture ? EVENT_TYPES.COMMERCIAL_OPENED : EVENT_TYPES.COMMERCIAL_CLOSED,
    source: 'PANEL',
    severity: ouverture ? 'WARNING' : 'INFO',
    summary: ouverture
      ? `Ouverture commerciale : les opérations réelles autorisées deviennent possibles.`
      : `Retour en pré-ouverture : les opérations financières et de signature sont de nouveau refusées.`,
    data: {
      previous,
      next: nextState,
      // L'environnement est RAPPELÉ, jamais modifié : c'est précisément ce que
      // l'ouverture ne touche pas.
      environment: record.runtime?.environment ?? null,
      actor: actor.userId ?? null,
      reason: reason ? String(reason).slice(0, 500) : null,
      at,
    },
  }).catch(() => {});

  return describeCommercialReadiness(await getProjectOrThrow(projectId));
}

export default {
  effectiveCommercialState,
  describeReadinessChecks,
  describeCommercialReadiness,
  setCommercialReadiness,
};
