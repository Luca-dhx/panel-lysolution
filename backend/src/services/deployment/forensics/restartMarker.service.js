/**
 * MARQUEUR DE REPRISE — un redémarrage ATTENDU n'est pas un incident.
 *
 * ══ LE CAS QU'IL TRAITE ═════════════════════════════════════════════════════
 *
 * Le backend déploie parfois SA PROPRE application. À l'étape `pm2`, il
 * redémarre donc le processus qui est en train d'exécuter le déploiement : la
 * requête HTTP se coupe, le flux s'arrête, et le run reste « en cours ».
 *
 * Vu de la reprise au démarrage, c'est indiscernable d'un plantage — et le run
 * était alors classé `interrupted`, alors qu'il s'agissait du fonctionnement
 * NORMAL d'un auto-déploiement. L'écran, lui, affichait une erreur serveur
 * générique pour une coupure parfaitement prévue.
 *
 * Le marqueur transforme cette coupure en fait déclaré : « je vais redémarrer,
 * voici ce que je faisais ». Au boot suivant, on le lit AVANT de conclure quoi
 * que ce soit.
 *
 * ══ POURQUOI EN BASE, ET PAS EN MÉMOIRE NI DANS UN FICHIER ══════════════════
 *
 * En mémoire : elle disparaît avec le process — c'est précisément ce qu'on
 * cherche à traverser. Dans un fichier : le nouveau process peut tourner
 * ailleurs (release différente, conteneur neuf) et ne le trouverait pas. La
 * base est le seul endroit que les deux processus partagent avec certitude.
 */
import mongoose from 'mongoose';

import { EVENTS, LEVELS, SOURCES, journal } from './runJournal.service.js';

const markerSchema = new mongoose.Schema(
  {
    /** Un seul marqueur vivant à la fois : la clé est constante. */
    key: { type: String, default: 'SINGLETON', unique: true },
    run: { type: String, required: true },
    target: { type: String, default: null },
    operation: { type: String, default: 'DEPLOYMENT' },
    /** L'étape que le process AURAIT dû exécuter ensuite. */
    nextExpectedStep: { type: String, default: null },
    expectedProcessName: { type: String, default: null },
    expectedPort: { type: Number, default: null },
    /**
     * LES DEUX IDENTITÉS, NOMMÉES SÉPARÉMENT.
     *
     * ── LE DÉFAUT CORRIGÉ ─────────────────────────────────────────────────
     * Un champ unique `pidBefore` portait « le PID d'avant » sans dire lequel.
     * Le marqueur étant écrit par le WORKER et relu par l'API, la comparaison
     * opposait deux processus qui sont différents par construction : elle
     * concluait donc à un redémarrage à chaque démarrage, qu'il y en ait eu un
     * ou non. Un champ ambigu ne se corrige pas en le réinterprétant ; on
     * nomme ce qu'on mesure.
     *
     * `apiPidBeforeRestart` est le processus qui doit MOURIR pour qu'un
     * redémarrage soit avéré. `workerPid` est celui qui doit SURVIVRE pour que
     * le déploiement se poursuive. Ce sont deux questions distinctes, et elles
     * appellent deux réponses distinctes.
     */
    apiPidBeforeRestart: { type: Number, default: null },
    workerPid: { type: Number, default: null },
    writtenAt: { type: Date, required: true },
  },
  { versionKey: false },
);

const RestartMarker = mongoose.models.PanelDeploymentRestartMarker
  ?? mongoose.model('PanelDeploymentRestartMarker', markerSchema);

/**
 * DÉCLARE un redémarrage volontaire, AVANT de le déclencher.
 *
 * L'ordre n'est pas négociable : la ligne qui suit l'appel peut être la
 * dernière que ce process exécute. Tout ce qui doit survivre s'écrit d'abord.
 */
