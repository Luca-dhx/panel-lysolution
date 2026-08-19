/**
 * L'ÉTAT DE SERVICE DU BACKEND — « vivant » et « prêt » sont deux questions.
 *
 * ══ LE DÉFAUT QUE CE MODULE FERME ═══════════════════════════════════════════
 *
 * Le backend n'ouvrait son port qu'APRÈS la connexion Mongo, les migrations et
 * les reprises. Pendant toute cette fenêtre — plusieurs secondes, parfois
 * davantage — rien n'écoutait sur le port. Nginx répondait donc `502` avec sa
 * page HTML, que le navigateur ne sait pas lire : le frontend recevait une
 * erreur sans corps, sans code, indiscernable d'une panne définitive. C'est
 * cette indiscernabilité, et non la panne, qui déconnectait l'utilisateur.
 *
 * ══ CE QUI LE REMPLACE ══════════════════════════════════════════════════════
 *
 * Le port s'ouvre TOUT DE SUITE, et l'état de service devient une donnée
 * explicite :
 *
 *   STARTING   le process vit, les dépendances ne sont pas prêtes ;
 *   READY      les dépendances indispensables sont prêtes ;
 *   DRAINING   arrêt en cours, plus rien de nouveau n'est accepté.
 *
 * Les sondes (`/livez`, `/readyz`) répondent dès la première milliseconde ; les
 * routes métier, elles, REFUSENT proprement tant que l'état n'est pas READY —
 * `503` avec un code stable, jamais un `500`, jamais une socket fermée.
 *
 * ══ CE QUE CE MODULE NE FAIT PAS ════════════════════════════════════════════
 *
 * Aucune requête réseau, aucune lecture Mongo. L'état de la base est lu sur la
 * CONNEXION en cours (`readyState`), qui est une valeur en mémoire tenue à jour
 * par le pilote. Une sonde qui interrogerait la base deviendrait elle-même
 * indisponible quand la base l'est — exactement au moment où l'on a besoin
 * qu'elle réponde pour DIRE que la base est indisponible.
 */
import fs from 'node:fs';
import mongoose from 'mongoose';
import { workerPath } from '../deployment/deploymentWorker.service.js';

/** Les trois états de service. Il n'en existe pas d'autre. */
export const PHASES = Object.freeze({
  STARTING: 'STARTING',
  READY: 'READY',
  DRAINING: 'DRAINING',
});

let phase = PHASES.STARTING;
let readySince = null;
/** Ce qui a empêché le démarrage, s'il a échoué. Jamais une stack vers l'extérieur. */
let bootFailure = null;
/** Étape d'amorçage en cours — affichée à l'opérateur, pas au public. */
let bootStep = 'initialisation';

/**
 * Le worker de déploiement est un FICHIER : sa présence se vérifie une fois.
 *
 * Le relire à chaque sonde ferait un accès disque par battement de l'interface
 * de reconnexion, pour une réponse qui ne change pas sans redéploiement.
 */
let workerPresent = null;
function deploymentEngineReady() {
  if (workerPresent === null) {
    try {
      workerPresent = fs.existsSync(workerPath);
    } catch {
      workerPresent = false;
    }
  }
  return workerPresent;
}

/** Le process est-il vivant ? Toujours vrai s'il peut répondre — c'est le point. */
export function isAlive() {
  return true;
}

/**
 * La base est-elle utilisable MAINTENANT ?
 *
 * `readyState === 1` signifie « connectée ». Les états 0 (déconnectée),
 * 2 (en connexion) et 3 (en déconnexion) sont tous des états où une requête
 * partirait en tampon puis expirerait au bout de dix secondes. Refuser tout de
 * suite est plus honnête que faire attendre dix secondes pour refuser quand
 * même.
 */
export function isDatabaseReady() {
  return mongoose.connection.readyState === 1;
}

export function lifecyclePhase() {
  return phase;
}