export async function ecrireMarqueurReprise({
  runId, targetId = null, operation = 'DEPLOYMENT',
  nextExpectedStep = null, expectedProcessName = null, expectedPort = null,
  apiPid = null, workerPid = process.pid,
}) {
  try {
    await RestartMarker.findOneAndUpdate(
      { key: 'SINGLETON' },
      {
        $set: {
          run: runId,
          target: targetId,
          operation,
          nextExpectedStep,
          expectedProcessName,
          expectedPort,
          // Le PID de l'API est fourni par l'appelant : le worker ne peut pas
          // le deviner, et le lui faire déduire de son propre PID est
          // exactement l'erreur qu'on répare.
          apiPidBeforeRestart: apiPid ?? null,
          workerPid: workerPid ?? null,
          writtenAt: new Date(),
        },
      },
      { upsert: true },
    );
    return true;
  } catch {
    // Un marqueur non écrit dégrade le diagnostic ; il ne doit pas empêcher le
    // déploiement de se poursuivre.
    return false;
  }
}

/** Le marqueur vivant, s'il y en a un. */
export async function lireMarqueurReprise() {
  try {
    return await RestartMarker.findOne({ key: 'SINGLETON' }).lean();
  } catch {
    return null;
  }
}

/** Efface le marqueur — UNIQUEMENT après constat de reprise. */
export async function effacerMarqueurReprise(runId = null) {
  try {
    const filtre = runId ? { key: 'SINGLETON', run: runId } : { key: 'SINGLETON' };
    await RestartMarker.deleteOne(filtre);
    return true;
  } catch {
    return false;
  }
}

/**
 * CONSOMME le marqueur au démarrage — avant toute reprise générique.
 *
 * ── POURQUOI CET ORDRE ──────────────────────────────────────────────────────
 * `recoverOrphanRuns()` classe tout run « en cours » comme interrompu. Appelé
 * en premier, il aurait qualifié d'incident un redémarrage parfaitement
 * attendu. On lit donc le marqueur d'abord, on qualifie ce run-là, et la
 * reprise générique ne traite ensuite que ce qui reste vraiment inexpliqué.
 *
 * Le marqueur n'est effacé qu'après avoir été CONSTATÉ : s'il ne correspond ni
 * au service ni à la destination courante, on le garde et on le signale plutôt
 * que d'effacer une trace qu'on n'a pas comprise.
 *
 * @returns {Promise<{consumed:boolean, runId?:string, reason?:string}>}
 */
/** Le processus `pid` existe-t-il encore ? Question posée au système, jamais devinée. */
function processVivant(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM : il existe, mais appartient à quelqu'un d'autre.
    return err.code === 'EPERM';
  }
}

/**
 * Au-delà de cette ancienneté, un marqueur ne prouve plus rien.
 *
 * Les PID sont réutilisés par le système. Comparer un PID vieux de plusieurs
 * heures à un PID actuel peut donc faire coïncider deux processus étrangers.
 * Passé ce délai, on refuse de conclure plutôt que de risquer une reprise
 * fondée sur une homonymie.
 */
export const MARQUEUR_PEREMPTION_MS = 6 * 60 * 60 * 1000;

/**
 * CONSOMME le marqueur au démarrage — avant toute reprise générique.
 *
 * ── LES DEUX QUESTIONS, POSÉES SÉPARÉMENT ───────────────────────────────────
 *   1. l'API a-t-elle réellement redémarré ?  → `apiPidBeforeRestart` a disparu
 *      et diffère du nôtre ;
 *   2. le worker a-t-il survécu ?             → `workerPid` existe encore.
 *
 * Elles ne se déduisent pas l'une de l'autre. Une API redémarrée avec un worker
 * mort est un cas réel, et il ne doit surtout pas produire une annonce de
 * reprise — le déploiement, lui, s'est bel et bien arrêté.
 *
 * Rien n'est effacé sans avoir été CONSTATÉ : un marqueur qu'on ne comprend pas
 * est conservé et signalé, jamais supprimé pour faire place nette.
 *
 * @returns {Promise<{consumed:boolean, runId?:string, reason?:string,
 *                    apiRestarted?:boolean, workerAlive?:boolean,
 *                    nextExpectedStep?:string|null}>}
 */