/**
 * Prêt à servir une requête MÉTIER.
 *
 * L'amorçage doit être terminé ET la base joignable. Les deux conditions sont
 * nécessaires et aucune ne suffit : un backend amorcé dont la base est tombée
 * ensuite n'est plus prêt, et le dire évite de faire échouer l'utilisateur sur
 * une opération qui ne pouvait pas aboutir.
 */
export function isReady() {
  return phase === PHASES.READY && isDatabaseReady();
}

/** L'amorçage progresse — journalisé, et lisible depuis `/readyz`. */
export function markBootStep(step) {
  bootStep = String(step || '').trim() || bootStep;
}

export function markReady() {
  phase = PHASES.READY;
  readySince = new Date().toISOString();
  bootFailure = null;
  bootStep = 'terminé';
}

export function markDraining() {
  phase = PHASES.DRAINING;
}

export function markBootFailed(err) {
  bootFailure = String(err?.message ?? err ?? 'cause inconnue');
}

/** Remise à zéro — réservée aux tests, qui amorcent plusieurs fois un même process. */
export function resetReadiness() {
  phase = PHASES.STARTING;
  readySince = null;
  bootFailure = null;
  bootStep = 'initialisation';
  workerPresent = null;
}

/**
 * L'état DÉTAILLÉ, tel que `/readyz` et l'écran de déploiement le lisent.
 *
 * Aucun secret, aucune adresse d'infrastructure, aucun nom d'hôte de base : un
 * état de service se lit sans rien apprendre de la machine qui le sert.
 */
export function describeReadiness() {
  const database = isDatabaseReady();
  const deploymentEngine = deploymentEngineReady();
  const ready = isReady();
  return {
    ready,
    phase,
    readySince,
    bootStep: ready ? null : bootStep,
    // La cause d'un amorçage raté aide l'opérateur et ne dit rien d'exploitable
    // à un tiers : c'est un message applicatif, jamais une stack.
    bootFailure,
    checks: {
      backend: true,
      database,
      deploymentEngine,
    },
  };
}

/**
 * LE CODE MÉTIER qui explique un refus — stable, jamais une phrase à relire.
 *
 * ── L'ORDRE DES CAUSES EST UNE DÉCISION, PAS UNE COMMODITÉ ─────────────────
 *
 * La PHASE l'emporte sur l'état de la base, et c'est délibéré. Pendant
 * l'amorçage, la base n'est pas encore connectée : c'est l'état ATTENDU, pas un
 * incident. Nommer « base indisponible » à ce moment enverrait l'exploitant
 * vérifier une base qui va très bien, alors que la seule chose à faire est
 * d'attendre quelques secondes.
 *
 * Une base absente n'est une CAUSE qu'une fois le service amorcé : là, elle
 * décrit une vraie panne, et c'est elle qu'il faut nommer.
 */
export function unavailabilityReason() {
  if (isReady()) return null;
  if (phase === PHASES.DRAINING) {
    return {
      code: 'PANEL_SERVICE_STOPPING',
      message: 'Le service s’arrête. Votre session reste valide — réessayez dans quelques instants.',
    };
  }
  if (phase === PHASES.STARTING) {
    return {
      code: 'PANEL_SERVICE_STARTING',
      message: 'Le service démarre et n’est pas encore prêt à traiter cette demande. '
        + 'Votre session reste valide — réessayez dans quelques instants.',
    };
  }
  return {
    code: 'PANEL_DATABASE_UNAVAILABLE',
    message: 'Le service est momentanément indisponible : la base de données n’est pas '
      + 'joignable. Votre session reste valide — réessayez dans quelques instants.',
  };
}

export default {
  PHASES,
  describeReadiness,
  isAlive,
  isDatabaseReady,
  isReady,
  lifecyclePhase,
  markBootFailed,
  markBootStep,
  markDraining,
  markReady,
  resetReadiness,
  unavailabilityReason,
};