export async function consommerMarqueurReprise() {
  const marqueur = await lireMarqueurReprise();
  if (!marqueur) return { consumed: false, reason: 'AUCUN_MARQUEUR' };

  const commun = { runId: marqueur.run, nextExpectedStep: marqueur.nextExpectedStep ?? null };

  /* — Un marqueur trop vieux ne prouve plus rien : les PID se recyclent. — */
  const age = Date.now() - new Date(marqueur.writtenAt).getTime();
  if (age > MARQUEUR_PEREMPTION_MS) {
    await effacerMarqueurReprise(marqueur.run);
    return { ...commun, consumed: false, reason: 'MARQUEUR_PERIME' };
  }

  /* — Marqueur d'une version antérieure : l'identité de l'API manque. — */
  if (!Number.isInteger(marqueur.apiPidBeforeRestart)) {
    await effacerMarqueurReprise(marqueur.run);
    return { ...commun, consumed: false, reason: 'MARQUEUR_INCOMPLET' };
  }

  /* — L'API n'a pas changé : aucun redémarrage n'a eu lieu. — */
  if (marqueur.apiPidBeforeRestart === process.pid) {
    return { ...commun, consumed: false, reason: 'PROCESS_INCHANGE', apiRestarted: false };
  }

  /* — L'ancienne API tourne toujours : ce démarrage n'est pas SON successeur. — */
  if (processVivant(marqueur.apiPidBeforeRestart)) {
    return { ...commun, consumed: false, reason: 'API_TOUJOURS_VIVANTE', apiRestarted: false };
  }

  /* — Le run est déjà conclu : on ne ressuscite rien, on nettoie. — */
  const { default: PanelDeploymentRun } = await import('../../../models/PanelDeploymentRun.model.js');
  const run = await PanelDeploymentRun.findOne({ runId: marqueur.run }).select('status').lean();
  if (!run || run.status !== 'running') {
    await effacerMarqueurReprise(marqueur.run);
    return { ...commun, consumed: false, reason: 'RUN_DEJA_CLOS', apiRestarted: true };
  }

  const workerAlive = processVivant(marqueur.workerPid);

  await journal(marqueur.run, {
    source: SOURCES.SYSTEM,
    level: LEVELS.INFO,
    eventCode: EVENTS.APPLICATION_RESTART_COMPLETED,
    stepId: marqueur.nextExpectedStep,
    processName: marqueur.expectedProcessName,
    port: marqueur.expectedPort,
    pid: process.pid,
    message: 'Le service a redémarré comme prévu : ce n’était pas une panne. '
      + `Ancienne API pid ${marqueur.apiPidBeforeRestart}, nouvelle pid ${process.pid}. `
      + (workerAlive
        ? `Le worker (pid ${marqueur.workerPid}) a survécu : le déploiement se poursuit.`
        : `Le worker (pid ${marqueur.workerPid}) n’a pas survécu : le déploiement s’est arrêté là.`),
    details: {
      operation: marqueur.operation,
      nextExpectedStep: marqueur.nextExpectedStep,
      expectedProcessName: marqueur.expectedProcessName,
      expectedPort: marqueur.expectedPort,
      apiPidBefore: marqueur.apiPidBeforeRestart,
      apiPidAfter: process.pid,
      workerPid: marqueur.workerPid,
      workerAlive,
      downtimeMs: Date.now() - new Date(marqueur.writtenAt).getTime(),
    },
  });

  await effacerMarqueurReprise(marqueur.run);
  return {
    ...commun,
    consumed: true,
    apiRestarted: true,
    /* La reprise n'est annoncée que si quelqu'un est encore là pour reprendre. */
    workerAlive,
  };
}

export default {
  ecrireMarqueurReprise, lireMarqueurReprise, effacerMarqueurReprise, consommerMarqueurReprise,
};
